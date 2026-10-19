'use strict';
const { prisma } = require('./prisma');
const { hashToken } = require('./tokens');

async function consumeAccountToken(raw, passwordHash, invite) {
  return prisma.$transaction(async tx => {
    const now = new Date();
    const model = invite ? tx.invitation : tx.passwordResetToken;
    const row = await model.findUnique({ where: { tokenHash: hashToken(raw) }, include: { profile: true } });
    if (!row || row.expiresAt <= now || row.profile.status !== (invite ? 'INVITED' : 'ACTIVE')) return null;
    const used = await model.updateMany({
      where: { id: row.id, expiresAt: { gt: now }, ...(invite ? { status: 'PENDING' } : { usedAt: null }) },
      data: invite ? { status: 'ACCEPTED', acceptedAt: now } : { usedAt: now },
    });
    if (used.count !== 1) return null;
    await tx.profile.update({ where: { id: row.profileId }, data: { passwordHash, ...(invite ? { status: 'ACTIVE' } : {}) } });
    await tx.passwordResetToken.updateMany({ where: { profileId: row.profileId, usedAt: null }, data: { usedAt: now } });
    await tx.session.deleteMany({ where: { profileId: row.profileId } });
    await tx.auditLog.create({ data: { organizationId: row.profile.organizationId, actorId: row.profileId, action: invite ? 'auth.account_activated' : 'auth.password_reset_completed' } });
    return row.profile;
  });
}
module.exports = { consumeAccountToken };
