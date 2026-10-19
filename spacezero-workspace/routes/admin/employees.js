'use strict';

const express = require('express');
const router = express.Router();

const { prisma } = require('../../lib/prisma');
const { parseFilters, whereFor, applyLearningFilters, byReadiness, byPassportStatus } = require('../../lib/employeeFilters');
const { STATUS: PASSPORT_STATUS, STATUS_LABEL: PASSPORT_STATUS_LABEL } = require('../../lib/passport');
const { readinessFor } = require('../../lib/readiness');
const { applyOnboarding } = require('../../lib/onboarding');
const { requireAdmin } = require('../../lib/authMiddleware');
const { EmployeeSchema, EmployeeUpdateSchema } = require('../../lib/validation');
const { generateToken } = require('../../lib/tokens');
const { logAudit } = require('../../lib/audit');
const { createNotification } = require('../../lib/notifications');
const { excludeOtherAdminsTestProfiles } = require('../../lib/loginAsScope');
const { loadSetupForProfiles } = require('../../lib/employeeSetup');
const { tabsForRequest } = require('../../lib/employeeTabs');
const { SETUP_FILTERS, parseSetupQuery, matchesSetup, requirementOptions } = require('../../lib/employeeList');
const { getTrainingSummaries } = require('../../lib/training');
const { employeeWorkbook } = require('../../lib/employeeExport');
const { roleLabel } = require('../../lib/roles');
const { containsText } = require('../../lib/textSearch');
const employeeDeletion = require('../../lib/employeeDeletion');

const { sendAccountEmail, isEmailConfigured } = require('../../lib/mailer');
const { sendReset } = require('../../lib/accountEmail');
const INVITE_TTL_MS = 1000 * 60 * 60 * 24;

function requiresSupervisor(role) {
  return role === 'TRAVEL_AGENT' || role === 'FLIGHT_EXPERT';
}

const STATUS_TONE = { ACTIVE: 'badge-success', INVITED: 'badge-warning', DISABLED: 'badge-danger', ARCHIVED: '' };
const STATUS_LABEL = { ACTIVE: 'Active', INVITED: 'Invited', DISABLED: 'Disabled', ARCHIVED: 'Archived' };

// Active-filter chips for the "More filters" panel — each one just re-links to the same page
// with that one query param removed, so there is no second filter-state to keep in sync.
function buildActiveFilterChips(basePath, query, { teams, supervisors, requirements, SETUP_FILTERS, STATUS_LABEL: statusLabels }) {
  const chips = [];
  const removeHref = (keys) => {
    const params = new URLSearchParams(query);
    keys.forEach((k) => params.delete(k));
    const qs = params.toString();
    return basePath + (qs ? '?' + qs : '');
  };
  if (query.q) chips.push({ label: `Search: "${query.q}"`, href: removeHref(['q']) });
  if (query.role) chips.push({ label: `Role: ${roleLabel(query.role)}`, href: removeHref(['role']) });
  if (query.status) chips.push({ label: `Status: ${statusLabels[query.status] || query.status}`, href: removeHref(['status']) });
  if (query.teamId) { const t = teams.find((x) => x.id === query.teamId); chips.push({ label: `Team: ${t ? t.name : 'Unknown'}`, href: removeHref(['teamId']) }); }
  if (query.supervisorId) { const s = supervisors.find((x) => x.id === query.supervisorId); chips.push({ label: `Supervisor: ${s ? s.fullName : 'Unknown'}`, href: removeHref(['supervisorId']) }); }
  if (query.setup) chips.push({ label: `Setup: ${SETUP_FILTERS[query.setup] || query.setup}`, href: removeHref(['setup']) });
  if (query.missing) { const r = requirements.find((x) => x.key === query.missing); chips.push({ label: `Missing: ${r ? r.label : query.missing}`, href: removeHref(['missing']) }); }
  if (query.trainingStatus) chips.push({ label: `Training: ${String(query.trainingStatus).replace(/_/g, ' ').toLowerCase()}`, href: removeHref(['trainingStatus']) });
  if (query.readiness) chips.push({ label: `Readiness: ${String(query.readiness).replace(/_/g, ' ').toLowerCase()}`, href: removeHref(['readiness']) });
  if (query.passportStatus) chips.push({ label: `Passport: ${String(query.passportStatus).replace(/_/g, ' ').toLowerCase()}`, href: removeHref(['passportStatus']) });
  return chips;
}

