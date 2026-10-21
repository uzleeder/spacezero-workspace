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

/** Storage paths of the voice recordings (answers and unsent drafts) that belong to this training's practice. */
async function voiceFilesOf(courseId, assessmentIds) {
  const paths = new Set();
  const take = (json, pick) => { try { const p = pick(JSON.parse(json || 'null')); if (typeof p === 'string' && p) paths.add(p); } catch { /* not JSON: nothing to remove */ } };
  const attempts = await prisma.trainingAttempt.findMany({ where: { OR: [{ recipient: { assignment: { courseId } } }, { assessmentId: { in: assessmentIds } }], answersJson: { contains: 'storagePath' } }, select: { answersJson: true } });
  for (const a of attempts) take(a.answersJson, (v) => v && v.recording && v.recording.storagePath);
  const sessions = await prisma.practiceSession.findMany({ where: { assessmentId: { in: assessmentIds }, dataJson: { contains: 'storagePath' } }, select: { dataJson: true } });
  for (const s of sessions) take(s.dataJson, (v) => v && v.draft && v.draft.storagePath);
  return [...paths];
}

async function deleteCourse(actor, course) {
  const impact = await deletionImpact(course);
  const assessmentIds = (await prisma.assessment.findMany({ where: { courseId: course.id }, select: { id: true } })).map((a) => a.id);
  const modules = await prisma.trainingModule.findMany({ where: { courseId: course.id }, select: { storagePath: true } });
  // Voice-practice recordings (kept on disk, only pointed at from the attempt / the open session) go with the attempts:
  // otherwise they would stay on the server with nothing left that refers to them.
  const recordings = await voiceFilesOf(course.id, assessmentIds);
  // The attempts themselves go, but the log keeps who had how many and their best score, so the loss can be traced afterwards.
  const history = await prisma.trainingAttempt.groupBy({ by: ['profileId'], where: { OR: [{ recipient: { assignment: { courseId: course.id } } }, { assessmentId: { in: assessmentIds } }] }, _count: { _all: true }, _max: { score: true } });
  const attemptsByPerson = history.slice(0, 300).map((h) => ({ profileId: h.profileId, attempts: h._count._all, bestScore: h._max.score }));
  await prisma.$transaction([
    prisma.practiceSession.deleteMany({ where: { assessmentId: { in: assessmentIds } } }),
    prisma.aiTask.deleteMany({ where: { courseId: course.id } }),
    prisma.trainingCourse.delete({ where: { id: course.id } }), // cascades assignments, recipients, attempts, assessments, modules, versions
  ]);
  for (const m of modules) await releaseFile(m.storagePath);
  for (const path of recordings) await require('node:fs/promises').unlink(require('./storage').resolveStoragePath(path)).catch(() => undefined);
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'training.course_deleted', targetTable: 'TrainingCourse', targetId: course.id, metadata: { title: course.title, ...impact, attemptsByPerson } });
  return impact;
}

module.exports = { deletionImpact, deleteCourse, deletableCourseIds, mayDeleteCourse };
