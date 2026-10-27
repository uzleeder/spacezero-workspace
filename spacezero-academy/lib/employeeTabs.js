'use strict';

// Tab bar shared by every employee-record page (Overview, Setup, Training, Skills, Vacation,
// Activity, Credentials). Overview points at the existing role-specific page so working screens
// are reused rather than rebuilt.
function overviewHref(actor, employee, isSelf) {
  if (isSelf) return '/profile';
  return actor.role === 'SUPERVISOR' ? `/team/${employee.id}` : `/admin/employees/${employee.id}`;
}

function employeeTabs(actor, ctx, { credentials = false, canViewSetup = true, firstMonth = false } = {}) {
  const base = `/employees/${ctx.employee.id}`;
  const tabs = [{ label: 'Overview', href: overviewHref(actor, ctx.employee, ctx.isSelf) }];
  if (canViewSetup) tabs.push({ label: 'Setup', href: `${base}/setup` });
  tabs.push({ label: 'Training', href: `${base}/training` });
  // while their New Agent Program runs, their manager reaches it from here (routes/newAgents.js)
  if (firstMonth) tabs.push({ label: 'First month', href: `/new-agents/${ctx.employee.id}` });
  tabs.push(
    { label: 'Skills', href: `${base}/skills` },
    { label: 'Vacation / Leave', href: `${base}/leave` },
    { label: 'Activity', href: `${base}/activity` },
  );
  if (credentials) tabs.push({ label: 'Credentials', href: `${base}/credentials` });
  return tabs;
}

/** Is this employee in a running New Agent Program that this viewer manages (an Admin, or their supervisor)? */
async function inFirstMonth(actor, ctx) {
  if (ctx.isSelf || !['ADMIN', 'SUPERVISOR'].includes(actor.role)) return false;
  const { prisma } = require('./prisma');
  return Boolean(await prisma.agentProgram.findFirst({ where: { profileId: ctx.employee.id, status: 'ACTIVE' }, select: { id: true } }));
}

// Convenience for the existing Overview pages (admin detail, /team/:id, /profile): builds the same
// tab bar the employee-record pages use, including the Credentials tab only when the actor may see it.
async function tabsForRequest(req, employee) {
  const { credentialAccess } = require('./employeeAccess');
  const { canViewSetupTab } = require('./supervisorCapabilities');
  const ctx = { employee, isSelf: employee.id === req.profile.id };
  const [access, canViewSetup, firstMonth] = await Promise.all([
    credentialAccess(req.profile, employee, { impersonating: Boolean(req.impersonation) }),
    canViewSetupTab(req.profile, ctx),
    inFirstMonth(req.profile, ctx),
  ]);
  return employeeTabs(req.profile, ctx, { credentials: access.view || access.manage, canViewSetup, firstMonth });
}

module.exports = { employeeTabs, overviewHref, tabsForRequest, inFirstMonth };
