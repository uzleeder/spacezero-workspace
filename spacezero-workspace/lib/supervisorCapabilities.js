'use strict';

// Admin-grantable Supervisor management capabilities. A Supervisor has NONE of these by default —
// an Admin must explicitly grant each one, scoped only within that Supervisor's existing team
// boundary (this module never widens WHO a Supervisor can act on, only WHAT they may do to people
// already in their scope — the actual "may I act on this person" check stays in lib/authz.js /
// lib/employeeAccess.js, unchanged). Adding a future capability is adding one entry to CAPABILITIES;
// the admin UI and audit trail need no further changes.
const { prisma } = require('./prisma');

const CAPABILITIES = [
  { key: 'setup.view', category: 'Employee Management', label: 'View Team Setup', description: 'See the Setup tab and checklist for their team.' },
  { key: 'setup.manage', category: 'Employee Management', label: 'Manage Team Setup', description: 'Use the compact checklist and the advanced editor to check off and update their team’s setup items.' },
  { key: 'setup.verify', category: 'Employee Management', label: 'Verify Team Setup', description: 'Approve an item an employee already self-confirmed (management verification) into Completed.' },
  // High-sensitivity, deliberately separate from every Setup capability above: "Manage Team Setup"
  // answers "does this employee have the required access", never "what is their password" — granting
  // it must never imply Credential Vault access. Off by default for every Supervisor, the same as
  // every other capability here; nothing seeds it automatically for anyone.
  { key: 'credentials.view_team', category: 'Credential Vault (high sensitivity)', label: 'View Team Credentials', description: 'Reveal and manage the stored work credentials of Travel Agents on their team. Does not extend to another Supervisor’s team, and is never implied by any Setup capability.' },
  // Supervisor Training Creation. Each is independent — granting one never implies another.
  // 'training.create'/'training.revise' only ever apply to courses this Supervisor created
  // themselves (lib/aiPractice's course-ownership scoping); they can prepare a full draft but the
  // final "Approve & Send to Training" publish step stays Admin-only regardless of any grant here.
  { key: 'training.create', category: 'Training', label: 'Create & Prepare Training', description: 'Use AI Practice to upload material, analyze it, build practice and prepare a draft, then submit it for Admin approval. Cannot approve or publish their own submission.' },
  { key: 'training.revise', category: 'Training', label: 'Revise Training Drafts', description: 'Propose a new version of their own already-published Training. The new version needs Admin approval before it replaces the live one; the current version keeps serving employees until then.' },
  { key: 'training.assign', category: 'Training', label: 'Assign Approved Training', description: 'Assign published Training from the approved catalog to their own team. Does not grant creating, publishing, approving or editing Training globally.' },
  { key: 'training.viewHistory', category: 'Training', label: 'View Team Training History & Reassign', description: 'See assignment/attempt history (including past attempts and scores) for their own team, reassign Training, and request a retake.' },
  // High-sensitivity, same reasoning as credentials.view_team: without this, a Supervisor managing
  // an employee's Setup sees only a Valid/Expiring Soon/Expired passport status word, never the
  // actual number. Off by default, never implied by any Setup capability, and never lets a
  // Supervisor edit the passport details themselves — only an Admin or the employee can do that.
  { key: 'passport.viewNumber', category: 'Employee Information (high sensitivity)', label: 'View Team Passport Numbers', description: 'Reveal the full Passport Number (not just the status) for Travel Agents/Flight Experts on their team, after re-entering their own password. Never implied by Manage Team Setup or any other capability.' },
];
const CAPABILITY_KEYS = CAPABILITIES.map((c) => c.key);
const CATEGORIES = [...new Set(CAPABILITIES.map((c) => c.category))];

async function capabilitiesFor(supervisorId) {
  const rows = await prisma.supervisorCapability.findMany({ where: { supervisorId }, select: { key: true } });
  return new Set(rows.map((r) => r.key));
}

// actor is the profile taking the action; ADMIN is always fully capable, matching every other
// `actor.role === 'ADMIN' ||` gate already in this codebase.
async function hasCapability(actor, key) {
  if (!actor) return false;
  if (actor.role === 'ADMIN') return true;
  if (actor.role !== 'SUPERVISOR') return false;
  return Boolean(await prisma.supervisorCapability.findUnique({ where: { organizationId_supervisorId_key: { organizationId: actor.organizationId, supervisorId: actor.id, key } } }));
}