router.post('/employees/:id/personal-test-profile', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const target = await prisma.profile.findFirst({ where: {
    id: req.params.id, organizationId: admin.organizationId,
    role: { in: ['SUPERVISOR', 'TRAVEL_AGENT', 'FLIGHT_EXPERT'] },
    OR: [{ testOwnerAdminId: admin.id }, { testOwnerAdminId: null, createdById: admin.id }],
  } });
  if (!target) return res.status(404).send('Not found');
  const testOwnerAdminId = target.testOwnerAdminId ? null : admin.id;
  await prisma.$transaction(async tx => {
    await tx.profile.update({ where: { id: target.id }, data: { testOwnerAdminId } });
    // Revoke prior view-as sessions when this becomes a private test profile.
    if (testOwnerAdminId) await tx.session.deleteMany({ where: { profileId: target.id } });
    await tx.auditLog.create({ data: { organizationId: admin.organizationId, actorId: admin.id, action: testOwnerAdminId ? 'profile.test_owner_assigned' : 'profile.test_owner_removed', targetTable: 'Profile', targetId: target.id } });
  });
  res.redirect(`/admin/employees/${target.id}`);
});

router.get('/employees', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const str = (v) => (typeof v === 'string' ? v : '');
  const teamId = str(req.query.teamId);
  const supervisorId = str(req.query.supervisorId);
  const setupQuery = parseSetupQuery(req.query);
  const f = parseFilters(req.query);
  const found = await prisma.profile.findMany({
    where: {
      organizationId: admin.organizationId,
      role: str(req.query.role) || undefined,
      status: str(req.query.status) || undefined,
      // In AND so it does not replace the OR that excludeOtherAdminsTestProfiles() spreads in below
      // (a top-level OR here was silently overwritten, so the search box matched everyone).
      ...(str(req.query.q).trim() ? { AND: [{ OR: [{ fullName: containsText(req.query.q) }, { email: containsText(req.query.q) }, { username: containsText(req.query.q) }] }] } : {}),
      teamMemberships: teamId ? { some: { teamId } } : undefined,
      supervisedBy: supervisorId ? { some: { supervisorId, unassignedAt: null } } : undefined,
      ...excludeOtherAdminsTestProfiles(admin),
      ...(await whereFor(admin.organizationId, f)),
    },
    include: {
      teamMemberships: { include: { team: true } },
      supervisedBy: { where: { unassignedAt: null }, include: { supervisor: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  const setupMap = await loadSetupForProfiles(admin.organizationId, found);
  const readinessMap = await readinessFor(admin.organizationId, found, { setupMap });
  const employees = byPassportStatus(byReadiness((await applyLearningFilters(found, f)).filter((e) => matchesSetup(setupMap.get(e.id), setupQuery)), readinessMap, f), f);
  const trainingMap = await getTrainingSummaries(employees.map((e) => e.id));
  const [teams, supervisors, requirements] = await Promise.all([
    prisma.team.findMany({ where: { organizationId: admin.organizationId, archivedAt: null }, orderBy: { name: 'asc' } }),
    prisma.profile.findMany({ where: { organizationId: admin.organizationId, role: 'SUPERVISOR', status: { not: 'ARCHIVED' }, ...excludeOtherAdminsTestProfiles(admin) }, orderBy: { fullName: 'asc' } }),
    requirementOptions(admin.organizationId),
  ]);
  const pendingInvites = await prisma.profile.count({ where: { organizationId: admin.organizationId, status: 'INVITED', ...excludeOtherAdminsTestProfiles(admin) } });
  res.render('admin/employees/index', {
    title: 'Employees & Teams',
    removedNotice: { deleted: 'The employee was deleted permanently.', archived: 'The employee was archived. You can restore them from the Archived filter.' }[str(req.query.removed)] || null,
    pendingInvites,
    employees,
    setupMap,
    readinessMap,
    trainingMap,
    teams,
    supervisors,
    requirements,
    f,
    filterSkills: await prisma.skill.findMany({ where: { organizationId: admin.organizationId, isActive: true }, orderBy: [{ category: 'asc' }, { name: 'asc' }], select: { id: true, name: true } }),
    SETUP_FILTERS,
    STATUS_TONE,
    STATUS_LABEL,
    q: str(req.query.q),
    role: str(req.query.role),
    status: str(req.query.status),
    teamId,
    supervisorId,
    setup: setupQuery.setup,
    missing: setupQuery.missing,
    PASSPORT_STATUS,
    PASSPORT_STATUS_LABEL,
    activeFilters: buildActiveFilterChips('/admin/employees', req.query, { teams, supervisors, requirements, SETUP_FILTERS, STATUS_LABEL }),
  });
});

router.get('/employees/export.xlsx', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const employees = await prisma.profile.findMany({
    where: { organizationId: admin.organizationId, ...excludeOtherAdminsTestProfiles(admin) },
    select: { id: true, fullName: true, username: true, role: true },
    orderBy: [{ fullName: 'asc' }, { username: 'asc' }],
  });
  const file = employeeWorkbook(require('../../lib/employeeExportPasswords').exportPasswords(employees, admin.organizationId));
  await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'employees.exported', targetTable: 'Profile', metadata: { count: employees.length } });
  res.set('Cache-Control', 'private, no-store');
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.attachment(`spacezero-employees-${new Date().toISOString().slice(0, 10)}.xlsx`);
  res.send(file);
});

router.get('/employees/new', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const [teams, supervisors] = await Promise.all([
    prisma.team.findMany({ where: { organizationId: admin.organizationId, archivedAt: null }, orderBy: { name: 'asc' } }),
    prisma.profile.findMany({
      where: { organizationId: admin.organizationId, role: 'SUPERVISOR', status: { not: 'ARCHIVED' }, ...excludeOtherAdminsTestProfiles(admin) },
      orderBy: { fullName: 'asc' },
    }),
  ]);
  res.render('admin/employees/new', { title: 'Add employee', teams, supervisors, error: null, fieldErrors: {}, inviteLink: null, values: {} });
});

