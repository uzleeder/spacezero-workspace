'use strict';

// Employee Setup checklist. The checklist is a DYNAMIC CONFIGURATION SYSTEM: every requirement is a
// SetupRequirement row an Admin creates, edits, reorders, targets and archives from the UI.
// DEFAULT_REQUIREMENTS below only seeds an organization that has no requirements yet.
//
// Completion is ALWAYS computed here on the server from stored facts:
//  - LOCAL_PHONE / ADDRESS / CREDENTIAL_VAULT requirements are derived from the profile fields and
//    the vault contents, so they cannot be ticked from a form post;
//  - MANUAL requirements follow their verification rule (employee confirmation, management
//    verification, or management only) and a COMPLETED row that does not satisfy its rule is
//    never counted, however it got into the database;
//  - company-controlled requirements (WhatsApp, Telegram) only count once company ownership has
//    been confirmed, and always need management verification.
const { prisma } = require('./prisma');

const STATUSES = ['NOT_SET_UP', 'IN_PROGRESS', 'COMPLETED', 'ISSUE', 'NOT_REQUIRED'];
const STATUS_LABEL = { NOT_SET_UP: 'Not set up', IN_PROGRESS: 'In progress', COMPLETED: 'Completed', ISSUE: 'Issue', NOT_REQUIRED: 'Not required' };

// Suggestions only: a category is free text, so an Admin is never blocked by a list that does not fit.
const CATEGORIES = ['Equipment', 'System Access', 'Communication', 'Account', 'Extension / Software', 'Company Setup', 'Employee Information', 'Security / Credentials', 'Other'];

const VERIFICATIONS = ['EMPLOYEE_CONFIRMATION', 'MANAGEMENT_VERIFICATION', 'MANAGEMENT_ONLY'];
const VERIFICATION_LABEL = {
  EMPLOYEE_CONFIRMATION: 'Employee confirmation',
  MANAGEMENT_VERIFICATION: 'Management verification',
  MANAGEMENT_ONLY: 'Management only',
};
const VERIFICATION_HELP = {
  EMPLOYEE_CONFIRMATION: 'The employee ticks "I have this" and that is enough.',
  MANAGEMENT_VERIFICATION: 'The employee confirms, then a Supervisor or Admin must verify before it counts.',
  MANAGEMENT_ONLY: 'Only a Supervisor or Admin can mark it completed.',
};
const AUDIENCES = ['ALL_EMPLOYEES', 'ROLES', 'SPECIFIC'];
const ROLES = ['TRAVEL_AGENT', 'FLIGHT_EXPERT', 'SUPERVISOR', 'ADMIN'];

