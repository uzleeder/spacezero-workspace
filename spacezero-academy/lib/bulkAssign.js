'use strict';

// Bulk assignment (spec section 14): one action creates a real assignment whose recipients are each
// tracked separately (their own attempts, status, due date). Authorization is decided here on the
// server, never by which checkboxes the page showed:
//   * the caller passes `allowedIds` (a Supervisor's own team, or the organization for an Admin);
//   * every requested employee must be inside it, otherwise nothing is created;
//   * the training must be one the actor may assign (published, and permitted by the Admin's policy);
//   * a practice must be an APPROVED assessment of that training; drafts can never be assigned.
const { prisma } = require('./prisma');
const trainingEmails = require('./trainingEmails');
const { canAssignCourse } = require('./trainingPermissions');
const { getSetting } = require('./orgSettings');
const { logAudit } = require('./audit');
const { createNotificationForMany } = require('./notifications');
const { coversSkill } = require('./development');
const { liveVersion } = require('./courseVersions');

const KINDS = ['COURSE', 'PRACTICE', 'RETAKE', 'REMEDIATION'];
const KIND_LABEL = { COURSE: 'Training', PRACTICE: 'Practice', RETAKE: 'Retake', REMEDIATION: 'Skill remediation' };

class BulkError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

async function bulkAssign(actor, allowedIds, input) {
  const kind = KINDS.includes(input.kind) ? input.kind : null;
  if (!kind) throw new BulkError('Choose what to assign.');
  const requested = [...new Set((Array.isArray(input.employeeIds) ? input.employeeIds : [input.employeeIds]).filter(Boolean).map(String))];
  if (!requested.length) throw new BulkError('Select at least one employee.');
  if (requested.length > 200) throw new BulkError('Select at most 200 employees at a time.');
  const allowed = new Set(allowedIds);
  if (requested.some((id) => !allowed.has(id))) throw new BulkError('You can only assign to employees you manage.', 403);

  const course = await prisma.trainingCourse.findFirst({ where: { id: String(input.courseId || ''), organizationId: actor.organizationId, status: 'PUBLISHED', archivedAt: null }, include: { assessments: { where: { status: 'APPROVED', archivedAt: null }, include: { questions: { select: { skillIdsJson: true } } } } } });
  if (course) course.assessments = course.assessments.filter((a) => a.version === liveVersion(course)); // new assignments always get the version that is in Training
  if (!course) throw new BulkError('Choose an approved training.', 404);
  if (!(await canAssignCourse(actor, course))) throw new BulkError('You are not allowed to assign this training.', 403); // drafts and admin-only training stop here

  const floor = await getSetting(actor.organizationId, 'training.minPassingScore');
  const minimumScore = Number(input.minimumScore || Math.max(floor, course.passingScore));
  const requiredAttempts = Number(input.requiredAttempts || 1);
  if (!Number.isInteger(minimumScore) || minimumScore < floor || minimumScore > 100) throw new BulkError(`The minimum score must be ${floor}–100.`);
  if (!Number.isInteger(requiredAttempts) || requiredAttempts < 1 || requiredAttempts > 20) throw new BulkError('Required attempts must be 1–20.');
  let dueDate = null;
  if (input.dueDate) {
    try { dueDate = require('./trainingDeadline').trainingDeadline(String(input.dueDate), input.dueTime || '23:59'); } catch (err) { throw new BulkError(err.message); }
    if (Number.isNaN(dueDate.getTime()) || dueDate < new Date(Date.now() - 86400000)) throw new BulkError('Enter a due date that is not in the past.');
  }
  const note = String(input.note || '').trim().slice(0, 500) || null;

  let assessment = null;
  if (kind === 'PRACTICE' || kind === 'REMEDIATION') {
    assessment = course.assessments.find((a) => a.id === String(input.assessmentId || '') && JSON.parse(a.configJson || '{}').targetedRetake !== true);
    if (!assessment) throw new BulkError('Choose approved practice that belongs to this training.');
    if (kind === 'REMEDIATION') {
      const skill = await prisma.skill.findFirst({ where: { id: String(input.skillId || ''), organizationId: actor.organizationId } });
      if (!skill) throw new BulkError('Choose the skill to remediate.', 404);
      if (!coversSkill(assessment, skill.name)) throw new BulkError(`That practice does not cover ${skill.name}.`);
    }
  }

  const people = await prisma.profile.findMany({ where: { id: { in: requested }, organizationId: actor.organizationId, status: { in: ['ACTIVE', 'INVITED'] } }, select: { id: true } });
  const targetIds = people.map((p) => p.id);
  if (!targetIds.length) throw new BulkError('None of the selected employees can receive assignments.');

  // ---- retakes re-open the latest attempt of an existing assignment (history of scores is untouched)
  if (kind === 'RETAKE') {
    const recipients = await prisma.trainingAssignmentRecipient.findMany({ where: { profileId: { in: targetIds }, assignment: { courseId: course.id } }, include: { attempts: { orderBy: { attemptNumber: 'desc' }, take: 1 } } });
    const ready = recipients.filter((r) => r.attempts[0]);
    for (const r of ready) await prisma.trainingAttempt.update({ where: { id: r.attempts[0].id }, data: { status: 'RETAKE_REQUIRED', retakeRequestedById: actor.id, retakeRequestedAt: new Date() } });
    await trainingEmails.queueAgain(ready.map(r => r.id));
    trainingEmails.kick();
    await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'training.bulk_retake', targetTable: 'TrainingCourse', targetId: course.id, metadata: { requested: targetIds.length, retakes: ready.length } });
    await createNotificationForMany(ready.map((r) => r.profileId), { type: 'training.retake_requested', title: 'Retake requested', body: `A retake of "${course.title}" was requested.`, link: '/training' });
    return { kind, created: ready.length, skipped: targetIds.length - ready.length, assignmentId: null, course };
  }

  // ---- everything else: one assignment, one tracked recipient per employee (skipping people who already have this open)
  const existing = await prisma.trainingAssignmentRecipient.findMany({
    where: { profileId: { in: targetIds }, assignment: { courseId: course.id, assessmentId: assessment ? assessment.id : null } },
    include: { attempts: { select: { status: true, attemptNumber: true }, orderBy: { attemptNumber: 'desc' }, take: 1 } },
  });
  const open = new Set(existing.filter((r) => !r.attempts[0] || r.attempts[0].status !== 'COMPLETED').map((r) => r.profileId));
  const recipients = targetIds.filter((id) => !open.has(id));
  if (!recipients.length) return { kind, created: 0, skipped: targetIds.length, assignmentId: null, course };

  const assignment = await prisma.$transaction(async (tx) => {
    const created = await tx.trainingAssignment.create({ data: { organizationId: actor.organizationId, courseId: course.id, courseVersion: liveVersion(course), assignedById: actor.id, scope: 'INDIVIDUAL', dueDate, notes: note, assessmentId: assessment ? assessment.id : null, requiredAttempts, minimumScore } });
    for (const profileId of recipients) {
      const recipient = await tx.trainingAssignmentRecipient.create({ data: { assignmentId: created.id, profileId } });
      await tx.trainingAttempt.create({ data: { recipientId: recipient.id, profileId, status: 'NOT_STARTED', attemptNumber: 1 } });
      await trainingEmails.enqueueAssignment(tx, recipient.id);
    }
    return created;
  });
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'training.bulk_assigned', targetTable: 'TrainingCourse', targetId: course.id, metadata: { kind, recipients: recipients.length, skipped: targetIds.length - recipients.length, assessmentId: assessment ? assessment.id : null, skillId: kind === 'REMEDIATION' ? String(input.skillId) : null, assignmentId: assignment.id } });
  await createNotificationForMany(recipients, { type: 'training.assigned', title: kind === 'COURSE' ? 'New training assigned' : 'Practice assigned', body: assessment ? `"${assessment.title}" was assigned to you${dueDate ? ` (due ${dueDate.toISOString().slice(0, 10)})` : ''}.` : `"${course.title}" was assigned to you.`, link: '/training' });
  trainingEmails.kick();
  return { kind, created: recipients.length, skipped: targetIds.length - recipients.length, assignmentId: assignment.id, course };
}

module.exports = { bulkAssign, BulkError, KINDS, KIND_LABEL };
