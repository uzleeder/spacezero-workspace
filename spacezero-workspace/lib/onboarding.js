'use strict';

// Role-based onboarding: when an employee is created (or changes role) their ROLE decides what they need —
//   * setup requirements already apply by role (Settings -> Setup requirements, audience "Roles");
//   * mandatory onboarding training: every published training an Admin marked "assign to new employees"
//     (for one role, or for every role) is assigned to them, due N days after their start date.
// Nothing is configured per person. Idempotent: someone who already has that training is skipped, so running
// it again (the daily automation does, as a safety net) never duplicates an assignment.
const { prisma } = require('./prisma');
const trainingEmails = require('./trainingEmails');
const { getSetting } = require('./orgSettings');
const { logAudit } = require('./audit');
const { notifyOnce } = require('./notifications');
const { liveVersion } = require('./courseVersions');

const DAY_MS = 86400000;

/** Assigns the onboarding training that applies to this person. Returns the titles that were newly assigned. */
async function applyOnboarding(profile, { actorId = null } = {}) {
  if (!profile || !['TRAVEL_AGENT', 'FLIGHT_EXPERT', 'SUPERVISOR'].includes(profile.role) || !['ACTIVE', 'INVITED'].includes(profile.status)) return [];
  const courses = await prisma.trainingCourse.findMany({
    where: { organizationId: profile.organizationId, status: 'PUBLISHED', archivedAt: null, onboardingForNewHires: true, OR: [{ roleKey: null }, { roleKey: profile.role }] },
    select: { id: true, title: true, passingScore: true, createdById: true, publishedVersion: true },
  });
  if (!courses.length) return [];
  const [floor, dueDays] = await Promise.all([getSetting(profile.organizationId, 'training.minPassingScore'), getSetting(profile.organizationId, 'onboarding.dueDays')]);
  const dueDate = new Date(new Date(profile.employmentStartDate).getTime() + dueDays * DAY_MS);
  const assigned = [];
  for (const course of courses) {
    const has = await prisma.trainingAssignmentRecipient.findFirst({ where: { profileId: profile.id, assignment: { courseId: course.id } }, select: { id: true } });
    if (has) continue;
    const assignment = await prisma.$transaction(async (tx) => {
      const a = await tx.trainingAssignment.create({ data: { organizationId: profile.organizationId, courseId: course.id, courseVersion: liveVersion(course), assignedById: actorId || course.createdById, scope: 'INDIVIDUAL', dueDate, notes: 'Onboarding for the role', minimumScore: Math.max(floor, course.passingScore) } });
      const r = await tx.trainingAssignmentRecipient.create({ data: { assignmentId: a.id, profileId: profile.id } });
      await tx.trainingAttempt.create({ data: { recipientId: r.id, profileId: profile.id, status: 'NOT_STARTED', attemptNumber: 1 } });
      await trainingEmails.enqueueAssignment(tx, r.id);
      return a;
    });
    assigned.push(course.title);
    await notifyOnce(profile.id, `onboarding:${course.id}`, { type: 'training.assigned', title: 'Onboarding training assigned', body: `"${course.title}" is part of your onboarding (due ${dueDate.toISOString().slice(0, 10)}).`, link: '/training' });
    await logAudit({ organizationId: profile.organizationId, actorId, action: 'onboarding.training_assigned', targetTable: 'TrainingAssignment', targetId: assignment.id, metadata: { employeeId: profile.id, courseId: course.id, role: profile.role } });
  }
  trainingEmails.kick();
  return assigned;
}

/** Safety net for the automation: recent joiners who somehow have not been given their onboarding training. */
async function runOnboarding(organizationId, { now = new Date() } = {}) {
  const recent = await prisma.profile.findMany({ where: { organizationId, status: { in: ['ACTIVE', 'INVITED'] }, employmentStartDate: { gte: new Date(now.getTime() - 60 * DAY_MS) }, testOwnerAdminId: null } });
  let assigned = 0;
  for (const p of recent) assigned += (await applyOnboarding(p)).length;
  return assigned;
}

module.exports = { applyOnboarding, runOnboarding };
