'use strict';
const { prisma } = require('./prisma');
const { generateToken } = require('./tokens');
const { sendAccountEmail } = require('./mailer');
const { logAudit } = require('./audit');

async function sendReset(profile, actorId = profile.id) {
  const { raw, hash } = generateToken();
  const token = await prisma.$transaction(async tx => {
    await tx.passwordResetToken.updateMany({ where: { profileId: profile.id, usedAt: null }, data: { usedAt: new Date() } });
    return tx.passwordResetToken.create({ data: { profileId: profile.id, tokenHash: hash, expiresAt: new Date(Date.now() + 3600000) } });
  });
  try {
    await sendAccountEmail(profile.email, raw, 'reset');
    await logAudit({ organizationId: profile.organizationId, actorId, action: 'email.password_reset_sent', targetTable: 'Profile', targetId: profile.id });
  } catch {
    await prisma.passwordResetToken.update({ where: { id: token.id }, data: { usedAt: new Date() } });
    await logAudit({ organizationId: profile.organizationId, actorId, action: 'email.password_reset_failed', targetTable: 'Profile', targetId: profile.id });
    throw new Error('Email delivery failed. Please check SMTP settings and try again.');
  }
}

module.exports = { sendReset };
