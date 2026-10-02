'use strict';

// Vacation / leave requests. Employees request and cancel their own; Supervisors see and review
// (recommend, or decide if the org policy allows) only their assigned team; Admins see everyone.
const router = require('express').Router();
const { prisma } = require('../lib/prisma');
const { requireSession, requireRole } = require('../lib/authMiddleware');
const { loadEmployeeFor, credentialAccess } = require('../lib/employeeAccess');
const { employeeTabs } = require('../lib/employeeTabs');
const { canViewSetupTab } = require('../lib/supervisorCapabilities');
const { getSetting } = require('../lib/orgSettings');
const { createNotification, createNotificationForMany } = require('../lib/notifications');
const { logAudit } = require('../lib/audit');
const { roleLabel } = require('../lib/roles');
const leave = require('../lib/leave');

const manage = requireRole('ADMIN', 'SUPERVISOR');
const notFound = (res) => res.status(404).render('not-found', { layout: false });

router.get('/my/leave', requireSession, (req, res) => res.redirect(`/employees/${req.profile.id}/leave`));

async function renderEmployeeLeave(req, res, ctx, extra = {}) {
  const requests = await prisma.leaveRequest.findMany({ where: { profileId: ctx.employee.id }, orderBy: { startDate: 'desc' }, include: { reviewedBy: { select: { fullName: true } } } });
  const [access, canViewSetup] = await Promise.all([
    credentialAccess(req.profile, ctx.employee, { impersonating: Boolean(req.impersonation) }),
    canViewSetupTab(req.profile, ctx), // a Supervisor without setup.view must not be offered a Setup tab that 403s
  ]);
  res.render('employee/leave', {
    title: `${ctx.employee.fullName} — Vacation / Leave`,
    tabs: employeeTabs(req.profile, ctx, { credentials: access.view || access.manage, canViewSetup }),
    employee: ctx.employee,
    isSelf: ctx.isSelf,
    roleLabel,
    requests,
    leave,
    canReview: !ctx.isSelf && (req.profile.role === 'ADMIN' || req.profile.role === 'SUPERVISOR'),
    error: null,
    saved: false,
    values: {},
    ...extra,
  });
}

router.get('/employees/:id/leave', requireSession, async (req, res) => {
  const ctx = await loadEmployeeFor(req.profile, req.params.id);
  if (!ctx) return notFound(res);
  await renderEmployeeLeave(req, res, ctx, { saved: req.query.saved === '1' });
});

router.post('/employees/:id/leave', requireSession, async (req, res) => {
  const actor = req.profile;
  // Only the employee can file their own request — nobody files leave on someone else's behalf.
  if (req.params.id !== actor.id) return res.status(403).render('forbidden');
  const ctx = await loadEmployeeFor(actor, actor.id);
  if (!ctx) return notFound(res);

  const input = { leaveType: String(req.body.leaveType || ''), startDate: req.body.startDate, endDate: req.body.endDate, note: String(req.body.note || '').trim() };
  const checked = leave.validateLeaveInput(input);
  if (!checked.errors.length) {
    const clash = await prisma.leaveRequest.findFirst({ where: { profileId: actor.id, status: { in: ['PENDING', 'APPROVED'] }, startDate: { lte: checked.end }, endDate: { gte: checked.start } } });
    if (clash) checked.errors.push('You already have a pending or approved request overlapping these dates.');
  }
  if (checked.errors.length) return renderEmployeeLeave(req, res, ctx, { error: checked.errors.join(' '), values: input });

  const supervisorLink = ctx.employee.supervisedBy[0];
  const request = await prisma.leaveRequest.create({
    data: {
      organizationId: actor.organizationId,
      profileId: actor.id,
      teamId: ctx.employee.teamMemberships[0]?.teamId || null,
      supervisorId: supervisorLink ? supervisorLink.supervisorId : null,
      leaveType: input.leaveType,
      startDate: checked.start,
      endDate: checked.end,
      days: checked.days,
      note: input.note || null,
    },
  });
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'leave.requested', targetTable: 'LeaveRequest', targetId: request.id, metadata: { days: checked.days, type: input.leaveType } });

  const admins = await prisma.profile.findMany({ where: { organizationId: actor.organizationId, role: 'ADMIN', status: 'ACTIVE', testOwnerAdminId: null, NOT: { id: actor.id } }, select: { id: true } });
  const recipients = [...new Set([...admins.map((a) => a.id), ...(request.supervisorId ? [request.supervisorId] : [])])];
  await createNotificationForMany(recipients, { type: 'leave.requested', title: 'New leave request', body: `${actor.fullName} requested ${checked.days} day(s) of leave.`, link: `/leave/${request.id}` });
  res.redirect(`/employees/${actor.id}/leave?saved=1`);
});

router.post('/leave/:id/cancel', requireSession, async (req, res) => {
  const actor = req.profile;
  const request = await prisma.leaveRequest.findFirst({ where: { id: req.params.id, profileId: actor.id } });
  if (!request) return notFound(res);
  if (request.status !== 'PENDING') return res.status(409).send('Only pending requests can be cancelled.');
  await prisma.leaveRequest.update({ where: { id: request.id }, data: { status: 'CANCELLED' } });
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'leave.cancelled', targetTable: 'LeaveRequest', targetId: request.id });
  res.redirect(`/employees/${actor.id}/leave?saved=1`);
});

