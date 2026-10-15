'use strict';

// Where a learner stands on finishing ONE assigned training: which practices/quizzes still need a pass,
// and whether the training has been submitted (finished) yet. One source for the training page (which
// shows the "Submit training" button) and for POST /training/:id/complete (which enforces it).
const { prisma } = require('./prisma');

const safeParse = (value, fallback) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };

/** recipient: a TrainingAssignmentRecipient loaded with { assignment, attempts }. */
async function completionState(recipient) {
  const { assignment } = recipient;
  const assessments = (await prisma.assessment.findMany({
    where: { courseId: assignment.courseId, status: 'APPROVED', version: assignment.courseVersion, ...(assignment.assessmentId ? { id: assignment.assessmentId } : {}) },
    orderBy: { createdAt: 'asc' },
  })).filter((a) => !safeParse(a.configJson, {}).targetedRetake);
  const rows = assessments.map((assessment) => {
    const finished = recipient.attempts.filter((t) => t.assessmentId === assessment.id && t.completedAt);
    const needed = Math.max(assessment.passingScore, assignment.minimumScore);
    const passed = finished.length >= assignment.requiredAttempts && finished.some((t) => t.status === 'COMPLETED' && t.score !== null && t.score >= needed);
    return { assessment, passed };
  });
  return {
    rows,
    total: rows.length,
    passedCount: rows.filter((r) => r.passed).length,
    passedAll: rows.every((r) => r.passed),
    missing: rows.filter((r) => !r.passed).map((r) => r.assessment.title),
    // Submitted = a course-level attempt (not tied to one practice) has been completed.
    submitted: recipient.attempts.some((t) => !t.assessmentId && t.status === 'COMPLETED'),
  };
}

/**
 * Finishes the training for this recipient: the course-level attempt becomes COMPLETED and is numbered
 * after every practice attempt, so it is the one the My Training list reads as the current status.
 */
async function submitTraining(recipient) {
  const highest = recipient.attempts.reduce((max, t) => Math.max(max, t.attemptNumber), 0);
  const open = recipient.attempts.filter((t) => !t.assessmentId && t.status === 'IN_PROGRESS').sort((a, b) => b.attemptNumber - a.attemptNumber);
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    // an earlier "Start" left an open attempt: finish that one; any extra open ones are closed too
    for (const extra of open.slice(1)) await tx.trainingAttempt.update({ where: { id: extra.id }, data: { status: 'COMPLETED', completedAt: now } });
    if (open.length) return tx.trainingAttempt.update({ where: { id: open[0].id }, data: { status: 'COMPLETED', completedAt: now, attemptNumber: highest + 1 } });
    return tx.trainingAttempt.create({ data: { recipientId: recipient.id, profileId: recipient.profileId, attemptNumber: highest + 1, status: 'COMPLETED', startedAt: now, completedAt: now } });
  });
}

module.exports = { completionState, submitTraining };