router.post('/employees/new', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const [teams, supervisors] = await Promise.all([
    prisma.team.findMany({ where: { organizationId: admin.organizationId, archivedAt: null }, orderBy: { name: 'asc' } }),
    prisma.profile.findMany({
      where: { organizationId: admin.organizationId, role: 'SUPERVISOR', status: { not: 'ARCHIVED' }, ...excludeOtherAdminsTestProfiles(admin) },
      orderBy: { fullName: 'asc' },
    }),
  ]);
  const rerender = (error, fieldErrors) =>
    res.render('admin/employees/new', { title: 'Add employee', teams, supervisors, error: error || null, fieldErrors: fieldErrors || {}, inviteLink: null, values: req.body });

  const parsed = EmployeeSchema.safeParse({
    fullName: req.body.fullName,
    username: req.body.username,
    email: req.body.email,
    role: req.body.role,
    teamId: req.body.teamId || null,
    supervisorId: req.body.supervisorId || null,
    employmentStartDate: req.body.employmentStartDate,
  });
  if (!parsed.success) return rerender(null, parsed.error.flatten().fieldErrors);
  const data = parsed.data;

  const [usernameTaken, emailTaken] = await Promise.all([
    prisma.profile.findUnique({ where: { username: data.username } }),
    prisma.profile.findUnique({ where: { email: data.email } }),
  ]);
  if (usernameTaken) return rerender(null, { username: ['This username is already taken.'] });
  if (emailTaken) return rerender(null, { email: ['This email is already registered.'] });
  if (data.supervisorId && !requiresSupervisor(data.role)) {
    return rerender('A supervisor can only be assigned to an Agent or Flight Expert.');
  }

  const { raw, hash } = generateToken();

  const profile = await prisma.$transaction(async (tx) => {
    const created = await tx.profile.create({
      data: {
        organizationId: admin.organizationId,
        fullName: data.fullName,
        username: data.username,
        email: data.email,
        role: data.role,
        status: 'INVITED',
        employmentStartDate: new Date(data.employmentStartDate),
        createdById: admin.id,
      },
    });
    if (data.teamId) await tx.teamMembership.create({ data: { teamId: data.teamId, profileId: created.id } });
    if (data.supervisorId) {
      await tx.supervisorAssignment.create({
        data: { supervisorId: data.supervisorId, agentId: created.id, teamId: data.teamId || undefined, assignedById: admin.id },
      });
    }
    await tx.invitation.create({
      data: { profileId: created.id, tokenHash: hash, invitedById: admin.id, expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
    });
    return created;
  });

  await logAudit({
    organizationId: admin.organizationId,
    actorId: admin.id,
    action: 'employee.created',
    targetTable: 'Profile',
    targetId: profile.id,
    metadata: { role: data.role, email: data.email },
  });

  // The role decides the onboarding: setup requirements apply by role, and the onboarding training is assigned now.
  await applyOnboarding(profile, { actorId: admin.id }).catch((err) => console.error('[onboarding] failed:', err.message || err));

  if (data.supervisorId) {
    await createNotification({
      profileId: data.supervisorId,
      type: 'team.agent_assigned',
      title: 'New team member',
      body: `${data.fullName} was assigned to your team.`,
      link: '/team',
    });
  }

  try { await sendAccountEmail(profile.email, raw, 'invite'); }
  catch {
    await prisma.invitation.updateMany({ where: { profileId: profile.id }, data: { status: 'REVOKED' } });
    await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'email.invitation_failed', targetId: profile.id });
    return res.status(503).render('error', { layout: false, message: 'Account created, but invitation delivery failed. Configure email and resend the invitation from Employees.', action: { label: 'Open Employees', href: '/admin/employees' } });
  }
  await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'email.invitation_sent', targetId: profile.id });
  return res.redirect('/admin/employees');
});
router.get('/employees/:id', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const { loadProfileOverview } = require('../../lib/profileOverview');
  const employee = await prisma.profile.findFirst({
    where: { id: req.params.id, organizationId: admin.organizationId, ...excludeOtherAdminsTestProfiles(admin) },
    include: { teamMemberships: true, supervisedBy: { where: { unassignedAt: null } } },
  });
  if (!employee) return res.status(404).render('not-found', { layout: false });

  const [teams, supervisors, data, managementAccessCount] = await Promise.all([
    prisma.team.findMany({ where: { organizationId: admin.organizationId, archivedAt: null }, orderBy: { name: 'asc' } }),
    prisma.profile.findMany({
      where: { organizationId: admin.organizationId, role: 'SUPERVISOR', status: { not: 'ARCHIVED' }, ...excludeOtherAdminsTestProfiles(admin) },
      orderBy: { fullName: 'asc' },
    }),
    loadProfileOverview(employee.id),
    // Task 3 "easy person-level management": a quick-glance count on the Supervisor's own profile,
    // reusing the same grant table the Admin Configuration → Supervisor permissions screen manages.
    employee.role === 'SUPERVISOR' ? prisma.supervisorCapability.count({ where: { organizationId: admin.organizationId, supervisorId: employee.id } }) : null,
  ]);
  res.locals.empTabs = await tabsForRequest(req, employee);

  res.render('admin/employees/detail', {
    title: employee.fullName,
    employee,
    teams,
    supervisors,
    data,
    managementAccessCount,
    error: null,
    fieldErrors: {},
    canRecordEvidence: true,
  });
});