// ---------------------------------------------------------------------------
// Management overview: list + calendar, scoped server-side by role.
// ---------------------------------------------------------------------------
router.get('/leave', manage, async (req, res) => {
  const actor = req.profile;
  const scope = await leave.visibleLeaveWhere(actor);
  const { status, teamId, supervisorId, profileId } = req.query;
  const from = leave.parseDay(req.query.from);
  const to = leave.parseDay(req.query.to);
  const view = req.query.view === 'calendar' ? 'calendar' : 'list';
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? req.query.month : leave.isoDay(new Date()).slice(0, 7);

  const where = { ...scope };
  if (status && leave.STATUS_LABEL[status]) where.status = status;
  if (teamId) where.teamId = String(teamId);
  if (supervisorId) where.supervisorId = String(supervisorId);
  if (profileId) where.AND = [{ profileId: String(profileId) }];
  if (from) where.endDate = { gte: from };
  if (to) where.startDate = { lte: to };
  if (view === 'calendar') {
    const first = leave.parseDay(`${month}-01`);
    where.startDate = { lte: new Date(first.getTime() + 42 * 86400000) };
    where.endDate = { gte: new Date(first.getTime() - 7 * 86400000) };
  }

  const requests = await prisma.leaveRequest.findMany({ where, include: { profile: { select: { id: true, fullName: true } }, reviewedBy: { select: { fullName: true } } }, orderBy: { startDate: 'desc' }, take: 300 });
  const [teams, supervisors, people, pendingCount] = await Promise.all([
    prisma.team.findMany({ where: { organizationId: actor.organizationId, archivedAt: null }, orderBy: { name: 'asc' } }),
    actor.role === 'ADMIN' ? prisma.profile.findMany({ where: { organizationId: actor.organizationId, role: 'SUPERVISOR', status: 'ACTIVE' }, orderBy: { fullName: 'asc' } }) : [],
    prisma.profile.findMany({ where: { organizationId: actor.organizationId, id: { in: [...new Set((await prisma.leaveRequest.findMany({ where: scope, select: { profileId: true } })).map((r) => r.profileId))] } }, orderBy: { fullName: 'asc' }, select: { id: true, fullName: true } }),
    prisma.leaveRequest.count({ where: { ...scope, status: 'PENDING' } }),
  ]);

  res.render('leave/index', {
    title: 'Vacation Overview',
    requests,
    teams,
    supervisors,
    people,
    pendingCount,
    view,
    month,
    calendar: view === 'calendar' ? leave.buildCalendar(month, requests) : null,
    filters: { status: status || '', teamId: teamId || '', supervisorId: supervisorId || '', profileId: profileId || '', from: req.query.from || '', to: req.query.to || '' },
    leave,
    tabsFor: actor.role,
  });
});

async function loadReviewable(actor, id) {
  const request = await prisma.leaveRequest.findFirst({ where: { id, organizationId: actor.organizationId }, include: { profile: { select: { id: true, fullName: true, role: true } }, reviewedBy: { select: { fullName: true } } } });
  if (!request) return { request: null, allowed: false };
  return { request, allowed: await leave.canReviewLeave(actor, request) };
}

router.get('/leave/:id', manage, async (req, res) => {
  const actor = req.profile;
  const { request, allowed } = await loadReviewable(actor, req.params.id);
  if (!request || !allowed) return notFound(res); // outside the actor's team scope: indistinguishable from missing
  const [overlaps, finalApproval] = await Promise.all([leave.overlappingApprovedLeave(request), getSetting(actor.organizationId, 'leave.supervisorFinalApproval')]);
  res.render('leave/detail', { title: 'Leave request', request, overlaps, leave, canDecide: actor.role === 'ADMIN' || finalApproval, error: null });
});

router.post('/leave/:id/review', manage, async (req, res) => {
  const actor = req.profile;
  const { request, allowed } = await loadReviewable(actor, req.params.id);
  if (!request || !allowed) return notFound(res);
  if (request.status !== 'PENDING') return res.status(409).send('This request has already been decided.');

  const action = String(req.body.action || '');
  const note = String(req.body.note || '').trim().slice(0, 1000) || null;
  const finalApproval = await getSetting(actor.organizationId, 'leave.supervisorFinalApproval');
  const canDecide = actor.role === 'ADMIN' || finalApproval;

  if (['approve', 'reject'].includes(action)) {
    if (!canDecide) return res.status(403).render('forbidden');
    const status = action === 'approve' ? 'APPROVED' : 'REJECTED';
    await prisma.leaveRequest.update({ where: { id: request.id }, data: { status, reviewedById: actor.id, reviewedAt: new Date(), managementNote: note } });
    await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: `leave.${status.toLowerCase()}`, targetTable: 'LeaveRequest', targetId: request.id, metadata: { days: request.days } });
    await createNotification({ profileId: request.profileId, type: `leave.${status.toLowerCase()}`, title: `Leave ${status.toLowerCase()}`, body: `Your leave request (${request.days} day(s)) was ${status.toLowerCase()}.`, link: `/employees/${request.profileId}/leave` });
  } else if (['recommend_approve', 'recommend_reject'].includes(action) && actor.role === 'SUPERVISOR') {
    await prisma.leaveRequest.update({ where: { id: request.id }, data: { recommendation: action === 'recommend_approve' ? 'RECOMMEND_APPROVE' : 'RECOMMEND_REJECT', supervisorNote: note, supervisorReviewedById: actor.id, supervisorReviewedAt: new Date() } });
    await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'leave.recommended', targetTable: 'LeaveRequest', targetId: request.id, metadata: { recommendation: action } });
  } else {
    return res.status(400).send('Unsupported action.');
  }
  res.redirect(`/leave/${request.id}`);
});

module.exports = router;
