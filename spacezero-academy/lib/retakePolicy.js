'use strict';

// How soon a failed practice can be tried again. Without a pause anyone could resubmit straight away and pass by trial
// and error, so after a failed try the learner waits a few minutes (an organization setting) before ANY next try of
// that practice - the original quiz or a new set of questions made from it ("Try again"): the wait is counted across
// the whole family, whichever button is pressed. A supervisor's or Admin's retake request gives a fresh start.
const { prisma } = require('./prisma');
const { getSetting } = require('./orgSettings');
const { retakeOf } = require('./courseVersions');

/** The original practice of an assessment and the ids of it and every new set made from it (a retake of a retake included). */
async function practiceFamily(assessment) {
  const originalId = retakeOf(assessment) || assessment.id;
  const sets = assessment.courseId
    ? await prisma.assessment.findMany({ where: { courseId: assessment.courseId, configJson: { contains: originalId } }, select: { id: true, configJson: true } })
    : [];
  return { originalId, ids: [originalId, ...sets.filter((a) => a.id !== originalId && retakeOf(a) === originalId).map((a) => a.id)] };
}

/** The tries of a practice family that still count (newest first): only those made after a retake request. */
async function familyTries(recipientId, assessment) {
  const family = await practiceFamily(assessment);
  if (!recipientId) return { ...family, tries: [] };
  const all = await prisma.trainingAttempt.findMany({ where: { recipientId, assessmentId: { in: family.ids }, status: { not: 'NOT_STARTED' } }, select: { id: true, status: true, completedAt: true, createdAt: true, attemptNumber: true, assessmentId: true, skillBreakdownJson: true } });
  const at = (t) => new Date(t.completedAt || t.createdAt).getTime();
  all.sort((a, b) => at(b) - at(a) || b.attemptNumber - a.attemptNumber);
  const reopened = await prisma.trainingAttempt.findFirst({ where: { recipientId, retakeRequestedAt: { not: null } }, orderBy: { retakeRequestedAt: 'desc' }, select: { retakeRequestedAt: true } });
  return { ...family, tries: reopened ? all.filter((t) => at(t) > reopened.retakeRequestedAt.getTime()) : all };
}

/**
 * Whether this learner may start / submit / prepare a new set of this practice right now.
 * Returns null when they may; otherwise { reason: 'wait', waitMs, until, minutes }.
 */
async function retakeBlock(recipientId, assessment, now = Date.now()) {
  if (!recipientId) return null;
  const tries = (await familyTries(recipientId, assessment)).tries.filter((t) => t.completedAt); // the wait runs from a finished try
  if (!tries.length || tries[0].status === 'COMPLETED') return null;             // never tried, or the newest try passed
  const minutes = await getSetting(assessment.organizationId, 'training.retakeWaitMinutes');
  const until = tries[0].completedAt.getTime() + minutes * 60000;
  return until > now ? { reason: 'wait', waitMs: until - now, until: new Date(until), minutes } : null;
}

module.exports = { practiceFamily, familyTries, retakeBlock };