// Self-attestable items below (personal equipment/tool access, not company-shared accounts) default
// to EMPLOYEE_CONFIRMATION: only the employee themselves can really know whether they have a PC or
// are logged into their GDS, so routing every one of these through a supervisor/admin verification
// step just blocks self-service setup without adding a real check. WhatsApp/Telegram stay excluded —
// they are companyControlled, and effectiveRule() forces MANAGEMENT_VERIFICATION for those regardless
// of this field, so the setting below cannot weaken company-owned accounts.
const DEFAULT_REQUIREMENTS = [
  { key: 'pc', label: 'PC', category: 'Equipment', verification: 'EMPLOYEE_CONFIRMATION' },
  { key: 'egf', label: 'EGF', category: 'System Access', credentialSystem: true, verification: 'EMPLOYEE_CONFIRMATION' },
  { key: 'ovago', label: 'Ovago', category: 'System Access', credentialSystem: true, verification: 'EMPLOYEE_CONFIRMATION' },
  { key: 'cockpit', label: 'Cockpit', category: 'System Access', credentialSystem: true, verification: 'EMPLOYEE_CONFIRMATION' },
  { key: 'gds', label: 'GDS', category: 'System Access', credentialSystem: true, verification: 'EMPLOYEE_CONFIRMATION' },
  { key: 'gmail', label: 'Gmail', category: 'Account', credentialSystem: true, verification: 'EMPLOYEE_CONFIRMATION' },
  { key: 'crm', label: 'CRM', category: 'System Access', credentialSystem: true, verification: 'EMPLOYEE_CONFIRMATION' },
  { key: 'dialpad', label: 'Dialpad', category: 'Communication', credentialSystem: true, verification: 'EMPLOYEE_CONFIRMATION' },
  { key: 'whatsapp', label: 'WhatsApp', category: 'Communication', companyControlled: true, description: 'Company-controlled number with company ownership/recovery confirmed.' },
  { key: 'telegram', label: 'Telegram', category: 'Communication', required: false, companyControlled: true, allowPersonalAccount: true, description: 'Optional. Either a company-controlled account, or a personal number used for work.' },
  { key: 'email_signature', label: 'Email Signature', category: 'Account', verification: 'EMPLOYEE_CONFIRMATION' },
  { key: 'virtual_card', label: 'Virtual Card', category: 'Company Setup', description: 'Correct employee/company details, WhatsApp and phone numbers verified. Do not record card numbers here.', verification: 'EMPLOYEE_CONFIRMATION' },
  { key: 'bookmarks', label: 'Bookmarks', category: 'Extension / Software', verification: 'EMPLOYEE_CONFIRMATION' },
  { key: 'flight_search_extension', label: 'Flight Search Extension', category: 'Extension / Software', verification: 'EMPLOYEE_CONFIRMATION' },
  { key: 'google_flights_extension', label: 'Google Flights Extension', category: 'Extension / Software', verification: 'EMPLOYEE_CONFIRMATION' },
  { key: 'credential_vault', label: 'Passwords / Credential Vault', category: 'Security / Credentials', kind: 'CREDENTIAL_VAULT', description: 'Complete when a vault entry exists for every required work system.' },
  { key: 'local_phone', label: 'Local Phone Number', category: 'Employee Information', kind: 'LOCAL_PHONE' },
  { key: 'current_address', label: 'Current Living Address', category: 'Employee Information', kind: 'ADDRESS' },
  { key: 'passport_details', label: 'Passport Details', category: 'Employee Information', kind: 'PASSPORT', description: 'Passport Number and Expiration Date on file. The number itself is never shown here.' },
];
const DEFAULT_CATEGORY = new Map(DEFAULT_REQUIREMENTS.map((r) => [r.key, r.category]));

// The seed/migrate pass below costs several queries and is called many times per page view (every
// setup calculation starts with it). Everything it does is a one-time step per organization, so once
// it has completed in this process it is not repeated.
const ensuredOrganizations = new Set();
async function ensureDefaultRequirements(organizationId) {
  if (ensuredOrganizations.has(organizationId)) return;
  await seedOrMigrateRequirements(organizationId);
  ensuredOrganizations.add(organizationId);
}

