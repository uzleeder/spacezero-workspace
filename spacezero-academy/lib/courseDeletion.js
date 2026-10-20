'use strict';

// An Admin may delete ANY training, however far it got. (The Supervisor-facing AI Practice "delete if unused"
// rule in lib/courseVersions.js#deletionPolicy is unchanged.) Everything that belongs to the training goes with
// it: its assignments (so it leaves everyone's My Training), their attempts and queued emails, the practice /
// quizzes and versions, the material and its files. What an employee already earned stays: certificates and
// skill evidence are not tied to the course by a foreign key, so they are untouched.
const { prisma } = require('./prisma');
const { releaseFile } = require('./sourceFiles');
const { logAudit } = require('./audit');

/** What deleting this training will remove (shown before the Admin confirms, and written to the audit log). */
async function deletionImpact(course) {
  const assessmentIds = (await prisma.assessment.findMany({ where: { courseId: course.id }, select: { id: true } })).map((a) => a.id);
  const [assignments, recipients, attempts, modules, certificates] = await Promise.all([
    prisma.trainingAssignment.count({ where: { courseId: course.id } }),
    prisma.trainingAssignmentRecipient.count({ where: { assignment: { courseId: course.id } } }),
    prisma.trainingAttempt.count({ where: { OR: [{ recipient: { assignment: { courseId: course.id } } }, { assessmentId: { in: assessmentIds } }] } }),
    prisma.trainingModule.count({ where: { courseId: course.id } }),
    prisma.certificate.count({ where: { courseId: course.id } }),
  ]);
  return { assignments, recipients, attempts, modules, certificates, assessments: assessmentIds.length };
}

/**
 * Who may delete which training. An Admin: any training of the organization. A Supervisor: only a training they
 * created themselves, and only while every assignment of it was made by them - they can never remove something the
 * Admin (or another Supervisor) assigned to other people. Returns the ids of `courses` the actor may delete.
 */
async function deletableCourseIds(actor, courses) {
  const mine = courses.filter((c) => c.organizationId === actor.organizationId);
  if (actor.role === 'ADMIN') return new Set(mine.map((c) => c.id));
  if (actor.role !== 'SUPERVISOR') return new Set();
  const own = mine.filter((c) => c.createdById === actor.id);
  if (!own.length) return new Set();
  const others = await prisma.trainingAssignment.findMany({ where: { courseId: { in: own.map((c) => c.id) }, assignedById: { not: actor.id } }, select: { courseId: true } });
  const blocked = new Set(others.map((a) => a.courseId));
  return new Set(own.filter((c) => !blocked.has(c.id)).map((c) => c.id));
}

async function mayDeleteCourse(actor, course) {
  return (await deletableCourseIds(actor, [course])).has(course.id);
}

async function deleteCourse(actor, course) {
  const impact = await deletionImpact(course);
  const assessmentIds = (await prisma.assessment.findMany({ where: { courseId: course.id }, select: { id: true } })).map((a) => a.id);
  const modules = await prisma.trainingModule.findMany({ where: { courseId: course.id }, select: { storagePath: true } });
  await prisma.$transaction([
    prisma.practiceSession.deleteMany({ where: { assessmentId: { in: assessmentIds } } }),
    prisma.aiTask.deleteMany({ where: { courseId: course.id } }),
    prisma.trainingCourse.delete({ where: { id: course.id } }), // cascades assignments, recipients, attempts, assessments, modules, versions
  ]);
  for (const m of modules) await releaseFile(m.storagePath);
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'training.course_deleted', targetTable: 'TrainingCourse', targetId: course.id, metadata: { title: course.title, ...impact } });
  return impact;
}

module.exports = { deletionImpact, deleteCourse, deletableCourseIds, mayDeleteCourse };
