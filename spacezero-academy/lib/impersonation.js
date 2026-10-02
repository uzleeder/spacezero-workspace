'use strict';

const { prisma } = require('./prisma');
const { hashToken } = require('./tokens');
const { SESSION_COOKIE, createSession } = require('./session');
const { logAudit } = require('./audit');

// A real, audited "view as" feature: an admin starting a session as another
// employee gets a REAL session for that profile, so every existing
// server-side check (requireRole, objectAccess, authz) applies exactly as it
// would for that employee — this is never a frontend-only role switch.
// The admin's own session token is parked in a second cookie so it can be
// restored; it is never destroyed while impersonating.
const ADMIN_SESSION_COOKIE = 'sz_admin_session';

async function loadValidAdminSession(raw) {
  if (!raw) return null;
  const session = await prisma.session.findUnique({ where: { tokenHash: hashToken(raw) }, include: { profile: true } });
  if (!session || session.expiresAt < new Date()) return null;
  if (session.profile.role !== 'ADMIN' || session.profile.status !== 'ACTIVE') return null;
  return session;
}

// Runs on every request, right after attachProfile. If a parked admin
// session exists and is still valid, exposes it as req.impersonation so the
// layout can show the "Viewing as X — Return to admin" banner. Does NOT
// change req.profile — that stays whatever the real sz_session cookie
// resolves to (the impersonated profile), which is the whole point.
async function attachImpersonation(req, res, next) {
  try {
    const raw = req.cookies ? req.cookies[ADMIN_SESSION_COOKIE] : null;
    const adminSession = await loadValidAdminSession(raw);
    req.impersonation =
      adminSession && req.profile && req.profile.id !== adminSession.profile.id
        ? { adminId: adminSession.profile.id, adminName: adminSession.profile.fullName }
        : null;
  } catch (err) {
    console.error('[attachImpersonation] failed to load admin session:', err.message || err);
    req.impersonation = null;
  }
  next();
}

async function startImpersonation(req, res, targetProfile) {
  const admin = req.profile;
  if (!admin || admin.role !== 'ADMIN' || admin.status !== 'ACTIVE' || !await prisma.profile.findFirst({ where: { ...require('./loginAsScope').loginAsScope(admin), id: targetProfile.id } })) {
    throw new Error('Impersonation is not authorized');
  }
  const currentRaw = req.cookies ? req.cookies[SESSION_COOKIE] : null;

  res.cookie(ADMIN_SESSION_COOKIE, currentRaw, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  });

  await createSession(res, targetProfile.id, {
    userAgent: req.get ? req.get('user-agent') : undefined,
    ipAddress: req.ip,
  });

  await logAudit({
    organizationId: admin.organizationId,
    actorId: admin.id,
    action: 'impersonation.start',
    targetTable: 'Profile',
    targetId: targetProfile.id,
    metadata: { targetRole: targetProfile.role },
  });
}

async function endImpersonation(req, res) {
  const raw = req.cookies ? req.cookies[ADMIN_SESSION_COOKIE] : null;
  const adminSession = await loadValidAdminSession(raw);
  if (!adminSession) {
    res.clearCookie(ADMIN_SESSION_COOKIE, { path: '/' });
    return false;
  }

  const impersonatedRaw = req.cookies ? req.cookies[SESSION_COOKIE] : null;
  if (impersonatedRaw) {
    await prisma.session.deleteMany({ where: { tokenHash: hashToken(impersonatedRaw) } }).catch(() => undefined);
  }

  res.cookie(SESSION_COOKIE, raw, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    expires: adminSession.expiresAt,
    path: '/',
  });
  res.clearCookie(ADMIN_SESSION_COOKIE, { path: '/' });

  await logAudit({
    organizationId: adminSession.profile.organizationId,
    actorId: adminSession.profile.id,
    action: 'impersonation.end',
    targetTable: 'Profile',
    targetId: req.profile ? req.profile.id : undefined,
  });

  return true;
}

module.exports = { ADMIN_SESSION_COOKIE, attachImpersonation, startImpersonation, endImpersonation };