async function seedOrMigrateRequirements(organizationId) {
  // Only seed an organization with NO requirement rows at all, so an Admin who archives or
  // deletes a default is never surprised by it coming back.
  if (!(await prisma.setupRequirement.count({ where: { organizationId } }))) {
    await prisma.setupRequirement.createMany({
      data: DEFAULT_REQUIREMENTS.map((r, i) => ({
        organizationId,
        key: r.key,
        label: r.label,
        category: r.category,
        description: r.description || null,
        kind: r.kind || 'MANUAL',
        required: r.required === undefined ? true : Boolean(r.required),
        companyControlled: Boolean(r.companyControlled),
        allowPersonalAccount: Boolean(r.allowPersonalAccount),
        credentialSystem: Boolean(r.credentialSystem),
        verification: r.verification || 'MANAGEMENT_VERIFICATION',
        displayOrder: i,
      })),
    });
    return;
  }
  // Requirements created before categories existed: label the built-in ones once, never overwrite an Admin's choice.
  const uncategorised = await prisma.setupRequirement.findMany({ where: { organizationId, category: null }, select: { id: true, key: true } });
  for (const row of uncategorised) {
    const category = DEFAULT_CATEGORY.get(row.key);
    if (category) await prisma.setupRequirement.update({ where: { id: row.id }, data: { category } });
  }
  // One-time relaxation for organizations whose Telegram requirement still has its old, stricter
  // shape (required + company-only, never customized by an Admin): Telegram is now optional and
  // accepts a personal work number. An Admin who already edited it away from these exact defaults
  // is never overwritten.
  await prisma.setupRequirement.updateMany({
    where: { organizationId, key: 'telegram', required: true, companyControlled: true, allowPersonalAccount: false },
    data: { required: false, allowPersonalAccount: true },
  });
  // NOTE: the self-attestable default items (PC, tool/account access, extensions) moved from
  // MANAGEMENT_VERIFICATION to EMPLOYEE_CONFIRMATION above in DEFAULT_REQUIREMENTS — that only
  // affects organizations seeded from now on. An existing organization's already-seeded rows are
  // migrated once via scripts/relax-self-service-setup.cjs (run manually, not here): unlike the
  // Telegram/Passport Details migrations below, "is this row still at MANAGEMENT_VERIFICATION" is not
  // a safe signal to re-check on every request — that is the exact value an Admin might deliberately
  // choose again later, and re-running this on every call would silently overwrite that choice.
  // One-time addition of Passport Details as a new mandatory Setup requirement: every organization
  // gets it added once if missing, regardless of when its other requirements were first seeded, so
  // existing accounts pick it up without resetting any other Setup progress. An organization that
  // already has this key (an Admin later edited or archived it) is never touched again.
  if (!(await prisma.setupRequirement.count({ where: { organizationId, key: 'passport_details' } }))) {
    const maxOrder = await prisma.setupRequirement.aggregate({ where: { organizationId }, _max: { displayOrder: true } });
    const seed = DEFAULT_REQUIREMENTS.find((r) => r.key === 'passport_details');
    await prisma.setupRequirement.create({
      data: { organizationId, key: seed.key, label: seed.label, category: seed.category, description: seed.description, kind: seed.kind, required: true, displayOrder: (maxOrder._max.displayOrder ?? -1) + 1 },
    });
  }
}

function rolesList(requirement) {
  if (!requirement.rolesJson) return [];
  try { return JSON.parse(requirement.rolesJson); } catch { return []; }
}

/**
 * Does this requirement apply to this employee? Pure.
 *  ALL_EMPLOYEES: everyone. ROLES: the chosen roles. SPECIFIC: nobody by role.
 * Employees and teams the Admin assigned it to are ADDED in every mode.
 */
function requirementApplies(requirement, { role, id, teamIds = [] }, targets = []) {
  if (requirement.audience === 'ALL_EMPLOYEES') return true;
  if (requirement.audience === 'ROLES' && rolesList(requirement).includes(role)) return true;
  return targets.some((t) => t.requirementId === requirement.id && (t.profileId === id || (t.teamId && teamIds.includes(t.teamId))));
}

/** Company-controlled items can never be completed on the employee's word alone. */
function effectiveRule(requirement) {
  const rule = requirement.verification || 'MANAGEMENT_VERIFICATION';
  return requirement.companyControlled && rule === 'EMPLOYEE_CONFIRMATION' ? 'MANAGEMENT_VERIFICATION' : rule;
}

const PHONE_DIGITS = /^\+?[0-9][0-9\s().-]{5,24}$/;
function isValidLocalPhone(value) {
  if (typeof value !== 'string' || !PHONE_DIGITS.test(value.trim())) return false;
  const digits = value.replace(/\D/g, '').length;
  return digits >= 7 && digits <= 15;
}

/** Percentage shown to people: rounded, but 100 is reserved for "everything completed". */
function percentOf(completed, counted) {
  if (!counted || completed === counted) return 100;
  return Math.min(99, Math.round((completed / counted) * 100));
}

/**
 * Pure calculation. Given a profile, the org's requirements, the profile's stored items and the
 * systemKeys present in their vault, returns per-requirement effective status and the overall
 * readiness. Nothing here trusts client input.
 * An employee who has not been activated yet (status INVITED) has not started setup: they are
 * reported as "Setup Not Started" and never counted as "Setup Required".
 */
