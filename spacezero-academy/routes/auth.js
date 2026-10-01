'use strict';

const express = require('express');
const router = express.Router();

const { prisma } = require('../lib/prisma');
const { hashPassword, verifyPassword, passwordPolicyErrors } = require('../lib/password');
const { createSession, destroySession } = require('../lib/session');
const { hashToken } = require('../lib/tokens');
const { isRateLimited, recordAttempt, LOGIN_RATE_LIMIT, FORGOT_PASSWORD_RATE_LIMIT } = require('../lib/rateLimit');
const { logAudit } = require('../lib/audit');
const { LoginSchema, ForgotPasswordSchema, SetPasswordSchema } = require('../lib/validation');
const { consumeAccountToken } = require('../lib/consumeAccountToken');
const { sendReset } = require('../lib/accountEmail');

function clientMeta(req) {
  return { ip: req.ip, userAgent: req.get('user-agent') };
}

const VALID_COMPANY_CODES = new Set(['above9', 'space0']);

router.get('/login', (req, res) => {
  if (req.profile) return res.redirect('/dashboard');
  res.render('auth/login', { layout: false, error: null, reset: req.query.reset === '1', next: req.query.next || '' });
});

router.post('/login', async (req, res) => {
  const parsed = LoginSchema.safeParse({ identifier: req.body.identifier, password: req.body.password });
  if (!parsed.success) {
    return res.render('auth/login', { layout: false, error: 'Please fill in all fields.', reset: false, next: '' });
  }
  const companyCode = String(req.body.companyCode || '').trim().toLowerCase();
  if (!VALID_COMPANY_CODES.has(companyCode)) {
    return res.render('auth/login', { layout: false, error: 'Invalid company code.', reset: false, next: '' });
  }
  const { identifier, password } = parsed.data;
  const { ip, userAgent } = clientMeta(req);
  const bucketKey = `login:${identifier.toLowerCase()}:${ip || 'unknown'}`;

  if (await isRateLimited(bucketKey, LOGIN_RATE_LIMIT)) {
    return res.render('auth/login', {
      layout: false,
      error: 'Too many attempts. Please try again in 15 minutes.',
      reset: false,
      next: '',
    });
  }

  const profile = await prisma.profile.findFirst({
    where: { OR: [{ email: identifier.toLowerCase() }, { username: identifier.toLowerCase() }] },
  });

  const fail = (msg) => {
    return recordAttempt(bucketKey, false).then(() =>
      res.render('auth/login', { layout: false, error: msg, reset: false, next: '' })
    );
  };

  if (!profile || !profile.passwordHash) return fail('Invalid username/email or password.');

  const valid = await verifyPassword(password, profile.passwordHash);
  if (!valid) return fail('Invalid username/email or password.');

  if (profile.status === 'INVITED') {
    return fail("Your account hasn't been activated yet. Use the invitation link sent by your administrator.");
  }
  if (profile.status === 'DISABLED' || profile.status === 'ARCHIVED') {
    return fail('Your account is not active. Please contact your administrator.');
  }

  await recordAttempt(bucketKey, true);
  await createSession(res, profile.id, { ipAddress: ip, userAgent });
  await logAudit({ organizationId: profile.organizationId, actorId: profile.id, action: 'auth.login' });

  res.redirect(require('../lib/requestSecurity').safeRedirect(req.body.next));
});

router.post('/logout', async (req, res) => {
  await destroySession(req, res);
  res.redirect('/login');
});

router.get('/forgot-password', (req, res) => {
  res.render('auth/forgot-password', { layout: false, error: null, sent: false, devResetLink: null });
});

