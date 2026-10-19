'use strict';

// Where a learner stands on finishing ONE assigned training: which practices/quizzes still need a pass,
// and whether the training has been submitted (finished) yet. One source for the training page (which
// shows the "Submit training" button) and for POST /training/:id/complete (which enforces it).
const { prisma } = require('./prisma');
const { retakeOf } = require('./courseVersions');

const safeParse = (value, fallback) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };

/**
 * The practice an older retake (made before retakes recorded it) stands in for: the practice of the same kind
 * the learner had most recently failed when the retake was made - the retake was asked for from that result.
 */
function olderRetakeOriginal(retake, practices, attempts) {
  let found = null;
  for (const practice of practices) {
    if (practice.type !== retake.type) continue;
    for (const t of attempts) {
      if (t.assessmentId !== practice.id || t.status !== 'RETAKE_REQUIRED' || new Date(t.createdAt) > new Date(retake.createdAt)) continue;
      if (!found || new Date(t.createdAt) > found.at) found = { id: practice.id, at: new Date(t.createdAt) };
    }
  }
  return found ? found.id : null;
}

/** recipient: a TrainingAssignmentRecipient loaded with { assignment, attempts }. */
async function completionState(recipient) {
  const { assignment } = recipient;
  const assessments = await prisma.assessment.findMany({
    where: {
      courseId: assignment.courseId, status: 'APPROVED', archivedAt: null,
      // the practices of the assigned version, and the learner's retakes of them (see completionFromAssessments)
      OR: [{ version: assignment.courseVersion, ...(assignment.assessmentId ? { id: assignment.assessmentId } : {}) }, { createdById: recipient.profileId, configJson: { contains: 'targetedRetake' } }],
    },
    orderBy: { createdAt: 'asc' },
  });
  return completionFromAssessments(recipient, assessments);
}

// Also used by the email worker, which already loaded the course's assessments.
// A learner's retake of a practice (Smart Retake) stands in for that practice: passing the retake passes it,
// and its attempts count towards the required attempts. Both attempts stay in the history.
function completionFromAssessments(recipient, assessments) {
  const { assignment } = recipient;
  const practices = assessments.filter((a) => a.status === 'APPROVED' && !a.archivedAt && a.version === assignment.courseVersion && (!assignment.assessmentId || a.id === assignment.assessmentId) && !safeParse(a.configJson, {}).targetedRetake);
  const retakes = assessments.filter((a) => a.status === 'APPROVED' && !a.archivedAt && a.createdById === recipient.profileId && safeParse(a.configJson, {}).targetedRetake);
  const retakeIdsOf = (id) => retakes.filter((a) => (retakeOf(a) || olderRetakeOriginal(a, practices, recipient.attempts)) === id).map((a) => a.id);
  const rows = practices.map((assessment) => {
    const ids = new Set([assessment.id, ...retakeIdsOf(assessment.id)]);
    const finished = recipient.attempts.filter((t) => ids.has(t.assessmentId) && t.completedAt);
    const needed = Math.max(assessment.passingScore, assignment.minimumScore);
    const passed = finished.length >= assignment.requiredAttempts && finished.some((t) => t.status === 'COMPLETED' && t.score !== null && t.score >= needed);
    const latest = [...finished].sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))[0] || null;
    return { assessment, passed, latest };
  });
  return {
    rows,
    total: rows.length,
    passedCount: rows.filter((r) => r.passed).length,
    passedAll: rows.every((r) => r.passed),
    missing: rows.filter((r) => !r.passed).map((r) => r.assessment.title),
    // Submitted = a course-level attempt (not tied to one practice) has been completed.
    // A later course retake/start supersedes an older submission.
    submitted: isSubmitted(recipient.attempts),
  };
}