function computeSetup({ profile, requirements, items, vaultSystemKeys, hasAddress, targets = [], teamIds = [], supervisorName = null, now = new Date() }) {
  const byRequirement = new Map(items.map((i) => [i.requirementId, i]));
  const vaultKeys = new Set(vaultSystemKeys);
  const subject = { role: profile.role, id: profile.id, teamIds };
  const applicable = requirements.filter((r) => !r.archivedAt && requirementApplies(r, subject, targets));

  const rows = applicable.map((requirement) => {
    const item = byRequirement.get(requirement.id) || null;
    const exempt = item?.status === 'NOT_REQUIRED';
    const rule = effectiveRule(requirement);
    let status = item?.status || 'NOT_SET_UP';
    let derived = false;
    let awaitingVerification = false;

    if (requirement.kind === 'LOCAL_PHONE') {
      derived = true;
      status = exempt ? 'NOT_REQUIRED' : isValidLocalPhone(profile.localPhone || '') ? 'COMPLETED' : 'NOT_SET_UP';
    } else if (requirement.kind === 'ADDRESS') {
      derived = true;
      status = exempt ? 'NOT_REQUIRED' : hasAddress ? 'COMPLETED' : 'NOT_SET_UP';
    } else if (requirement.kind === 'PASSPORT') {
      // Complete once both fields exist — expiration status (Valid/Expiring/Expired) is a
      // separate, ongoing operational concern (readiness, notifications, filters), not something
      // that reopens this one-time onboarding requirement once it has been provided.
      derived = true;
      status = exempt ? 'NOT_REQUIRED' : profile.passportNumberEnc && profile.passportExpiresAt ? 'COMPLETED' : 'NOT_SET_UP';
    } else if (requirement.kind === 'CREDENTIAL_VAULT') {
      derived = true;
      if (exempt) status = 'NOT_REQUIRED';
      else {
        const needed = applicable.filter((r) => r.credentialSystem && r.required && byRequirement.get(r.id)?.status !== 'NOT_REQUIRED');
        const present = needed.filter((r) => vaultKeys.has(r.key));
        status = needed.length && present.length === needed.length ? 'COMPLETED' : present.length ? 'IN_PROGRESS' : 'NOT_SET_UP';
        if (!needed.length) status = 'COMPLETED';
      }
    } else if (status === 'COMPLETED') {
      // The verification rule is enforced here, not only at the form: a COMPLETED row that lacks
      // the required proof (management verification / employee confirmation) does not count.
      const managementProof = Boolean(item.verifiedById || item.verifiedAt);
      const proven = rule === 'EMPLOYEE_CONFIRMATION' ? managementProof || Boolean(item.employeeConfirmedAt) : managementProof;
      // A company-controlled item normally needs company ownership confirmed. When the requirement
      // allows a personal account too, recording that choice (accountType) satisfies it instead.
      const personalAccountOk = requirement.allowPersonalAccount && item.accountType === 'PERSONAL_WORK';
      if (!proven) status = 'IN_PROGRESS';
      else if (requirement.companyControlled && !item.companyControlConfirmed && !personalAccountOk) status = 'IN_PROGRESS'; // ticked, but neither company ownership nor a personal-account choice is on record yet
    }
    if (!derived && status === 'IN_PROGRESS' && item?.employeeConfirmedAt) awaitingVerification = true;

    // Responsibility and deadline (both optional): a fixed date wins over "N days after the start date".
    const dueAt = requirement.dueDate ? new Date(requirement.dueDate) : (Number.isInteger(requirement.dueDays) && profile.employmentStartDate ? new Date(new Date(profile.employmentStartDate).getTime() + requirement.dueDays * 86400000) : null);
    const ownerLabel = requirement.ownerRole === 'SUPERVISOR' ? (supervisorName ? `Supervisor (${supervisorName})` : 'Supervisor') : requirement.ownerRole === 'ADMIN' ? 'Admin' : requirement.ownerRole === 'EMPLOYEE' ? 'Employee' : null;
    const open = requirement.required && status !== 'COMPLETED' && status !== 'NOT_REQUIRED';
    return {
      ownerRole: requirement.ownerRole || null,
      ownerLabel,
      dueAt,
      overdue: Boolean(open && dueAt && dueAt < now && profile.status !== 'INVITED'),
      requirement,
      item,
      status,
      derived,
      rule,
      awaitingVerification,
      awaitingCompanyControl: Boolean(requirement.companyControlled && item?.status === 'COMPLETED' && !item.companyControlConfirmed && !(requirement.allowPersonalAccount && item.accountType === 'PERSONAL_WORK')),
      counts: requirement.required && status !== 'NOT_REQUIRED',
    };
  });

  // Archived requirements no longer count, but what an employee already had on record stays visible.
  const history = requirements
    .filter((r) => r.archivedAt && byRequirement.has(r.id))
    .map((requirement) => ({ requirement, item: byRequirement.get(requirement.id) }));

  const counted = rows.filter((r) => r.counts);
  const completed = counted.filter((r) => r.status === 'COMPLETED');
  const notStarted = profile.status === 'INVITED';
  const hasIssue = !notStarted && counted.some((r) => r.status === 'ISSUE');
  const overdueRows = notStarted ? [] : counted.filter((r) => r.overdue);
  const percent = notStarted ? 0 : percentOf(completed.length, counted.length);
  const fullySetUp = !notStarted && percent === 100;
  return {
    rows,
    history,
    required: counted.length,
    completed: completed.length,
    percent,
    hasIssue,
    overdueRows,
    overdueCount: overdueRows.length,
    fullySetUp,
    notStarted,
    label: notStarted ? 'Setup Not Started' : fullySetUp ? 'Fully Set Up' : 'Setup Required',
    missingKeys: notStarted ? [] : counted.filter((r) => r.status !== 'COMPLETED').map((r) => r.requirement.key),
  };
}

