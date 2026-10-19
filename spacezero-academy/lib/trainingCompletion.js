'use strict';

// Where a learner stands on finishing ONE assigned training: which practices/quizzes still need a pass,
// and whether the training has been submitted (finished) yet. One source for the training page (which
// shows the "Submit training" button) and for POST /training/:id/complete (which enforces it).
const { prisma } = require('./prisma');

const safeParse = (value, fallback) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };

/** recipient: a TrainingAssignmentRecipient loaded with { assignment, attempts }. */
async function completionState(recipient) {
  const { assignment } = recipient;
  const assessments = await prisma.assessment.findMany({
    where: { courseId: assignment.courseId, status: 'APPROVED', archivedAt: null, version: assignment.courseVersion, ...(assignment.assessmentId ? { id: assignment.assessmentId } : {}) },
    orderBy: { createdAt: 'asc' },
  });
  return completionFromAssessments(recipient, assessments);
}

// Also used by the email worker, which already loaded the course's assessments.
function completionFromAssessments(recipient, assessments) {
  const { assignment } = recipient;
  const rows = assessments.filter((a) => a.status === 'APPROVED' && !a.archivedAt && a.version === assignment.courseVersion && (!assignment.assessmentId || a.id === assignment.assessmentId) && !safeParse(a.configJson, {}).targetedRetake).map((assessment) => {
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
    // A later course retake/start supersedes an older submission.
    submitted: recipient.attempts.filter((t) => !t.assessmentId).sort((a, b) => b.attemptNumber - a.attemptNumber || new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0]?.status === 'COMPLETED',
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

/**
 * Which of the learner's unfinished trainings are READY TO SUBMIT: every required material is finished and every
 * practice/quiz is passed, so only the Submit press is left. My Training
 * shows these with their own button, so a learner who passed everything is never left wondering why it is still open.
 * `list` is getMyTrainingList(); returns a Set of recipient ids. Same rules as the training page and POST /complete.
 */
async function readyToSubmitIds(list) {
  const open = list.filter((r) => r.status !== 'COMPLETED' && r.assignment && r.assignment.course);
  if (!open.length) return new Set();
  const courseIds = [...new Set(open.map((r) => r.assignment.courseId))];
  const assessments = await prisma.assessment.findMany({ where: { courseId: { in: courseIds }, status: 'APPROVED', archivedAt: null }, orderBy: { createdAt: 'asc' } });
  const { mediaGate } = require('./mediaProgress');
  const ready = new Set();
  for (const r of open) {
    const state = completionFromAssessments(r, assessments.filter((a) => a.courseId === r.assignment.courseId));
    if (state.submitted || state.total === 0 || !state.passedAll) continue; // a training without practice is finished on its own page
    if ((await mediaGate(r.profileId, r.assignment.courseId, r.assignment.courseVersion)).unlocked) ready.add(r.id);
  }
  return ready;
}

const startUrl = (assessment) => (assessment.type === 'ROLEPLAY' ? `/assessments/${assessment.id}/roleplay` : `/assessments/${assessment.id}/take`);

/**
 * Where a learner stands in the sequence of practices of ONE training, right after finishing `assessment`:
 * which practice comes next (the first one not yet completed after this one, else any earlier one still open),
 * how many are completed, and whether that was the last. A practice counts as Completed when it is passed -
 * the same rule that decides whether the training can be submitted; nothing about scoring, passing or retakes
 * changes. Returns null for practice that is not part of the training's sequence (e.g. a targeted retake).
 */
async function practiceFlowFor(profileId, assessment, recipientId) {
  if (!assessment || !assessment.courseId) return null;
  const recipient = await prisma.trainingAssignmentRecipient.findFirst({ where: { ...(recipientId ? { id: recipientId } : {}), profileId, assignment: { courseId: assessment.courseId, courseVersion: assessment.version, OR: [{ assessmentId: null }, { assessmentId: assessment.id }] } }, orderBy: { createdAt: 'desc' }, include: { assignment: true, attempts: true } });
  if (!recipient) return null;
  const state = await completionState(recipient);
  const index = state.rows.findIndex((r) => r.assessment.id === assessment.id);
  if (index < 0) return null;
  const next = state.rows.slice(index + 1).find((r) => !r.passed) || state.rows.find((r, i) => i < index && !r.passed) || null;
  return {
    courseId: assessment.courseId,
    position: index + 1,
    total: state.total,
    completed: state.rows[index].passed,
    completedCount: state.passedCount,
    allDone: state.passedAll,
    submitted: state.submitted,
    next: next ? { id: next.assessment.id, title: next.assessment.title, url: startUrl(next.assessment) } : null,
  };
}

module.exports = { completionState, completionFromAssessments, submitTraining, practiceFlowFor, readyToSubmitIds, startUrl };
