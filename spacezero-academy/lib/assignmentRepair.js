'use strict';

// An assignment can be made for ONE practice of a training ("Specific practice" on the assign form). When that practice is
// later replaced (the practice was regenerated in AI Practice, archived, or is no longer approved for the assigned
// version) the assignment still points at it: the learner finishes the material and the practice list stays empty - the
// quiz never appears and nothing on the page says why. An assignment whose one practice is gone is a whole-training
// assignment again: the learner is given the training's own practice of that version.
const { prisma } = require('./prisma');

/**
 * Turns "this one practice" assignments of a course whose practice can no longer be opened into whole-training
 * assignments. Returns how many were repaired. Safe to call at any time and as often as wanted.
 */
async function healDanglingPractices(courseId) {
  const pinned = await prisma.trainingAssignment.findMany({ where: { courseId, assessmentId: { not: null } }, select: { id: true, assessmentId: true, courseVersion: true } });
  if (!pinned.length) return 0;
  const usable = await prisma.assessment.findMany({ where: { id: { in: [...new Set(pinned.map((a) => a.assessmentId))] }, courseId, status: 'APPROVED', archivedAt: null }, select: { id: true, version: true } });
  const versionOf = new Map(usable.map((a) => [a.id, a.version]));
  const dangling = pinned.filter((a) => versionOf.get(a.assessmentId) !== a.courseVersion).map((a) => a.id);
  if (!dangling.length) return 0;
  const result = await prisma.trainingAssignment.updateMany({ where: { id: { in: dangling } }, data: { assessmentId: null } });
  return result.count;
}

module.exports = { healDanglingPractices };
