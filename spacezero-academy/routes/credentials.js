'use strict';

// Secure Credential Vault (spec sections 21-25). Secrets live only inside Credential.payloadEnc
// (AES-256-GCM, key outside the database). Lists and profile pages show metadata only; revealing a
// secret needs the actor's own password again, is rate limited, and is audited WITHOUT the secret.
const router = require('express').Router();
const { prisma } = require('../lib/prisma');
const { requireSession } = require('../lib/authMiddleware');
const { loadEmployeeFor, credentialAccess } = require('../lib/employeeAccess');
const { encryptJson, decryptJson } = require('../lib/credentialCrypto');
const { verifyPassword } = require('../lib/password');
const { isRateLimited, recordAttempt } = require('../lib/rateLimit');
const { logAudit } = require('../lib/audit');
const { ensureDefaultRequirements } = require('../lib/employeeSetup');
const { employeeTabs } = require('../lib/employeeTabs');
const { roleLabel } = require('../lib/roles');

const REVEAL_LIMIT = { maxAttempts: 10, windowMs: 15 * 60 * 1000 };
const aadFor = (credential) => `cred:${credential.organizationId}:${credential.ownerId}`;
const forbidden = (res) => res.status(403).render('forbidden');
const notFound = (res) => res.status(404).render('not-found', { layout: false });
const clip = (value, max) => String(value || '').trim().slice(0, max);

async function pageContext(req, ctx, extra = {}) {
  const actor = req.profile;
  const access = await credentialAccess(actor, ctx.employee, { impersonating: Boolean(req.impersonation) });
  if (!access.view && !access.manage) return null;
  await ensureDefaultRequirements(actor.organizationId);
  const [credentials, systems, grants, otherAdmins] = await Promise.all([
    prisma.credential.findMany({ where: { ownerId: ctx.employee.id }, orderBy: { system: 'asc' }, select: { id: true, system: true, systemKey: true, createdAt: true, updatedAt: true } }),
    prisma.setupRequirement.findMany({ where: { organizationId: actor.organizationId, credentialSystem: true, archivedAt: null }, orderBy: { displayOrder: 'asc' } }),
    ctx.employee.role === 'ADMIN' && ctx.employee.id === actor.id ? prisma.credentialGrant.findMany({ where: { ownerId: actor.id }, include: { grantee: true } }) : [],
    ctx.employee.role === 'ADMIN' && ctx.employee.id === actor.id ? prisma.profile.findMany({ where: { organizationId: actor.organizationId, role: 'ADMIN', status: 'ACTIVE', id: { not: actor.id }, testOwnerAdminId: null }, orderBy: { fullName: 'asc' } }) : [],
  ]);
  return {
    title: `${ctx.employee.fullName} — Credentials`,
    tabs: employeeTabs(actor, ctx, { credentials: true }),
    employee: ctx.employee,
    isSelf: ctx.isSelf,
    roleLabel,
    access,
    credentials,
    systems,
    grants,
    otherAdmins,
    error: null,
    saved: false,
    ...extra,
  };
}

router.get('/employees/:id/credentials', requireSession, async (req, res) => {
  const ctx = await loadEmployeeFor(req.profile, req.params.id);
  if (!ctx) return notFound(res);
  const page = await pageContext(req, ctx, { saved: req.query.saved === '1' });
  if (!page) return forbidden(res);
  res.set('Cache-Control', 'private, no-store');
  res.render('employee/credentials', page);
});

async function loadOwnedCredential(actor, id, impersonating) {
  const credential = await prisma.credential.findFirst({ where: { id, organizationId: actor.organizationId }, include: { owner: true } });
  if (!credential) return { credential: null, access: { view: false, manage: false } };
  return { credential, access: await credentialAccess(actor, credential.owner, { impersonating }) };
}

function readFields(body) {
  return { username: clip(body.username, 200), password: clip(body.password, 500), accountId: clip(body.accountId, 200), note: clip(body.note, 1000) };
}

router.post('/employees/:id/credentials', requireSession, async (req, res) => {
  const actor = req.profile;
  const ctx = await loadEmployeeFor(actor, req.params.id);
  if (!ctx) return notFound(res);
  const page = await pageContext(req, ctx);
  if (!page || !page.access.manage) return forbidden(res);

  const fields = readFields(req.body);
  const selected = clip(req.body.system, 80);
  const systemRow = page.systems.find((s) => s.key === selected);
  const system = systemRow ? systemRow.label : clip(req.body.customSystem, 80);
  if (!system) return res.render('employee/credentials', { ...page, error: 'Choose a system or enter a system name.' });
  if (!fields.password && !fields.username) return res.render('employee/credentials', { ...page, error: 'Enter a login and/or password.' });

  const credential = await prisma.credential.create({
    data: {
      organizationId: actor.organizationId,
      ownerId: ctx.employee.id,
      system,
      systemKey: systemRow ? systemRow.key : null,
      payloadEnc: encryptJson(fields, `cred:${actor.organizationId}:${ctx.employee.id}`),
      createdById: actor.id,
    },
  });
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'credential.created', targetTable: 'Credential', targetId: credential.id, metadata: { system, ownerId: ctx.employee.id } });
  res.redirect(`/employees/${ctx.employee.id}/credentials?saved=1`);
});

