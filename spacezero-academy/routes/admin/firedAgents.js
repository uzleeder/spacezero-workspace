'use strict';

// Fired agents (lib/firedAgents.js): fire an employee with a reason, see let-go agents grouped by the company account
// they held, and give a free account to a new agent. Admins only. Mounted before routes/admin/employees.js so that
// /admin/employees/fired is not read as an employee id.
const express = require('express');
const router = express.Router();

const { prisma } = require('../../lib/prisma');
const { requireAdmin } = require('../../lib/authMiddleware');
const { logAudit } = require('../../lib/audit');
const { applyOnboarding } = require('../../lib/onboarding');
const { createNotification } = require('../../lib/notifications');
const { sendAccountEmail } = require('../../lib/mailer');
const { roleLabel } = require('../../lib/roles');
const fired = require('../../lib/firedAgents');

const empTabs = () => require('../../lib/navTabs').employeeManagementTabs('ADMIN');

router.get('/employees/fired', requireAdmin, async (req, res) => {
  res.render('admin/fired/list', { title: 'Fired agents', tabs: empTabs(), rows: await fired.accountsList(req.profile), roleLabel, notice: req.query.notice || '' });
});

router.get('/employees/fired/account', requireAdmin, async (req, res) => {
  const account = await fired.accountDetail(req.profile, String(req.query.key || ''));
  if (!account) return res.status(404).render('not-found', { layout: false });
  res.set('Cache-Control', 'private, no-store'); // personal data of former agents: never kept by the browser
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'employee.fired_account_viewed', targetTable: 'Profile', metadata: { account: account.key } });
  res.render('admin/fired/account', { title: 'Fired agents', tabs: empTabs(), account, roleLabel, notice: req.query.notice || '' });
});

async function handOverForm(req, res, { status = 200, error = null, values = {} } = {}) {
  const account = await fired.accountDetail(req.profile, String(req.query.key || req.body.key || ''));
  if (!account) return res.status(404).render('not-found', { layout: false });
  if (account.holder || !account.keeper) return res.redirect(`/admin/employees/fired/account?key=${encodeURIComponent(account.key)}`);
  const [teams, supervisors] = await Promise.all([
    prisma.team.findMany({ where: { organizationId: req.profile.organizationId, archivedAt: null }, orderBy: { name: 'asc' } }),
    prisma.profile.findMany({ where: { organizationId: req.profile.organizationId, role: 'SUPERVISOR', status: { not: 'ARCHIVED' }, firedAt: null }, orderBy: { fullName: 'asc' } }),
  ]);
  res.status(status).render('admin/fired/new-agent', { title: 'Give the account to a new agent', tabs: empTabs(), account, teams, supervisors, error, values, roleLabel });
}

router.get('/employees/fired/account/new-agent', requireAdmin, (req, res) => handOverForm(req, res));

router.post('/employees/fired/account/new-agent', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const values = { fullName: req.body.fullName, employmentStartDate: req.body.employmentStartDate, teamId: req.body.teamId || '', supervisorId: req.body.supervisorId || '' };
  const result = await fired.handOverAccount(admin, req.body.key, { ...values, teamId: values.teamId || null, supervisorId: values.supervisorId || null });
  if (result.error) return handOverForm(req, res, { status: 400, error: result.error, values });
  const profile = result.profile;
  await applyOnboarding(profile, { actorId: admin.id }).catch((err) => console.error('[onboarding] failed:', err.message || err)); // a fresh start: the role's onboarding training
  if (values.supervisorId) await createNotification({ profileId: values.supervisorId, type: 'team.agent_assigned', title: 'New team member', body: `${profile.fullName} was assigned to your team.`, link: '/team' }).catch(() => undefined);
  let notice = 'handed-over';
  try { await sendAccountEmail(profile.email, result.invite, 'invite'); }
  catch {
    await prisma.invitation.updateMany({ where: { profileId: profile.id }, data: { status: 'REVOKED' } });
    notice = 'handed-over-no-email';
  }
  res.redirect(`/admin/employees/${profile.id}?notice=${notice}`);
});

router.get('/employees/:id/fire', requireAdmin, async (req, res) => {
  const employee = await prisma.profile.findFirst({ where: { id: req.params.id, organizationId: req.profile.organizationId } });
  if (!employee || employee.role === 'ADMIN') return res.status(404).render('not-found', { layout: false });
  if (employee.firedAt) return res.redirect(`/admin/employees/fired/account?key=${encodeURIComponent(employee.accountKey)}`);
  res.render('admin/fired/fire', { title: `Fire ${employee.fullName}`, employee, error: null, reason: '', roleLabel, savedLogins: await prisma.credential.count({ where: { ownerId: employee.id } }) });
});

router.post('/employees/:id/fire', requireAdmin, async (req, res) => {
  const result = await fired.fireEmployee(req.profile, req.params.id, req.body.reason);
  if (result.status === 404) return res.status(404).render('not-found', { layout: false });
  if (result.error) {
    const employee = await prisma.profile.findFirst({ where: { id: req.params.id, organizationId: req.profile.organizationId } });
    return res.status(400).render('admin/fired/fire', { title: `Fire ${employee.fullName}`, employee, error: result.error, reason: req.body.reason || '', roleLabel, savedLogins: await prisma.credential.count({ where: { ownerId: employee.id } }) });
  }
  const employee = await prisma.profile.findUnique({ where: { id: req.params.id }, select: { accountKey: true } });
  res.redirect(`/admin/employees/fired/account?key=${encodeURIComponent(employee.accountKey)}&notice=fired`);
});

module.exports = router;