router.post('/forgot-password', async (req, res) => {
  const parsed = ForgotPasswordSchema.safeParse({ email: req.body.email });
  if (!parsed.success) {
    return res.render('auth/forgot-password', {
      layout: false,
      error: 'Enter a valid email address.',
      sent: false,
      devResetLink: null,
    });
  }
  const email = parsed.data.email.toLowerCase();
  const bucketKey = `forgot:${email}:${req.ip || 'unknown'}`;

  if (await isRateLimited(bucketKey, FORGOT_PASSWORD_RATE_LIMIT)) {
    return res.render('auth/forgot-password', {
      layout: false,
      error: 'Too many attempts. Please try again later.',
      sent: false,
      devResetLink: null,
    });
  }
  await recordAttempt(bucketKey, true);

  const profile = await prisma.profile.findUnique({ where: { email } });

  // Always respond the same way whether or not the account exists, so the
  // form itself never confirms an email is registered.
  if (!profile || profile.status !== 'ACTIVE') {
    return res.render('auth/forgot-password', { layout: false, error: null, sent: true, devResetLink: null });
  }

  await logAudit({
    organizationId: profile.organizationId,
    actorId: profile.id,
    action: 'auth.password_reset_requested',
  });

  try { await sendReset(profile); } catch { /* Failure is audited without exposing account existence. */ }
  res.render('auth/forgot-password', { layout: false, error: null, sent: true, devResetLink: null });
});

router.get('/reset-password/:token', (req, res) => {
  res.render('auth/set-password', {
    layout: false,
    mode: 'reset',
    token: req.params.token,
    heading: 'Set a new password',
    subtitle: 'Create a new password for your account.',
    submitLabel: 'Save password',
    error: null,
    fieldErrors: {},
  });
});

router.post('/reset-password/:token', async (req, res) => {
  const parsed = SetPasswordSchema.safeParse({
    password: req.body.password,
    confirmPassword: req.body.confirmPassword,
  });
  const rerender = (error, fieldErrors) =>
    res.render('auth/set-password', {
      layout: false,
      mode: 'reset',
      token: req.params.token,
      heading: 'Set a new password',
      subtitle: 'Create a new password for your account.',
      submitLabel: 'Save password',
      error: error || null,
      fieldErrors: fieldErrors || {},
    });

  if (!parsed.success) return rerender(null, parsed.error.flatten().fieldErrors);
  const extraErrors = passwordPolicyErrors(parsed.data.password);
  if (extraErrors.length) return rerender(extraErrors.join(' '));

  const account = await consumeAccountToken(req.params.token, await hashPassword(parsed.data.password), false);
  if (!account) return rerender('This link is invalid or has expired. Please request a new one.');
  res.redirect('/login?reset=1');
});

router.get('/accept-invite/:token', async (req, res) => {
  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: hashToken(req.params.token) },
    include: { profile: true },
  });
  const isValid = invitation && invitation.profile.status === 'INVITED' && invitation.status === 'PENDING' && invitation.expiresAt > new Date();

  if (!isValid) {
    return res.render('auth/invite-invalid', { layout: false });
  }

  res.render('auth/set-password', {
    layout: false,
    mode: 'invite',
    token: req.params.token,
    heading: `Welcome, ${invitation.profile.fullName.split(' ')[0]}`,
    subtitle: 'Set a password to activate your SpaceZero Workspace account.',
    submitLabel: 'Activate account',
    error: null,
    fieldErrors: {},
  });
});

router.post('/accept-invite/:token', async (req, res) => {
  const parsed = SetPasswordSchema.safeParse({
    password: req.body.password,
    confirmPassword: req.body.confirmPassword,
  });
  const rerender = (error, fieldErrors) =>
    res.render('auth/set-password', {
      layout: false,
      mode: 'invite',
      token: req.params.token,
      heading: 'Activate your account',
      subtitle: 'Set a password to activate your SpaceZero Workspace account.',
      submitLabel: 'Activate account',
      error: error || null,
      fieldErrors: fieldErrors || {},
    });

  if (!parsed.success) return rerender(null, parsed.error.flatten().fieldErrors);
  const extraErrors = passwordPolicyErrors(parsed.data.password);
  if (extraErrors.length) return rerender(extraErrors.join(' '));

  const account = await consumeAccountToken(req.params.token, await hashPassword(parsed.data.password), true);
  if (!account) return res.status(400).render('auth/invite-invalid', { layout: false });
  const { ip, userAgent } = clientMeta(req);
  await createSession(res, account.id, { ipAddress: ip, userAgent });
  res.redirect('/dashboard');
});

module.exports = router;