router.post('/credentials/:credId/reveal', requireSession, async (req, res) => {
  const actor = req.profile;
  res.set('Cache-Control', 'no-store');
  const { credential, access } = await loadOwnedCredential(actor, req.params.credId, Boolean(req.impersonation));
  if (!credential || !access.view) {
    await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'credential.access_denied', targetTable: 'Credential', targetId: String(req.params.credId).slice(0, 60) });
    return res.status(404).json({ error: 'Not found' });
  }
  const bucket = `credreveal:${actor.id}`;
  if (await isRateLimited(bucket, REVEAL_LIMIT)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  if (!req.body.password || !(await verifyPassword(String(req.body.password), actor.passwordHash))) {
    await recordAttempt(bucket, false);
    await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'credential.reveal_failed', targetTable: 'Credential', targetId: credential.id, metadata: { system: credential.system, ownerId: credential.ownerId } });
    return res.status(401).json({ error: 'Your password is incorrect.' });
  }
  await recordAttempt(bucket, true);
  let payload;
  try { payload = decryptJson(credential.payloadEnc, aadFor(credential)); } catch { return res.status(500).json({ error: 'This credential could not be decrypted.' }); }
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'credential.viewed', targetTable: 'Credential', targetId: credential.id, metadata: { system: credential.system, ownerId: credential.ownerId } });
  res.json({ username: payload.username || '', password: payload.password || '', accountId: payload.accountId || '', note: payload.note || '' });
});

router.post('/credentials/:credId/update', requireSession, async (req, res) => {
  const actor = req.profile;
  const { credential, access } = await loadOwnedCredential(actor, req.params.credId, Boolean(req.impersonation));
  if (!credential || (!access.view && !access.manage)) return notFound(res); // unauthorized and missing IDs look identical
  if (!access.manage) return forbidden(res);

  const existing = (() => { try { return decryptJson(credential.payloadEnc, aadFor(credential)); } catch { return {}; } })();
  const fields = readFields(req.body);
  // Existing values are never sent to the browser, so a blank box means "keep the current value".
  const merged = {
    username: fields.username || existing.username || '',
    password: fields.password || existing.password || '',
    accountId: fields.accountId || existing.accountId || '',
    note: fields.note || existing.note || '',
  };
  await prisma.credential.update({ where: { id: credential.id }, data: { payloadEnc: encryptJson(merged, aadFor(credential)), updatedById: actor.id } });
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'credential.updated', targetTable: 'Credential', targetId: credential.id, metadata: { system: credential.system, ownerId: credential.ownerId, secretChanged: Boolean(fields.password) } });
  res.redirect(`/employees/${credential.ownerId}/credentials?saved=1`);
});

router.post('/credentials/:credId/delete', requireSession, async (req, res) => {
  const actor = req.profile;
  const { credential, access } = await loadOwnedCredential(actor, req.params.credId, Boolean(req.impersonation));
  if (!credential || (!access.view && !access.manage)) return notFound(res); // unauthorized and missing IDs look identical
  if (!access.manage) return forbidden(res);
  await prisma.credential.delete({ where: { id: credential.id } });
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'credential.deleted', targetTable: 'Credential', targetId: credential.id, metadata: { system: credential.system, ownerId: credential.ownerId } });
  res.redirect(`/employees/${credential.ownerId}/credentials?saved=1`);
});

// An admin explicitly authorizing another admin to see THEIR credentials. Only the owner can do this.
router.post('/employees/:id/credentials/grants', requireSession, async (req, res) => {
  const actor = req.profile;
  if (req.impersonation || actor.role !== 'ADMIN' || req.params.id !== actor.id) return forbidden(res);
  const grantee = await prisma.profile.findFirst({ where: { id: String(req.body.granteeId || ''), organizationId: actor.organizationId, role: 'ADMIN', status: 'ACTIVE', testOwnerAdminId: null, NOT: { id: actor.id } } });
  if (!grantee) return notFound(res);
  await prisma.credentialGrant.upsert({ where: { ownerId_granteeId: { ownerId: actor.id, granteeId: grantee.id } }, update: {}, create: { organizationId: actor.organizationId, ownerId: actor.id, granteeId: grantee.id, grantedById: actor.id } });
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'credential.grant_created', targetTable: 'Profile', targetId: grantee.id, metadata: { ownerId: actor.id } });
  res.redirect(`/employees/${actor.id}/credentials?saved=1`);
});

router.post('/employees/:id/credentials/grants/:granteeId/delete', requireSession, async (req, res) => {
  const actor = req.profile;
  if (req.impersonation || actor.role !== 'ADMIN' || req.params.id !== actor.id) return forbidden(res);
  await prisma.credentialGrant.deleteMany({ where: { ownerId: actor.id, granteeId: req.params.granteeId } });
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'credential.grant_removed', targetTable: 'Profile', targetId: req.params.granteeId, metadata: { ownerId: actor.id } });
  res.redirect(`/employees/${actor.id}/credentials?saved=1`);
});

module.exports = router;
