'use strict';

// Tab bar shared by every employee-record page (Overview, Setup, Training, Skills, Vacation,
// Activity, Credentials). Overview points at the existing role-specific page so working screens
// are reused rather than rebuilt.
function overviewHref(actor, employee, isSelf) {
  if (isSelf) return '/profile';
  return actor.role === 'SUPERVISOR' ? `/team/${employee.id}` : `/admin/employees/${employee.id}`;
}

function employeeTabs(actor, ctx, { credentials = false, canViewSetup = true } = {}) {
  const base = `/employees/${ctx.employee.id}`;
  const tabs = [{ label: 'Overview', href: overviewHref(actor, ctx.employee, ctx.isSelf) }];
  if (canViewSetup) tabs.push({ label: 'Setup', href: `${base}/setup` });
  tabs.push(
    { label: 'Training', href: `${base}/training` },
    { label: 'Skills', href: `${base}/skills` },
    { label: 'Vacation / Leave', href: `${base}/leave` },
    { label: 'Activity', href: `${base}/activity` },
  );
  if (credentials) tabs.push({ label: 'Credentials', href: `${base}/credentials` });
  return tabs;
}

// Convenience for the existing Overview pages (admin detail, /team/:id, /profile): builds the same
// tab bar the employee-record pages use, including the Credentials tab only when the actor may see it.
async function tabsForRequest(req, employee) {
  const { credentialAccess } = require('./employeeAccess');
  const { canViewSetupTab } = require('./supervisorCapabilities');
  const ctx = { employee, isSelf: employee.id === req.profile.id };
  const [access, canViewSetup] = await Promise.all([
    credentialAccess(req.profile, employee, { impersonating: Boolean(req.impersonation) }),
    canViewSetupTab(req.profile, ctx),
  ]);
  return employeeTabs(req.profile, ctx, { credentials: access.view || access.manage, canViewSetup });
}

module.exports = { employeeTabs, overviewHref, tabsForRequest };
