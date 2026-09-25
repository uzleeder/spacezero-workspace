'use strict';

const { prisma } = require('./prisma');
const { generateToken, hashToken } = require('./tokens');

const SESSION_COOKIE = 'sz_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

async function createSession(res, profileId, meta) {
  const { raw, hash } = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await prisma.session.create({
    data: {
      profileId,
      tokenHash: hash,
      userAgent: (meta && meta.userAgent) || undefined,
      ipAddress: (meta && meta.ipAddress) || undefined,
      expiresAt,
    },
  });

  res.cookie(SESSION_COOKIE, raw, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    expires: expiresAt,
    path: '/',
  });
}

async function destroySession(req, res) {
  const raw = req.cookies ? req.cookies[SESSION_COOKIE] : null;
  if (raw) {
    await prisma.session.deleteMany({ where: { tokenHash: hashToken(raw) } }).catch(() => undefined);
  }
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

// Reads + validates the session against the database (secure check, not
// just trusting the cookie). Returns null for anonymous/expired/invalid
// sessions or accounts that are no longer ACTIVE.
async function getSessionProfile(req) {
  const raw = req.cookies ? req.cookies[SESSION_COOKIE] : null;
  if (!raw) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(raw) },
    include: { profile: true },
  });

  if (!session || session.expiresAt < new Date()) return null;
  if (session.profile.status !== 'ACTIVE') return null;

  void prisma.session.updateMany({ where: { id: session.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  void prisma.profile
    .updateMany({ where: { id: session.profile.id }, data: { lastActivityAt: new Date() } })
    .catch(() => undefined);

  return session.profile;
}

module.exports = { SESSION_COOKIE, createSession, destroySession, getSessionProfile };
