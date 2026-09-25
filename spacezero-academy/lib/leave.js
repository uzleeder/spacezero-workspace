'use strict';

// Vacation / leave helpers. Deliberately NOT payroll/HR: whole calendar days, simple statuses.
const { prisma } = require('./prisma');
const { supervisedProfileIds } = require('./authz');

const LEAVE_TYPES = ['VACATION', 'SICK', 'PERSONAL', 'UNPAID', 'OTHER'];
const TYPE_LABEL = { VACATION: 'Vacation', SICK: 'Sick leave', PERSONAL: 'Personal', UNPAID: 'Unpaid', OTHER: 'Other' };
const STATUS_LABEL = { PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected', CANCELLED: 'Cancelled' };
const MAX_SPAN_DAYS = 120;
const DAY_MS = 86400000;

function parseDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : d;
}

const daysInclusive = (start, end) => Math.round((end - start) / DAY_MS) + 1;
const isoDay = (d) => d.toISOString().slice(0, 10);

function validateLeaveInput({ leaveType, startDate, endDate, note }, now = new Date()) {
  const errors = [];
  const start = parseDay(startDate);
  const end = parseDay(endDate);
  if (!LEAVE_TYPES.includes(leaveType)) errors.push('Choose a leave type.');
  if (!start || !end) errors.push('Enter a valid start and end date.');
  else {
    if (end < start) errors.push('The end date cannot be before the start date.');
    const today = parseDay(isoDay(now));
    if (start < new Date(today.getTime() - 7 * DAY_MS)) errors.push('The start date cannot be more than a week in the past.');
    if (end >= start && daysInclusive(start, end) > MAX_SPAN_DAYS) errors.push(`A single request cannot exceed ${MAX_SPAN_DAYS} days.`);
  }
  if (String(note || '').length > 1000) errors.push('The note is too long.');
  return { errors, start, end, days: start && end && end >= start ? daysInclusive(start, end) : 0 };
}

/** Prisma `where` for the leave requests an actor may see in the management overview. */
async function visibleLeaveWhere(actor) {
  if (actor.role === 'ADMIN') {
    return { organizationId: actor.organizationId, profile: { OR: [{ testOwnerAdminId: null }, { testOwnerAdminId: actor.id }] }, NOT: { profileId: actor.id } };
  }
  if (actor.role === 'SUPERVISOR') {
    const ids = (await supervisedProfileIds(actor.id)).filter((id) => id !== actor.id);
    return { organizationId: actor.organizationId, profileId: { in: ids } };
  }
  return { organizationId: actor.organizationId, id: '__none__' };
}

/** May this actor review (decide/recommend) this request? Never one's own. */
async function canReviewLeave(actor, request) {
  if (!actor || actor.organizationId !== request.organizationId || actor.id === request.profileId) return false;
  if (actor.role === 'ADMIN') {
    const target = await prisma.profile.findUnique({ where: { id: request.profileId }, select: { testOwnerAdminId: true } });
    return !target?.testOwnerAdminId || target.testOwnerAdminId === actor.id;
  }
  if (actor.role === 'SUPERVISOR') return (await supervisedProfileIds(actor.id)).includes(request.profileId);
  return false;
}

/** Informational only: other employees on the same team with APPROVED leave overlapping this one. */
async function overlappingApprovedLeave(request) {
  if (!request.teamId) return [];
  const teammates = await prisma.teamMembership.findMany({ where: { teamId: request.teamId, profileId: { not: request.profileId } }, select: { profileId: true } });
  if (!teammates.length) return [];
  return prisma.leaveRequest.findMany({
    where: { organizationId: request.organizationId, profileId: { in: teammates.map((t) => t.profileId) }, status: 'APPROVED', startDate: { lte: request.endDate }, endDate: { gte: request.startDate } },
    include: { profile: { select: { fullName: true } } },
    orderBy: { startDate: 'asc' },
  });
}

/** Builds a month grid (weeks of 7 day cells) with the requests active on each day. */
function buildCalendar(month, requests) {
  const first = parseDay(`${month}-01`);
  if (!first) return null;
  const startOffset = (first.getUTCDay() + 6) % 7; // Monday first
  const gridStart = new Date(first.getTime() - startOffset * DAY_MS);
  const weeks = [];
  for (let w = 0; w < 6; w++) {
    const days = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(gridStart.getTime() + (w * 7 + d) * DAY_MS);
      days.push({
        date,
        iso: isoDay(date),
        inMonth: date.getUTCMonth() === first.getUTCMonth(),
        entries: requests.filter((r) => ['APPROVED', 'PENDING'].includes(r.status) && r.startDate <= date && r.endDate >= date),
      });
    }
    if (w >= 4 && days.every((c) => !c.inMonth)) break;
    weeks.push(days);
  }
  return { first, weeks };
}

module.exports = { LEAVE_TYPES, TYPE_LABEL, STATUS_LABEL, MAX_SPAN_DAYS, parseDay, isoDay, daysInclusive, validateLeaveInput, visibleLeaveWhere, canReviewLeave, overlappingApprovedLeave, buildCalendar };
