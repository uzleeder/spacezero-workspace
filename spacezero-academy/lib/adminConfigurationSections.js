'use strict';

// The organization-wide "how SpaceZero itself operates" configuration surface, grouped for
// display. Single source of truth, reused by the Advanced tab inside Settings (routes/admin/
// settings.js) — every route here still needs the explicit System Configuration Access capability,
// checked server-side wherever it is actually rendered; this module is display data only, never an
// authorization boundary by itself. Every link points at an existing, already-built page — adding a
// future one is adding an entry here, never a new page.
const SECTIONS = [
  {
    key: 'people', title: 'People & Access', description: 'What employees need, and who may manage them.',
    links: [
      { label: 'Setup Requirements', href: '/admin/setup-requirements', description: 'Define what employees need for their role and readiness — mandatory or optional, verification rules, which roles they apply to.' },
      { label: 'Supervisor Permissions', href: '/admin/supervisor-permissions', description: 'Control what management actions Supervisors may perform, scoped to their own team. Granting a single Supervisor is also available directly from their Employees & Teams profile.' },
      { label: 'System Access', href: '/admin/configuration/system-access', description: 'Manage which Admins may reach this Advanced area at all.' },
    ],
  },
  {
    key: 'training', title: 'Training & Development', description: 'How Training, Skills and employee development work across the organization.',
    links: [
      { label: 'Training Configuration', href: '/admin/policies', description: 'Organization-wide Training rules: minimum passing score, call recording retention, and Skill Graph scoring weights.' },
      { label: 'Skills', href: '/admin/skills', description: 'Manage the skills SpaceZero tracks — the Skill Graph catalog, categories and taxonomy.' },
      { label: 'Development', href: '/admin/development', description: 'Manage onboarding, tenure bands and employee development automation: paths, rules and training recommendations.' },
      { label: 'Certifications', href: '/admin/certifications', description: 'Manage certification requirements (courses, assessments, skill thresholds) and validity.' },
    ],
  },
  {
    key: 'governance', title: 'Company Governance', description: 'Standards, oversight and organization-wide activity.',
    links: [
      { label: 'Standards', href: '/admin/standards', description: 'Configure Company Standards, Responsibilities, Workflows and Required Disclosures.' },
      { label: 'Audit', href: '/admin/audit-logs', description: 'Review important configuration and security activity, organization-wide.' },
      { label: 'Analytics', href: '/admin/analytics', description: 'Headcount, training completion and platform-wide usage counts.' },
    ],
  },
];

module.exports = { SECTIONS };
