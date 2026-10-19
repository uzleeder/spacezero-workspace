'use strict';

// Training permissions (spec section 8). Approved trainings live in the Training catalog. Admin
// always may assign. A Supervisor may assign a training only if the Admin allows it
// (assignPolicy) — and even then only to employees inside that supervisor's own scope, which the
// assignment routes enforce separately. Being able to SEE a training never implies being able to
// ASSIGN it. A supervisor always keeps the right to assign trainings they authored themselves.
const { prisma } = require('./prisma');

const POLICIES = ['ADMIN_ONLY', 'SELECTED_SUPERVISORS', 'ALL_SUPERVISORS'];
const POLICY_LABEL = {
  ADMIN_ONLY: 'Admin only',
  SELECTED_SUPERVISORS: 'Selected supervisors',
  ALL_SUPERVISORS: 'All supervisors',
};

/** Prisma `where` for the published courses an actor may assign. */
function assignableCoursesWhere(actor) {
  const base = { organizationId: actor.organizationId, status: 'PUBLISHED', archivedAt: null };
  if (actor.role === 'ADMIN') return base;
  if (actor.role !== 'SUPERVISOR') return { ...base, id: '__none__' };
  return {
    ...base,
    OR: [
      { createdById: actor.id },
      { assignPolicy: 'ALL_SUPERVISORS' },
      { assignPolicy: 'SELECTED_SUPERVISORS', assignGrants: { some: { supervisorId: actor.id } } },
    ],
  };
}

/** Synchronous variant for a course loaded with `assignGrants: { select: { supervisorId } }`. */
function mayAssign(actor, course) {
  if (course.status !== 'PUBLISHED' || course.archivedAt || course.organizationId !== actor.organizationId) return false;
  if (actor.role === 'ADMIN') return true;
  if (actor.role !== 'SUPERVISOR') return false;
  if (course.createdById === actor.id || course.assignPolicy === 'ALL_SUPERVISORS') return true;
  return course.assignPolicy === 'SELECTED_SUPERVISORS' && (course.assignGrants || []).some((g) => g.supervisorId === actor.id);
}

async function canAssignCourse(actor, course) {
  if (!actor || !course || course.organizationId !== actor.organizationId) return false;
  if (course.status !== 'PUBLISHED' || course.archivedAt) return false; // AI Practice drafts are never assignable
  return Boolean(await prisma.trainingCourse.findFirst({ where: { ...assignableCoursesWhere(actor), id: course.id }, select: { id: true } }));
}

module.exports = { POLICIES, POLICY_LABEL, assignableCoursesWhere, canAssignCourse, mayAssign };
