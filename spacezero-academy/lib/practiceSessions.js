'use strict';
const { prisma } = require('./prisma');
async function openSession(profileId, assessment, initialData) {
  const existing = await prisma.practiceSession.findFirst({ where: { profileId, assessmentId: assessment.id, completedAttemptId: null }, orderBy: { createdAt: 'desc' } });
  if (existing) return existing;
  return prisma.practiceSession.create({ data: { profileId, assessmentId: assessment.id, dataJson: JSON.stringify(initialData) } });
}
// A turn is claimed while the AI answers. A claim that was never released (the server restarted, the
// request died) frees itself after this long, so a practice can never stay stuck.
const STALE_BUSY_MS = 90 * 1000;
/** The learner's own session row (any state), or null. Used to tell "busy" from "already finished". */
async function findSession(profileId, assessmentId, id) {
  if (typeof id !== 'string') return null;
  return prisma.practiceSession.findFirst({ where: { id, profileId, assessmentId } });
}
async function claimSession(profileId, assessmentId, id) {
  if (typeof id !== 'string') return null;
  await prisma.practiceSession.updateMany({ where: { id, profileId, assessmentId, busy: true, completedAttemptId: null, updatedAt: { lt: new Date(Date.now() - STALE_BUSY_MS) } }, data: { busy: false } });
  const result = await prisma.practiceSession.updateMany({ where: { id, profileId, assessmentId, completedAttemptId: null, busy: false }, data: { busy: true } });
  return result.count ? prisma.practiceSession.findUnique({ where: { id } }) : null;
}
async function releaseSession(id, data) { return prisma.practiceSession.update({ where: { id }, data: { busy: false, ...data } }); }
/** Waits briefly while another request holds the session (the first of two taps on Submit); returns the row as it then is. */
async function waitWhileBusy(profileId, assessmentId, id, { timeoutMs = 15000, everyMs = 250 } = {}) {
  const until = Date.now() + timeoutMs;
  let row = await findSession(profileId, assessmentId, id);
  while (row && row.busy && !row.completedAttemptId && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, everyMs));
    row = await findSession(profileId, assessmentId, id);
  }
  return row;
}
module.exports = { openSession, findSession, claimSession, releaseSession, waitWhileBusy };
