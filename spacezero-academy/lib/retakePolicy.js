'use strict';

// How often a failed practice can be tried again. Without a limit anyone could resubmit the same quiz straight away and
// pass it by trial and error (or by reading the answers off the result), so after a failed attempt the learner waits a
// few minutes, and after a few failed attempts of the SAME practice a new, targeted set of questions is needed
// ("Practice these skills now") instead of the same ones again. Both numbers are organization settings.
const { prisma } = require('./prisma');
const { getSetting } = require('./orgSettings');

/**
 * Whether this learner may start / submit this practice right now.
 * Returns null when they may; otherwise { reason: 'wait' | 'used_up', waitMs, minutes, failed, max }.
 */
async function retakeBlock(recipientId, assessment, now = Date.now()) {
  if (!recipientId) return null;
  const all = await prisma.trainingAttempt.findMany({ where: { recipientId, assessmentId: assessment.id, completedAt: { not: null } }, orderBy: [{ completedAt: 'desc' }, { attemptNumber: 'desc' }], select: { status: true, completedAt: true, skillBreakdownJson: true } });
  // A supervisor or Admin who asks for a retake gives the learner a fresh start: only tries made after the request count.
  const reopened = await prisma.trainingAttempt.findFirst({ where: { recipientId, retakeRequestedAt: { not: null } }, orderBy: { retakeRequestedAt: 'desc' }, select: { retakeRequestedAt: true } });
  const attempts = reopened ? all.filter((a) => a.completedAt > reopened.retakeRequestedAt) : all;
  if (!attempts.length || attempts[0].status === 'COMPLETED') return null;      // never tried, or already passed: nothing to hold back
  const [minutes, max] = await Promise.all([getSetting(assessment.organizationId, 'training.retakeWaitMinutes'), getSetting(assessment.organizationId, 'training.maxAttemptsPerPractice')]);
  const failed = attempts.filter((a) => a.status !== 'COMPLETED').length;
  if (failed >= max) {
    // "Practice these skills now" always opens a new retake (it aims at the weak skills, else at the practice's own material).
    return { reason: 'used_up', waitMs: 0, minutes, failed, max, canRemediate: true };
  }
  const waitMs = Math.max(0, attempts[0].completedAt.getTime() + minutes * 60000 - now);
  return waitMs > 0 ? { reason: 'wait', waitMs, minutes, failed, max } : null;
}

module.exports = { retakeBlock };
