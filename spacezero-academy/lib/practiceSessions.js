'use strict';
const { prisma } = require('./prisma');
async function openSession(profileId, assessment, initialData) {
  const existing = await prisma.practiceSession.findFirst({ where: { profileId, assessmentId: assessment.id, completedAttemptId: null }, orderBy: { createdAt: 'desc' } });
  if (existing) return existing;
  return prisma.practiceSession.create({ data: { profileId, assessmentId: assessment.id, dataJson: JSON.stringify(initialData) } });
}
async function claimSession(profileId, assessmentId, id) {
  if (typeof id !== 'string') return null;
  await prisma.practiceSession.updateMany({ where: { id, profileId, assessmentId, busy: true, completedAttemptId: null, updatedAt: { lt: new Date(Date.now() - 5 * 60000) } }, data: { busy: false } });
  const result = await prisma.practiceSession.updateMany({ where: { id, profileId, assessmentId, completedAttemptId: null, busy: false }, data: { busy: true } });
  return result.count ? prisma.practiceSession.findUnique({ where: { id } }) : null;
}
async function releaseSession(id, data) { return prisma.practiceSession.update({ where: { id }, data: { busy: false, ...data } }); }
module.exports = { openSession, claimSession, releaseSession };
