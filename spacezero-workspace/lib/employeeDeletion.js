'use strict';

// Admin: remove a person either by ARCHIVING (kept, hidden, can be restored) or by DELETING them for good.
//
// A permanent delete removes the account and everything that belongs to the person: sign-in sessions, training
// they were assigned and their attempts, certificates, skills and evidence, setup answers, Credential Vault
// entries, notes about them, leave requests, notifications, personal files. What they CREATED for the company is
// not destroyed with them: trainings, assessments, assignments they made to others, library items, call uploads,
// teams, standards and similar are handed to the Admin who deletes them (the audit log records the transfer), so
// nobody else loses training because a Supervisor or creator left. The audit trail itself is kept (the actor is just
// blanked by the database).
const { prisma } = require('./prisma');
const { releaseFile } = require('./sourceFiles');
const { logAudit } = require('./audit');

/** Why this person cannot be deleted by this Admin (null = may delete). Archiving has no such limits. */
async function deleteBlocker(actor, target) {
  if (!target || target.organizationId !== actor.organizationId) return 'This person was not found.';
  if (target.id === actor.id) return 'You cannot delete your own account.';
  if (target.role === 'ADMIN') {
    const others = await prisma.profile.count({ where: { organizationId: actor.organizationId, role: 'ADMIN', status: 'ACTIVE', id: { not: target.id }, testOwnerAdminId: null } });
    if (!others) return 'This is the last active Administrator. Make someone else an Administrator first.';
  }
  return null;
}

/** What a permanent delete would remove or hand over (shown before the Admin chooses). */
async function deletionImpact(target) {
  const id = target.id;
  const [trainings, attempts, certificates, credentials, notesAbout, leave, skills, agents, createdTrainings, createdAssignments, testProfiles] = await Promise.all([
    prisma.trainingAssignmentRecipient.count({ where: { profileId: id } }),
    prisma.trainingAttempt.count({ where: { profileId: id } }),
    prisma.certificate.count({ where: { profileId: id } }),
    prisma.credential.count({ where: { ownerId: id } }),
    prisma.coachingNote.count({ where: { profileId: id } }),
    prisma.leaveRequest.count({ where: { profileId: id } }),
    prisma.employeeSkill.count({ where: { profileId: id } }),
    prisma.supervisorAssignment.count({ where: { supervisorId: id, unassignedAt: null } }),
    prisma.trainingCourse.count({ where: { createdById: id } }),
    prisma.trainingAssignment.count({ where: { assignedById: id } }),
    prisma.profile.count({ where: { testOwnerAdminId: id } }),
  ]);
  return { trainings, attempts, certificates, credentials, notesAbout, leave, skills, agents, createdTrainings, createdAssignments, testProfiles };
}

// Everything the person made for the company moves to `actorId`. Only attributions move: no content is lost.
async function handOver(tx, fromId, actorId) {
  const where = (field) => ({ where: { [field]: fromId }, data: { [field]: actorId } });
  await tx.trainingCourse.updateMany(where('createdById'));
  await tx.trainingAssignment.updateMany(where('assignedById'));
  await tx.assessment.updateMany(where('createdById'));
  await tx.callBatch.updateMany(where('uploadedById'));
  await tx.libraryItem.updateMany(where('createdById'));
  await tx.team.updateMany(where('createdById'));
  await tx.standardsItem.updateMany(where('createdById'));
  await tx.standardsVersion.updateMany(where('createdById'));
  await tx.developmentPath.updateMany(where('createdById'));
  await tx.certificationDefinition.updateMany(where('createdById'));
  await tx.setupRequirementTarget.updateMany(where('createdById'));
  // notes and call reviews they wrote ABOUT other people stay with those people
  await tx.coachingNote.updateMany({ where: { authorId: fromId, profileId: { not: fromId } }, data: { authorId: actorId } });
  await tx.callReview.updateMany({ where: { supervisorId: fromId, agentId: { not: fromId } }, data: { supervisorId: actorId } });
}

async function deleteOne(actor, target, summary) {
  const materials = await prisma.practiceMaterial.findMany({ where: { profileId: target.id }, select: { storagePath: true } });
  await prisma.$transaction(async (tx) => {
    await handOver(tx, target.id, actor.id);
    await tx.practiceSession.deleteMany({ where: { profileId: target.id } }); // not tied to the account by the database
    await tx.profile.delete({ where: { id: target.id } }); // cascades their own records
  });
  for (const m of materials) await releaseFile(m.storagePath);
  summary.deleted.push({ id: target.id, fullName: target.fullName, username: target.username, role: target.role });
}

/** Permanently deletes `target` (and an Admin's private test profiles). The caller has already checked deleteBlocker. */
async function deleteEmployee(actor, target) {
  const impact = await deletionImpact(target);
  const summary = { deleted: [] };
  const testProfiles = await prisma.profile.findMany({ where: { testOwnerAdminId: target.id, organizationId: actor.organizationId } });
  for (const t of testProfiles) await deleteOne(actor, t, summary);
  await deleteOne(actor, target, summary);
  await logAudit({
    organizationId: actor.organizationId, actorId: actor.id, action: 'employee.deleted', targetTable: 'Profile', targetId: target.id,
    metadata: { fullName: target.fullName, username: target.username, email: target.email, role: target.role, status: target.status, testProfilesDeleted: testProfiles.length, ...impact },
  });
  return impact;
}

module.exports = { deleteBlocker, deletionImpact, deleteEmployee };