// Invite everyone who has not activated yet, in one action. E-mails go out only when the admin
// presses the button AND a mail server is configured; otherwise one-time links are listed for the
// admin to hand out personally (never in production).
router.post('/employees/invite-pending', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const pending = await prisma.profile.findMany({
    where: { organizationId: admin.organizationId, status: 'INVITED', ...excludeOtherAdminsTestProfiles(admin) },
    orderBy: { fullName: 'asc' },
  });
  if (!isEmailConfigured() && process.env.NODE_ENV === 'production') {
    return res.status(503).render('error', { layout: false, message: 'Email delivery is not configured, so invitations cannot be sent.', action: { label: 'Open Employees', href: '/admin/employees' } });
  }
  const origin = process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`;
  const results = [];
  for (const person of pending) {
    const raw = await issueInvitation(person, admin);
    if (canShareLinksManually()) {
      results.push({ person, outcome: 'link', link: new URL(`/accept-invite/${raw}`, origin).href });
      continue;
    }
    try {
      await sendAccountEmail(person.email, raw, 'invite');
      results.push({ person, outcome: 'sent' });
      await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'email.invitation_sent', targetTable: 'Profile', targetId: person.id });
    } catch {
      await prisma.invitation.updateMany({ where: { profileId: person.id }, data: { status: 'REVOKED' } });
      results.push({ person, outcome: 'failed' });
      await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'email.invitation_failed', targetTable: 'Profile', targetId: person.id });
    }
  }
  await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'employee.invites_issued', targetTable: 'Profile', metadata: { count: results.length, mode: canShareLinksManually() ? 'links' : 'email' } });
  res.set('Cache-Control', 'no-store');
  res.render('admin/employees/invite-results', { title: 'Invitations', results, manual: canShareLinksManually() });
});

router.post('/employees/:id', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const parsed = EmployeeUpdateSchema.safeParse({
    fullName: req.body.fullName,
    role: req.body.role,
    teamId: req.body.teamId || null,
    supervisorId: req.body.supervisorId || null,
    employmentStartDate: req.body.employmentStartDate,
  });

  const existing = await prisma.profile.findFirst({
    where: { id: req.params.id, organizationId: admin.organizationId, ...excludeOtherAdminsTestProfiles(admin) },
    include: { teamMemberships: true, supervisedBy: { where: { unassignedAt: null } } },
  });
  if (!existing) return res.status(404).render('not-found', { layout: false });

  if (!parsed.success || (parsed.data.supervisorId && !requiresSupervisor(parsed.data.role))) {
    const [teams, supervisors, data] = await Promise.all([
      prisma.team.findMany({ where: { organizationId: admin.organizationId, archivedAt: null }, orderBy: { name: 'asc' } }),
      prisma.profile.findMany({ where: { organizationId: admin.organizationId, role: 'SUPERVISOR', status: { not: 'ARCHIVED' }, ...excludeOtherAdminsTestProfiles(admin) }, orderBy: { fullName: 'asc' } }),
      require('../../lib/profileOverview').loadProfileOverview(existing.id),
    ]);
    res.locals.empTabs = await tabsForRequest(req, existing);
    return res.render('admin/employees/detail', {
      title: existing.fullName,
      employee: existing,
      teams,
      supervisors,
      data,
      error: !parsed.success ? null : 'A supervisor can only be assigned to an Agent or Flight Expert.',
      fieldErrors: !parsed.success ? parsed.error.flatten().fieldErrors : {},
      canRecordEvidence: true,
    });
  }
  const data = parsed.data;

  await prisma.$transaction(async (tx) => {
    await tx.profile.update({
      where: { id: existing.id },
      data: { fullName: data.fullName, role: data.role, employmentStartDate: new Date(data.employmentStartDate) },
    });

    const currentTeamId = existing.teamMemberships[0] ? existing.teamMemberships[0].teamId : null;
    if (currentTeamId !== (data.teamId || null)) {
      if (existing.teamMemberships.length > 0) await tx.teamMembership.deleteMany({ where: { profileId: existing.id } });
      if (data.teamId) await tx.teamMembership.create({ data: { teamId: data.teamId, profileId: existing.id } });
    }

    const currentSupervisorId = existing.supervisedBy[0] ? existing.supervisedBy[0].supervisorId : null;
    if (currentSupervisorId !== (data.supervisorId || null)) {
      if (existing.supervisedBy.length > 0) {
        await tx.supervisorAssignment.updateMany({ where: { agentId: existing.id, unassignedAt: null }, data: { unassignedAt: new Date() } });
      }
      if (data.supervisorId) {
        await tx.supervisorAssignment.create({
          data: { supervisorId: data.supervisorId, agentId: existing.id, teamId: data.teamId || undefined, assignedById: admin.id },
        });
      }
    }
  });

  // Reassigning a supervisor mid-flight: leave visibility is always computed live from the current
  // assignment, so the new supervisor already sees any pending request once they look — but they
  // were never notified of one filed before the reassignment, since that notification only ever
  // went to whoever was the supervisor AT THE TIME the employee filed it (lib/leave.js's own
  // comment on live-scoped visibility only covers who CAN see a request, not who was told about it).
  if (data.supervisorId && (existing.supervisedBy[0] ? existing.supervisedBy[0].supervisorId : null) !== data.supervisorId) {
    const pending = await prisma.leaveRequest.findMany({ where: { profileId: existing.id, status: 'PENDING' }, select: { id: true, days: true } });
    for (const request of pending) {
      await createNotification({ profileId: data.supervisorId, type: 'leave.requested', title: 'Pending leave request', body: `${existing.fullName} has a pending request for ${request.days} day(s), now on your team.`, link: `/leave/${request.id}` });
    }
  }

  // A new role can bring new onboarding training (setup requirements already follow the role).
  if (existing.role !== data.role) await applyOnboarding({ ...existing, role: data.role }, { actorId: admin.id }).catch((err) => console.error('[onboarding] failed:', err.message || err));

  await logAudit({
    organizationId: admin.organizationId,
    actorId: admin.id,
    action: 'employee.updated',
    targetTable: 'Profile',
    targetId: existing.id,
    metadata: { role: data.role, teamId: data.teamId, supervisorId: data.supervisorId },
  });
  const beforeTeamId = existing.teamMemberships[0] ? existing.teamMemberships[0].teamId : null;
  const beforeSupervisorId = existing.supervisedBy[0] ? existing.supervisedBy[0].supervisorId : null;
  const changes = [
    ['employee.role_changed', existing.role, data.role],
    ['employee.team_changed', beforeTeamId, data.teamId || null],
    ['employee.supervisor_changed', beforeSupervisorId, data.supervisorId || null],
  ];
  for (const [action, from, to] of changes) {
    if (from !== to) await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action, targetTable: 'Profile', targetId: existing.id, metadata: { from, to } });
  }

  res.redirect('/admin/employees');
});

async function applyStatus(admin, target, status) {
  const nextStatus = status === 'ACTIVE' && !target.passwordHash ? 'INVITED' : status;
  await prisma.profile.update({
    where: { id: target.id },
    data: { status: nextStatus, archivedAt: status === 'ARCHIVED' ? new Date() : null },
  });
  if (status !== 'ACTIVE') await prisma.session.deleteMany({ where: { profileId: target.id } });
  await logAudit({
    organizationId: admin.organizationId,
    actorId: admin.id,
    action: `employee.status_${status.toLowerCase()}`,
    targetTable: 'Profile',
    targetId: target.id,
  });
}

async function setStatus(req, res, status) {
  const admin = req.profile;
  const target = await prisma.profile.findFirst({
    where: { id: req.params.id, organizationId: admin.organizationId, ...excludeOtherAdminsTestProfiles(admin) },
  });
  if (target) await applyStatus(admin, target, status);
  res.json({ ok: true });
}

// Removing a person: the Admin chooses ARCHIVE (kept and restorable) or DELETE (gone for good). The page shows what a
// delete would remove, and a permanent delete has to be typed out. Never while impersonating.
async function loadRemovable(req, res) {
  const admin = req.profile;
  if (req.impersonation) { res.status(403).render('forbidden'); return null; }
  const target = await prisma.profile.findFirst({ where: { id: req.params.id, organizationId: admin.organizationId, ...excludeOtherAdminsTestProfiles(admin) } });
  if (!target) { res.status(404).render('not-found'); return null; }
  return target;
}

router.get('/employees/:id/remove', requireAdmin, async (req, res) => {
  const target = await loadRemovable(req, res);
  if (!target) return;
  const blocker = await employeeDeletion.deleteBlocker(req.profile, target);
  res.render('admin/employees/remove', {
    title: 'Delete or archive', employee: target, impact: await employeeDeletion.deletionImpact(target), blocker,
    mode: req.query.mode === 'delete' && !blocker ? 'delete' : 'archive', error: null, roleLabel,
  });
});

router.post('/employees/:id/remove', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const target = await loadRemovable(req, res);
  if (!target) return;
  const mode = req.body.mode === 'delete' ? 'delete' : req.body.mode === 'archive' ? 'archive' : '';
  const blocker = await employeeDeletion.deleteBlocker(admin, target);
  const again = async (error) => res.status(400).render('admin/employees/remove', { title: 'Delete or archive', employee: target, impact: await employeeDeletion.deletionImpact(target), blocker, mode: mode || 'archive', error, roleLabel });
  if (!mode) return again('Choose Archive or Delete.');
  if (mode === 'archive') {
    if (target.id === admin.id) return again('You cannot archive your own account.');
    if (target.status !== 'ARCHIVED') await applyStatus(admin, target, 'ARCHIVED');
    return res.redirect('/admin/employees?removed=archived');
  }
  if (blocker) return again(blocker);
  if (String(req.body.confirm || '').trim() !== 'DELETE') return again('Type DELETE to confirm that this person is deleted permanently.');
  await employeeDeletion.deleteEmployee(admin, target);
  res.redirect('/admin/employees?removed=deleted');
});

router.post('/employees/:id/disable', requireAdmin, (req, res) => setStatus(req, res, 'DISABLED'));
router.post('/employees/:id/reactivate', requireAdmin, (req, res) => setStatus(req, res, 'ACTIVE'));
router.post('/employees/:id/archive', requireAdmin, (req, res) => setStatus(req, res, 'ARCHIVED'));
router.post('/employees/:id/unarchive', requireAdmin, (req, res) => setStatus(req, res, 'ACTIVE'));

/** Issues a fresh single-use activation token for an INVITED employee (the raw token is returned once and never stored). */
async function issueInvitation(target, admin) {
  const { raw, hash } = generateToken();
  const invitation = await prisma.invitation.findUnique({ where: { profileId: target.id } });
  if (invitation) {
    await prisma.invitation.update({ where: { id: invitation.id }, data: { tokenHash: hash, status: 'PENDING', expiresAt: new Date(Date.now() + INVITE_TTL_MS), resendCount: { increment: 1 } } });
  } else {
    await prisma.invitation.create({ data: { profileId: target.id, tokenHash: hash, invitedById: admin.id, expiresAt: new Date(Date.now() + INVITE_TTL_MS) } });
  }
  return raw;
}

// Without a configured mail server the link can only be shared by hand, and only outside production.
const canShareLinksManually = () => !isEmailConfigured() && process.env.NODE_ENV !== 'production';

router.post('/employees/:id/resend-invite', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const target = await prisma.profile.findFirst({
    where: { id: req.params.id, organizationId: admin.organizationId, ...excludeOtherAdminsTestProfiles(admin) },
  });
  if (!target || target.status !== 'INVITED') return res.json({ ok: true });

  const raw = await issueInvitation(target, admin);
  await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'employee.invite_resent', targetTable: 'Profile', targetId: target.id });
  if (canShareLinksManually()) {
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, link: `/accept-invite/${raw}` }); // shown once to the admin, who shares it personally
  }
  try { await sendAccountEmail(target.email, raw, 'invite'); }
  catch { await prisma.invitation.updateMany({ where: { profileId: target.id }, data: { status: 'REVOKED' } }); return res.status(503).json({ error: 'Invitation email delivery failed.' }); }
  res.json({ ok: true });
});

router.post('/employees/:id/reset-password', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const target = await prisma.profile.findFirst({
    where: { id: req.params.id, organizationId: admin.organizationId, ...excludeOtherAdminsTestProfiles(admin) },
  });
  if (!target || target.status !== 'ACTIVE') return res.json({ ok: true });

  try { await sendReset(target, admin.id); } catch { return res.status(503).json({ error: 'Password-reset email delivery failed.' }); }
  res.json({ ok: true });
});

module.exports = router;
