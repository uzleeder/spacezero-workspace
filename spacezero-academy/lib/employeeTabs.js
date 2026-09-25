'use strict';

// Tab bar shared by every employee-record page (Overview, Setup, Training, Skills, Vacation,
// Activity, Credentials). Overview points at the existing role-specific page so working screens
// are reused rather than rebuilt.
function overviewHref(actor, employee, isSelf) {
  if (isSelf) return '/profile';
  return actor.role === 'SUPERVISOR' ? `/team/${employee.id}` : `/admin/employees/${employee.id}`;
}

function employeeTabs(actor, ctx, { credentials = false } = {}) {
  const base = `/employees/${ctx.employee.id}`;
  const tabs = [
    { label: 'Overview', href: overviewHref(actor, ctx.employee, ctx.isSelf) },
    { label: 'Setup', href: `${base}/setup` },
    { label: 'Training', href: `${base}/training` },
    { label: 'Skills', href: `${base}/skills` },
    { label: 'Vacation / Leave', href: `${base}/leave` },
    { label: 'Activity', href: `${base}/activity` },
  ];
  if (credentials) tabs.push({ label: 'Credentials', href: `${base}/credentials` });
  return tabs;
}

// Convenience for the existing Overview pages (admin detail, /team/:id, /profile): builds the same
// tab bar the employee-record pages use, including the Credentials tab only when the actor may see it.
async function tabsForRequest(req, employee) {
  const { credentialAccess } = require('./employeeAccess');
  const access = await credentialAccess(req.profile, employee, { impersonating: Boolean(req.impersonation) });
  return employeeTabs(req.profile, { employee, isSelf: employee.id === req.profile.id }, { credentials: access.view || access.manage });
}

module.exports = { employeeTabs, overviewHref, tabsForRequest };