// Practice attempts are numbered per practice, so "the attempt with the highest number" says nothing about a
// training as a whole. Its course-level attempts (Start, Submit training, a manager's retake request) do.
const newestFirst = (a, b) => b.attemptNumber - a.attemptNumber || new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
/** The newest course-level attempt of a training (not tied to one practice), or null. */
const courseAttempt = (attempts) => attempts.filter((t) => !t.assessmentId).sort(newestFirst)[0] || null;
/** Submitted (finished), and no retake asked for since. */
const isSubmitted = (attempts) => courseAttempt(attempts)?.status === 'COMPLETED';
/** The attempt a manager's retake request re-opens: the training's submission, else (never submitted) its newest attempt. */
const retakeTarget = (attempts) => courseAttempt(attempts) || [...attempts].sort(newestFirst)[0] || null;

/**
 * The status of one assigned training, by the same rules as submitting it:
 *   COMPLETED       - submitted, and no retake asked for since (practising again afterwards changes nothing);
 *   RETAKE_REQUIRED - a manager asked for a retake, or a required practice is not passed yet and its latest
 *                     result failed;
 *   IN_PROGRESS     - anything started; NOT_STARTED otherwise.
 * recipient: { profileId, assignment, attempts }; assessments: the course's (see assessmentsByCourse).
 */
function trainingStatusFrom(recipient, assessments) {
  const course = courseAttempt(recipient.attempts);
  if (course && course.status === 'COMPLETED') return 'COMPLETED';
  if (course && course.status === 'RETAKE_REQUIRED') return 'RETAKE_REQUIRED';
  const { rows } = completionFromAssessments(recipient, assessments);
  if (rows.some((r) => !r.passed && r.latest && ['RETAKE_REQUIRED', 'FAILED'].includes(r.latest.status))) return 'RETAKE_REQUIRED';
  return recipient.attempts.some((t) => t.status !== 'NOT_STARTED') ? 'IN_PROGRESS' : 'NOT_STARTED';
}

/** The approved assessments of many courses in one query (Map courseId -> list), as completion needs them. */
async function assessmentsByCourse(courseIds) {
  const ids = [...new Set(courseIds)];
  const byCourse = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return byCourse;
  const rows = await prisma.assessment.findMany({
    where: { courseId: { in: ids }, status: 'APPROVED', archivedAt: null },
    select: { id: true, courseId: true, status: true, archivedAt: true, version: true, type: true, configJson: true, createdById: true, passingScore: true, title: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  for (const a of rows) byCourse.get(a.courseId).push(a);
  return byCourse;
}

/** The status of each recipient ({ profileId, assignment, attempts }) by trainingStatusFrom, loading what it needs. */
async function trainingStatuses(recipients) {
  const assessments = await assessmentsByCourse(recipients.map((r) => r.assignment.courseId));
  return recipients.map((r) => trainingStatusFrom(r, assessments.get(r.assignment.courseId) || []));
}

/**
 * Finishes the training for this recipient: the course-level attempt becomes COMPLETED and is numbered
 * after every practice attempt, so it is the newest course-level attempt (see courseAttempt).
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

const startUrl = (assessment) => (assessment.type === 'ROLEPLAY' ? `/assessments/${assessment.id}/roleplay` : `/assessments/${assessment.id}/take`);

/**
 * Where a learner stands in the sequence of practices of ONE training, right after finishing `assessment`:
 * which practice comes next (the first one not yet completed after this one, else any earlier one still open),
 * how many are completed, and whether that was the last. A practice counts as Completed when it is passed -
 * the same rule that decides whether the training can be submitted; nothing about scoring, passing or retakes
 * changes. A retake takes the place of the practice it retakes; null for practice that is not part of the
 * training's sequence (e.g. an older retake that does not record which practice it retakes).
 */
async function practiceFlowFor(profileId, assessment, recipientId) {
  if (!assessment || !assessment.courseId) return null;
  if (retakeOf(assessment)) assessment = (await prisma.assessment.findUnique({ where: { id: retakeOf(assessment) } })) || assessment;
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

module.exports = { completionState, completionFromAssessments, submitTraining, practiceFlowFor, startUrl, courseAttempt, isSubmitted, retakeTarget, newestFirst, trainingStatusFrom, assessmentsByCourse, trainingStatuses };
