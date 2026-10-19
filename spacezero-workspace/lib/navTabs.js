'use strict';

// Sub-navigation (tab bars) shared by several pages, defined once so the information architecture
// stays consistent: the sidebar stays short and everything else hangs off these tabs.
function employeeManagementTabs(role) {
  if (role === 'SUPERVISOR') {
    return [
      { label: 'My Team', href: '/team' },
      { label: 'Team Intelligence', href: '/team-skills' },
      { label: 'Vacation Overview', href: '/leave' },
    ];
  }
  return [
    { label: 'Employees', href: '/admin/employees' },
    { label: 'Teams', href: '/admin/teams' },
    { label: 'Intelligence', href: '/admin/intelligence' },
    { label: 'Vacation Overview', href: '/leave' },
  ];
}

// `can` (server.js: res.locals.can) answers "may this viewer use capability X" — a Supervisor holds
// none by default, and /assignments needs training.assign, so offering the tab to everyone made
// every Training page show a tab that ends on "Access denied" for a Supervisor without the grant.
const trainingTabs = (can) => [
  { label: 'Catalog', href: '/admin/training' },
  ...(!can || can('training.assign') ? [{ label: 'Assignments', href: '/assignments' }] : []),
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

function standardsTabs(role) {
  return role === 'ADMIN'
    ? [{ label: 'Company Standards & Workflow', href: '/standards' }, { label: 'Manage', href: '/admin/standards' }]
    : [{ label: 'Company Standards & Workflow', href: '/standards' }];
}

function tabsetsFor(role, can) {
  return {
    employees: employeeManagementTabs(role),
    training: trainingTabs(can),
    learner: learnerTabs(role),
    library: libraryTabs(role),
    standards: standardsTabs(role),
  };
}

module.exports = { employeeManagementTabs, trainingTabs, learnerTabs, libraryTabs, standardsTabs, tabsetsFor };
