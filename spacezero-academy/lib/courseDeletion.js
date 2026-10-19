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

module.exports = { deletionImpact, deleteCourse };
