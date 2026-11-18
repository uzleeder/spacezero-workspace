'use strict';

// The organization-wide "how SpaceZero itself operates" configuration surface, grouped for
// display. Single source of truth, reused by the Advanced tab inside Settings (routes/admin/
// settings.js) — every route here still needs the explicit System Configuration Access capability,
// checked server-side wherever it is actually rendered; this module is display data only, never an
// authorization boundary by itself. Every link points at an existing, already-built page — adding a
// future one is adding an entry here, never a new page.
//
// Each link has one plain sentence ("what you do there") and, where it helps, a live status line from statusFor(), so
// an Admin sees what is already set up without opening every page.
const SECTIONS = [
  {
    key: 'people', title: 'People & Access', description: 'What employees need, and who may manage them.',
    links: [
      { key: 'setup', label: 'Setup Requirements', href: '/admin/setup-requirements', description: 'The checklist of tools and accounts every employee needs, and who checks each item.' },
      { key: 'supervisors', label: 'Supervisor Permissions', href: '/admin/supervisor-permissions', description: 'What each Supervisor may do for their own team. They can do nothing until you allow it.' },
      { key: 'access', label: 'System Access', href: '/admin/configuration/system-access', description: 'Which Admins may open this Advanced area.' },
    ],
  },
  {
    key: 'training', title: 'Training & Development', description: 'How Training, Skills and employee development work across the organization.',
    links: [
      { key: 'policies', label: 'Training Configuration', href: '/admin/policies', description: 'The pass mark, how long call recordings are kept, and how skill scores are counted.' },
      { key: 'skills', label: 'Skills', href: '/admin/skills', description: 'The list of skills SpaceZero measures for each role.' },
      { key: 'development', label: 'Development', href: '/admin/development', description: 'Onboarding paths, experience stages and automatic training suggestions.' },
      { key: 'certifications', label: 'Certifications', href: '/admin/certifications', description: 'What someone must complete to earn a certificate.' },
    ],
  },
  {
    key: 'governance', title: 'Company Governance', description: 'Standards, oversight and organization-wide activity.',
    links: [
      { key: 'standards', label: 'Standards', href: '/admin/standards', description: 'Company standards, responsibilities, workflows and disclosures people must read.' },
      { key: 'audit', label: 'Audit', href: '/admin/audit-logs', description: 'Who changed what, and when.' },
      { key: 'analytics', label: 'Analytics', href: '/admin/analytics', description: 'Headcount, training completion and usage numbers.' },
    ],
  },
];

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * One short status line per link key ("19 items · 2 checked by a manager"), from the organization's real data.
 * A count that cannot be read is simply left out; the page never fails because of a status line.
 */
async function statusFor(organizationId) {
  const { prisma } = require('./prisma');
  const { CAPABILITY_KEYS, SYSTEM_CONFIG_KEY } = require('./supervisorCapabilities');
  const { getSetting } = require('./orgSettings');
  const safe = (p) => p.catch(() => null);
  const [reqs, byManager, supervisors, supWith, admins, adminWith, pass, skills, paths, rules, certs, standards] = await Promise.all([
    safe(prisma.setupRequirement.count({ where: { organizationId, archivedAt: null } })),
    safe(prisma.setupRequirement.count({ where: { organizationId, archivedAt: null, kind: 'MANUAL', verification: { in: ['MANAGEMENT_VERIFICATION', 'MANAGEMENT_ONLY'] } } })),
    safe(prisma.profile.count({ where: { organizationId, role: 'SUPERVISOR', status: { not: 'ARCHIVED' } } })),
    safe(prisma.supervisorCapability.findMany({ where: { organizationId, key: { in: CAPABILITY_KEYS }, supervisor: { role: 'SUPERVISOR', status: { not: 'ARCHIVED' } } }, distinct: ['supervisorId'], select: { supervisorId: true } }).then((r) => r.length)),
    safe(prisma.profile.count({ where: { organizationId, role: 'ADMIN', status: { not: 'ARCHIVED' } } })),
    safe(prisma.supervisorCapability.findMany({ where: { organizationId, key: SYSTEM_CONFIG_KEY, supervisor: { role: 'ADMIN', status: { not: 'ARCHIVED' } } }, distinct: ['supervisorId'], select: { supervisorId: true } }).then((r) => r.length)),
    safe(getSetting(organizationId, 'training.minPassingScore')),
    safe(prisma.skill.count({ where: { organizationId, isActive: true } })),
    safe(prisma.developmentPath.count({ where: { organizationId, isActive: true } })),
    safe(prisma.assignmentRule.count({ where: { organizationId, isActive: true } })),
    safe(prisma.certificationDefinition.count({ where: { organizationId, isActive: true } })),
    safe(prisma.standardsItem.count({ where: { organizationId, archivedAt: null, currentVersionId: { not: null } } })),
  ]);
  const out = {};
  if (reqs !== null) out.setup = { text: `${plural(reqs, 'item')}${byManager ? ` · ${byManager} checked by a manager` : ''}`, tone: reqs ? 'ok' : 'todo' };
  if (supervisors !== null && supWith !== null) out.supervisors = { text: supervisors ? `${supWith} of ${plural(supervisors, 'Supervisor')} can manage their team` : 'No Supervisors yet', tone: supervisors && !supWith ? 'todo' : 'ok' };
  if (admins !== null && adminWith !== null) out.access = { text: `${adminWith} of ${plural(admins, 'Admin')} can open Advanced`, tone: 'ok' };
  if (pass !== null && pass !== undefined) out.policies = { text: `Pass mark ${pass}%`, tone: 'ok' };
  if (skills !== null) out.skills = { text: plural(skills, 'skill'), tone: skills ? 'ok' : 'todo' };
  if (paths !== null && rules !== null) out.development = { text: `${plural(paths, 'path')} · ${plural(rules, 'rule')}`, tone: paths || rules ? 'ok' : 'todo' };
  if (certs !== null) out.certifications = { text: certs ? plural(certs, 'certificate') : 'None yet', tone: certs ? 'ok' : 'todo' };
  if (standards !== null) out.standards = { text: `${standards} published`, tone: standards ? 'ok' : 'todo' };
  return out;
}

module.exports = { SECTIONS, statusFor };
