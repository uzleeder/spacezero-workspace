'use strict';

// Sub-navigation (tab bars) shared by several pages, defined once so the information architecture
// stays consistent: the sidebar stays short and everything else hangs off these tabs.
function employeeManagementTabs(role) {
  if (role === 'SUPERVISOR') {
    return [
      { label: 'My Team', href: '/team' },
      { label: 'Team Intelligence', href: '/team-skills' },
      { label: 'Vacation Overview', href: '/leave' },
      { label: 'Call reviews', href: '/call-reviews' },
    ];
  }
  return [
    { label: 'Employees', href: '/admin/employees' },
    { label: 'Teams', href: '/admin/teams' },
    { label: 'Intelligence', href: '/admin/intelligence' },
    { label: 'Vacation Overview', href: '/leave' },
    { label: 'Call reviews', href: '/admin/call-reviews' },
  ];
}

const settingsTabs = () => [
  { label: 'Settings', href: '/admin/settings' },
  { label: 'Setup requirements', href: '/admin/setup-requirements' },
  { label: 'Policies', href: '/admin/policies' },
  { label: 'Skills', href: '/admin/skills' },
  { label: 'Development', href: '/admin/development' },
  { label: 'Certifications', href: '/admin/certifications' },
  { label: 'Security & Audit', href: '/admin/audit-logs' },
  { label: 'Analytics', href: '/admin/analytics' },
];

const trainingTabs = () => [
  { label: 'Catalog', href: '/admin/training' },
  { label: 'Assignments', href: '/assignments' },
];

function learnerTabs(role) {
  const base = [{ label: 'My Training', href: '/training' }];
  if (role === 'TRAVEL_AGENT' || role === 'FLIGHT_EXPERT') {
    base.push({ label: 'Skill Graph', href: '/skill-graph' }, { label: 'Notes', href: '/notes' });
  }
  return base;
}

function libraryTabs(role) {
  return role === 'ADMIN'
    ? [{ label: 'Library', href: '/library' }, { label: 'Manage library', href: '/admin/library' }]
    : [{ label: 'Library', href: '/library' }];
}

function tabsetsFor(role) {
  return {
    employees: employeeManagementTabs(role),
    settings: settingsTabs(),
    training: trainingTabs(),
    learner: learnerTabs(role),
    library: libraryTabs(role),
  };
}

module.exports = { employeeManagementTabs, settingsTabs, trainingTabs, learnerTabs, libraryTabs, tabsetsFor };