// Where a notification about someone's Setup should send THIS recipient. A Supervisor without
// setup.view gets "Access denied" on the Setup page itself, but can always open the person's profile
// overview (/team/:id) — so a notification must not link them to the page that 403s.
async function setupLinkFor(recipientId, personId) {
  const recipient = await prisma.profile.findUnique({ where: { id: recipientId }, select: { id: true, role: true } });
  if (recipient && recipient.role === 'SUPERVISOR' && recipient.id !== personId && !(await capabilitiesFor(recipient.id)).has('setup.view')) return `/team/${personId}`;
  return `/employees/${personId}/setup`;
}

// Convenience for the employee-record tab bar (own setup is always visible; someone else's is
// gated on setup.view for a Supervisor, always visible to an Admin via hasCapability's own rule).
async function canViewSetupTab(actor, ctx) {
  if (ctx.isSelf) return true;
  return hasCapability(actor, 'setup.view');
}

// ------------------------------------------------------------------ System Configuration Access
// "Admin + System Configuration Access" (spec: Task 3) = an Admin who may additionally change how
// SpaceZero itself operates (Setup Requirements, Supervisor/Training permission grants, Standards
// authoring, Training/Skill rules, the Audit Log) — never a separate role name, and never automatic
// from being Admin. Reuses the exact same SupervisorCapability table and grant/revoke/audit pattern
// as every capability above — this is a grant to a Profile, not something inherently tied to the
// Supervisor role; the column stays named supervisorId to avoid an unrelated schema rename.
const SYSTEM_CONFIG_KEY = 'system.config_access';

// Deliberately NOT hasCapability(): that function's unconditional `role === 'ADMIN' -> true` bypass
// is correct for every Supervisor-facing capability above (an Admin always outranks a Supervisor
// grant) but wrong here — an Admin must hold an explicit grant for THIS key, the same as anyone else.
async function hasSystemConfigAccess(actor) {
  if (!actor || actor.role !== 'ADMIN') return false;
  return Boolean(await prisma.supervisorCapability.findUnique({ where: { organizationId_supervisorId_key: { organizationId: actor.organizationId, supervisorId: actor.id, key: SYSTEM_CONFIG_KEY } } }));
}

/**
 * One-time bootstrap, the same idiom as lib/employeeSetup.js#ensureDefaultRequirements: acts only
 * when an organization has NEVER made a System Configuration Access decision (zero grants of this
 * key exist at all) — every Admin ACTIVE at that moment is seeded, so nothing already relying on
 * Admin-only access breaks on deploy. An organization where an authorized Admin has since granted
 * or revoked even once is never touched again. Nothing here checks a name: in the real Above9
 * organization this seeds exactly Ali Ahmed, Tom Allen and Joe Godwin because they are, right now,
 * its only three ADMIN profiles — a different organization seeds whoever its admins are.
 */
async function ensureInitialSystemConfigAccess(organizationId) {
  if (await prisma.supervisorCapability.count({ where: { organizationId, key: SYSTEM_CONFIG_KEY } })) return;
  const admins = await prisma.profile.findMany({ where: { organizationId, role: 'ADMIN', status: 'ACTIVE' }, select: { id: true } });
  if (!admins.length) return;
  await prisma.supervisorCapability.createMany({ data: admins.map((a) => ({ organizationId, supervisorId: a.id, key: SYSTEM_CONFIG_KEY, grantedById: a.id })) });
}

/** Express middleware for every "Admin Configuration" route: authenticated + Admin + the explicit grant. */
function requireSystemConfigAccess(req, res, next) {
  const actor = req.profile;
  if (!actor) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl || '/dashboard')}`);
  ensureInitialSystemConfigAccess(actor.organizationId)
    .then(() => hasSystemConfigAccess(actor))
    .then((ok) => (ok ? next() : res.status(403).render('forbidden')))
    .catch(next);
}

module.exports = {
  CAPABILITIES, CAPABILITY_KEYS, CATEGORIES, capabilitiesFor, hasCapability, canViewSetupTab, setupLinkFor,
  SYSTEM_CONFIG_KEY, hasSystemConfigAccess, ensureInitialSystemConfigAccess, requireSystemConfigAccess,
};
