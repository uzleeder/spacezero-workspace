'use strict';

const ALL_ROLES = ['ADMIN', 'SUPERVISOR', 'TRAVEL_AGENT', 'FLIGHT_EXPERT'];

// Final information architecture. The sidebar stays short; secondary areas hang off tab bars
// (lib/navTabs.js) or the top-right user menu:
//   My Training  = the learner's own assigned work (Skill Graph and Notes are tabs inside it)
//   AI Practice  = the creation factory (raw material -> analysis -> practice -> review -> approve)
//   Training     = the approved catalog + assignment permissions
//   Library      = approved reference knowledge (management of it is a tab)
//   Employees & Teams = employee records (setup, vacation, credentials) and call reviews
const NAV_SECTIONS = [
  {
    title: 'Main',
    items: [
      { href: '/dashboard', label: 'Dashboard', roles: ALL_ROLES },
      { href: '/training', label: 'My Training', roles: ALL_ROLES, activeAlso: ['/skill-graph', '/notes', '/training-course', '/assessments'] },
      { href: '/ai-practice', label: 'AI Practice', roles: ['ADMIN'] },
      { href: '/library', label: 'Library', roles: ALL_ROLES, activeAlso: ['/admin/library'] },
    ],
  },
  {
    title: 'Management',
    items: [
      {
        href: '/admin/employees',
        label: 'Employees & Teams',
        roles: ['ADMIN', 'SUPERVISOR'],
        activeAlso: ['/admin/teams', '/employees', '/leave', '/admin/call-reviews', '/call-reviews'],
        hrefByRole: { SUPERVISOR: '/team' },
        activeAlsoByRole: { SUPERVISOR: ['/team-skills', '/employees', '/leave', '/call-reviews'] },
      },
      { href: '/admin/training', label: 'Training', roles: ['ADMIN', 'SUPERVISOR'], activeAlso: ['/assignments'] },
    ],
  },
  {
    items: [
      { href: '/standards', label: 'Company Standards & Workflow', roles: ALL_ROLES, activeAlso: ['/admin/standards'] },
      { href: '/assistant', label: 'SpaceZero AI', roles: ALL_ROLES },
      // ONE Settings entry for every Admin (Task 4). Inside: General and Security are ordinary,
      // day-to-day settings any Admin reaches; Advanced (the former separate "Admin Configuration")
      // only renders for an Admin who also holds System Configuration Access — that capability
      // check happens inside the Settings page itself (routes/admin/settings.js), and every
      // Advanced route it links to re-checks the same capability server-side regardless of whether
      // this sidebar item, or the Advanced tab within it, is shown.
      {
        href: '/admin/settings', label: 'Settings', roles: ['ADMIN'],
        activeAlso: ['/admin/configuration', '/admin/setup-requirements', '/admin/policies', '/admin/supervisor-permissions', '/admin/standards', '/admin/skills', '/admin/development', '/admin/certifications', '/admin/audit-logs', '/admin/analytics'],
      },
    ],
  },
];

// Rendered as its own block in the sidebar (views/layout.ejs), not through
// the generic section loop — kept here so navForRole's role-based visibility
// rule stays in one place.
const LOGIN_AS_ROLES = [
  { role: 'ADMIN', label: 'Admin' },
  { role: 'SUPERVISOR', label: 'Supervisor' },
  { role: 'TRAVEL_AGENT', label: 'Travel Agent' },
  { role: 'FLIGHT_EXPERT', label: 'Flight Expert' },
];

function navForRole(role) {
  return NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items
      .filter((item) => item.roles.includes(role))
      .map((item) => ({
        ...item,
        href: (item.hrefByRole && item.hrefByRole[role]) || item.href,
        activeAlso: (item.activeAlsoByRole && item.activeAlsoByRole[role]) || item.activeAlso || [],
      })),
  })).filter((section) => section.items.length > 0);
}

module.exports = { NAV_SECTIONS, LOGIN_AS_ROLES, navForRole };
