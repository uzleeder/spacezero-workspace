'use strict';

// Where a learner stands on finishing ONE assigned training: which practices/quizzes still need a pass,
// and whether the training has been submitted (finished) yet. One source for the training page (which
// shows the "Submit training" button) and for POST /training/:id/complete (which enforces it).
const { prisma } = require('./prisma');
const { claim, release } = require('./inFlightLock');

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
  // A retake the supervisor or an Admin asked for means the practice has to be passed AGAIN: only attempts finished after the
  // request count (otherwise the earlier pass would finish the training again at once).
  const reopenedAt = recipient.attempts.reduce((latest, t) => (t.retakeRequestedAt && (!latest || new Date(t.retakeRequestedAt) > latest) ? new Date(t.retakeRequestedAt) : latest), null);
  const rows = assessments.filter((a) => a.status === 'APPROVED' && !a.archivedAt && a.version === assignment.courseVersion && (!assignment.assessmentId || a.id === assignment.assessmentId) && !safeParse(a.configJson, {}).targetedRetake).map((assessment) => {
    const finished = recipient.attempts.filter((t) => t.assessmentId === assessment.id && t.completedAt && (!reopenedAt || new Date(t.completedAt) > reopenedAt));
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
 * Is this unfinished training DONE except for the final submission? Every required material is finished and every
 * practice/quiz is passed (a training with no practice counts once its required material is finished). The same rule
 * as the training page and POST /training/:id/complete. `assessments` = the course's approved assessments.
 */
async function isReadyToFinish(recipient, assessments) {
  const state = completionFromAssessments(recipient, assessments);
  if (state.submitted || !state.passedAll) return false;
  const gate = await require('./mediaProgress').mediaGate(recipient.profileId, recipient.assignment.courseId, recipient.assignment.courseVersion);
  if (!gate.unlocked) return false;
  return state.total > 0 || gate.total > 0; // nothing to do at all is never "done"
}

async function readyRecipients(list) {
  const open = list.filter((r) => r.status !== 'COMPLETED' && r.assignment && r.assignment.course);
  if (!open.length) return [];
  const courseIds = [...new Set(open.map((r) => r.assignment.courseId))];
  const assessments = await prisma.assessment.findMany({ where: { courseId: { in: courseIds }, status: 'APPROVED', archivedAt: null }, orderBy: { createdAt: 'asc' } });
  const ready = [];
  for (const r of open) if (await isReadyToFinish(r, assessments.filter((a) => a.courseId === r.assignment.courseId))) ready.push(r);
  return ready;
}

/**
 * Finishes the training: the course-level attempt becomes COMPLETED, the certificate is issued and the learner is
 * told. Safe to call twice (a second call changes nothing). Used by the Submit button and by the automatic path.
 */
async function finishTraining(recipient) {
  // Two requests can notice the same finished training at once (the result page and a progress ping, a double tap):
  // only one of them finishes it; the other changes nothing.
  const key = `finish-training:${recipient.id}`;
  if (!claim(key)) return false;
  try { return await finishOnce(recipient); } finally { release(key); }
}

async function finishOnce(recipient) {
  const fresh = await prisma.trainingAssignmentRecipient.findUnique({ where: { id: recipient.id }, include: { assignment: { include: { course: true } }, attempts: true } });
  const state = await completionState(fresh || recipient);
  if (state.submitted) return false;
  recipient = fresh || recipient;
  await submitTraining(recipient);
  // One certificate per person and course (a repeated completion after a retake keeps the original).
  const hadCertificate = Boolean(await prisma.certificate.findFirst({ where: { profileId: recipient.profileId, courseId: recipient.assignment.courseId }, select: { id: true } }));
  if (!hadCertificate) await prisma.certificate.create({ data: { profileId: recipient.profileId, courseId: recipient.assignment.courseId, title: recipient.assignment.course.title, description: 'Training course completed.' } }).catch(() => undefined);
  await require('./notifications').createNotification({
    profileId: recipient.profileId, type: 'training.completed', title: 'Course completed',
    body: `You completed "${recipient.assignment.course.title}".${hadCertificate ? '' : ' A certificate was added to your profile.'}`, link: '/profile',
  }).catch(() => undefined);
  return true;
}

/**
 * Nobody should have to press a button to be marked finished: the moment everything required is done, the training
 * moves to Completed on its own (and leaves Overdue). Returns how many trainings were finished.
 * `where` narrows which of the person's assignments are looked at (e.g. one course).
 */
async function autoFinishForProfile(profileId, where = {}) {
  const recipients = await prisma.trainingAssignmentRecipient.findMany({ where: { profileId, ...where }, include: { assignment: { include: { course: true } }, attempts: true } });
  const { trainingStatus } = require('./training');
  const list = recipients.map((r) => ({ ...r, status: trainingStatus(r.attempts) }));
  let finished = 0;
  for (const r of await readyRecipients(list)) if (await finishTraining(r)) finished += 1;
  return finished;
}

/** Catches up everyone (used at start-up and periodically): trainings completed before this rule existed move now. */
async function autoFinishAll({ batch = 200 } = {}) {
  let cursor; let finished = 0;
  for (;;) {
    const people = await prisma.profile.findMany({ where: { status: 'ACTIVE', archivedAt: null, testOwnerAdminId: null, trainingRecipient: { some: {} } }, select: { id: true }, orderBy: { id: 'asc' }, take: batch, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    if (!people.length) break;
    for (const p of people) finished += await autoFinishForProfile(p.id).catch(() => 0);
    cursor = people[people.length - 1].id;
  }
  return finished;
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

module.exports = { completionState, completionFromAssessments, submitTraining, finishTraining, isReadyToFinish, autoFinishForProfile, autoFinishAll, practiceFlowFor, startUrl };