/** Loads everything computeSetup needs for many profiles at once (single org). */
async function loadSetupForProfiles(organizationId, profiles) {
  await ensureDefaultRequirements(organizationId);
  const ids = profiles.map((p) => p.id);
  const supervisions = await prisma.supervisorAssignment.findMany({ where: { agentId: { in: ids }, unassignedAt: null }, select: { agentId: true, supervisor: { select: { fullName: true } } } });
  const supervisorOf = new Map(supervisions.map((s) => [s.agentId, s.supervisor.fullName]));
  const [requirements, items, credentials, memberships, targets] = await Promise.all([
    prisma.setupRequirement.findMany({ where: { organizationId }, orderBy: { displayOrder: 'asc' } }),
    prisma.employeeSetupItem.findMany({ where: { profileId: { in: ids } }, include: { verifiedBy: { select: { fullName: true } } } }),
    prisma.credential.findMany({ where: { ownerId: { in: ids } }, select: { ownerId: true, systemKey: true } }),
    prisma.teamMembership.findMany({ where: { profileId: { in: ids } }, select: { profileId: true, teamId: true } }),
    prisma.setupRequirementTarget.findMany({ where: { requirement: { organizationId } } }),
  ]);
  const result = new Map();
  for (const profile of profiles) {
    result.set(profile.id, computeSetup({
      profile,
      requirements,
      items: items.filter((i) => i.profileId === profile.id),
      vaultSystemKeys: credentials.filter((c) => c.ownerId === profile.id && c.systemKey).map((c) => c.systemKey),
      hasAddress: Boolean(profile.currentAddressEnc),
      targets,
      teamIds: memberships.filter((m) => m.profileId === profile.id).map((m) => m.teamId),
      supervisorName: supervisorOf.get(profile.id) || null,
    }));
  }
  return result;
}

async function loadSetupForProfile(organizationId, profile) {
  return (await loadSetupForProfiles(organizationId, [profile])).get(profile.id);
}

/** Does this requirement apply to this one employee right now? (used by the write routes) */
async function requirementAppliesToProfile(requirement, profile) {
  if (requirement.audience === 'ALL_EMPLOYEES') return true;
  const [memberships, targets] = await Promise.all([
    prisma.teamMembership.findMany({ where: { profileId: profile.id }, select: { teamId: true } }),
    prisma.setupRequirementTarget.findMany({ where: { requirementId: requirement.id } }),
  ]);
  return requirementApplies(requirement, { role: profile.role, id: profile.id, teamIds: memberships.map((m) => m.teamId) }, targets);
}

module.exports = {
  STATUSES, STATUS_LABEL, CATEGORIES, VERIFICATIONS, VERIFICATION_LABEL, VERIFICATION_HELP, AUDIENCES, ROLES, DEFAULT_REQUIREMENTS,
  ensureDefaultRequirements, rolesList, requirementApplies, requirementAppliesToProfile, effectiveRule, isValidLocalPhone,
  computeSetup, loadSetupForProfiles, loadSetupForProfile,
};
