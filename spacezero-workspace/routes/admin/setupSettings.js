'use strict';

// Settings → Advanced → Setup Requirements, plus Training Configuration (passing score, call
// retention, Skill Graph scoring). Requires System Configuration Access, checked on the server for
// every request. The checklist is configuration, not code: an Admin adds tools, picks who they
// apply to (all employees, roles, specific people or teams), chooses how completion is verified,
// reorders, edits and archives — and every configuration change is audited with the old and new
// values. Archiving never deletes an employee's setup history.
const express = require('express');
const router = express.Router();

const { prisma } = require('../../lib/prisma');
const { requireAdmin } = require('../../lib/authMiddleware');
const { requireSystemConfigAccess } = require('../../lib/supervisorCapabilities');
// Setup Requirements and Policies are "Admin Configuration" (Task 3): daily employee management
// stays Admin-only, but changing these organization-wide rules needs the explicit, Admin-grantable
// System Configuration Access capability too — checked server-side, not just hidden from the sidebar.
const advanced = [requireAdmin, requireSystemConfigAccess];
const { logAudit } = require('../../lib/audit');
const { roleLabel } = require('../../lib/roles');
const { excludeOtherAdminsTestProfiles } = require('../../lib/loginAsScope');
const {
  CATEGORIES, VERIFICATIONS, VERIFICATION_LABEL, VERIFICATION_HELP, AUDIENCES, ROLES,
  ensureDefaultRequirements, rolesList, loadSetupForProfiles,
} = require('../../lib/employeeSetup');
const { DEFAULT_SCORING, SOURCE_KEYS, TYPE_KEYS, getSetting, setSetting, isValidSetting } = require('../../lib/orgSettings');
const { recomputeOrganization } = require('../../lib/scoring');
const { purgeExpiredCalls } = require('../../lib/callRetention');

const asList = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]).map(String);
const text = (v, max) => String(v ?? '').trim().slice(0, max);
const notFound = (res) => res.status(404).render('not-found', { layout: false });
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

function slugKey(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'item';
}

async function uniqueKey(organizationId, label) {
  const base = slugKey(label);
  let key = base;
  for (let n = 2; await prisma.setupRequirement.findUnique({ where: { organizationId_key: { organizationId, key } } }); n += 1) key = `${base}_${n}`;
  return key;
}

async function loadOwn(admin, id) {
  return prisma.setupRequirement.findFirst({ where: { id, organizationId: admin.organizationId }, include: { targets: true } });
}

// ------------------------------------------------------------------ reading the form
/** Validates and normalizes the requirement form. Never trusts the audience lists: ids are checked against the org. */
async function readForm(admin, body, existing) {
  const errors = [];
  const label = text(body.label, 80);
  if (label.length < 2) errors.push('Enter a name for the requirement.');

  const chosen = text(body.category, 40);
  const category = chosen === '__new' ? text(body.newCategory, 40) : chosen;
  const audience = AUDIENCES.includes(body.audience) ? body.audience : 'ALL_EMPLOYEES';
  const roles = asList(body.roles).filter((r) => ROLES.includes(r));
  if (audience === 'ROLES' && roles.length === 0) errors.push('Choose at least one role, or apply it to all employees.');

  const requestedProfiles = asList(body.targetProfileIds);
  const requestedTeams = asList(body.targetTeamIds);
  const [profiles, teams] = await Promise.all([
    requestedProfiles.length ? prisma.profile.findMany({ where: { id: { in: requestedProfiles }, organizationId: admin.organizationId, status: { not: 'ARCHIVED' }, ...excludeOtherAdminsTestProfiles(admin) }, select: { id: true } }) : [],
    requestedTeams.length ? prisma.team.findMany({ where: { id: { in: requestedTeams }, organizationId: admin.organizationId, archivedAt: null }, select: { id: true } }) : [],
  ]);
  const profileIds = profiles.map((p) => p.id);
  const teamIds = teams.map((t) => t.id);
  if (audience === 'SPECIFIC' && profileIds.length + teamIds.length === 0) errors.push('Choose at least one employee or team for a specific-people requirement.');

  const isManual = !existing || existing.kind === 'MANUAL';
  const verification = VERIFICATIONS.includes(body.verification) ? body.verification : (existing ? existing.verification : 'MANAGEMENT_VERIFICATION');
  const position = /^\d{1,3}$/.test(String(body.position || '')) ? Number(body.position) : null;

  const ownerRole = ['EMPLOYEE', 'SUPERVISOR', 'ADMIN'].includes(body.ownerRole) ? body.ownerRole : null;
  const dueDays = /^\d{1,3}$/.test(String(body.dueDays || '')) ? Number(body.dueDays) : null;
  const rawDate = String(body.dueDate || '').trim();
  const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) && !Number.isNaN(new Date(`${rawDate}T00:00:00.000Z`).getTime()) ? new Date(`${rawDate}T00:00:00.000Z`) : null;
  if (rawDate && !dueDate) errors.push('Enter a valid due date.');

  const values = {
    ownerRole, dueDays, dueDate,
    label,
    description: text(body.description, 300),
    category: category || 'Other',
    audience,
    roles: audience === 'ROLES' ? roles : [],
    required: body.required !== 'optional',
    verification,
    companyControlled: isManual ? body.companyControlled === '1' : existing.companyControlled,
    allowPersonalAccount: isManual ? body.allowPersonalAccount === '1' : existing.allowPersonalAccount,
    credentialSystem: isManual ? body.credentialSystem === '1' : existing.credentialSystem,
    position,
    profileIds: audience === 'ALL_EMPLOYEES' ? [] : profileIds,
    teamIds: audience === 'ALL_EMPLOYEES' ? [] : teamIds,
  };
  return { values, errors };
}

function valuesFromRow(row) {
  return {
    ownerRole: row.ownerRole || null, dueDays: row.dueDays ?? null, dueDate: row.dueDate || null,
    label: row.label,
    description: row.description || '',
    category: row.category || 'Other',
    audience: row.audience,
    roles: rolesList(row),
    required: row.required,
    verification: row.verification,
    companyControlled: row.companyControlled,
    allowPersonalAccount: row.allowPersonalAccount,
    credentialSystem: row.credentialSystem,
    position: null,
    profileIds: row.targets.filter((t) => t.profileId).map((t) => t.profileId),
    teamIds: row.targets.filter((t) => t.teamId).map((t) => t.teamId),
  };
}

const emptyValues = () => ({ ownerRole: null, dueDays: null, dueDate: null, label: '', description: '', category: 'System Access', audience: 'ALL_EMPLOYEES', roles: [], required: true, verification: 'MANAGEMENT_VERIFICATION', companyControlled: false, allowPersonalAccount: false, credentialSystem: false, position: null, profileIds: [], teamIds: [] });

async function renderForm(res, admin, { mode, requirement = null, values, errors = [], status = 200 }) {
  const [employees, teams, used] = await Promise.all([
    prisma.profile.findMany({ where: { organizationId: admin.organizationId, status: { not: 'ARCHIVED' }, ...excludeOtherAdminsTestProfiles(admin) }, orderBy: { fullName: 'asc' }, select: { id: true, fullName: true, role: true } }),
    prisma.team.findMany({ where: { organizationId: admin.organizationId, archivedAt: null }, orderBy: { name: 'asc' } }),
    prisma.setupRequirement.findMany({ where: { organizationId: admin.organizationId, category: { not: null } }, distinct: ['category'], select: { category: true } }),
  ]);
  const categories = [...new Set([...CATEGORIES, ...used.map((u) => u.category)])];
  res.status(status).render('admin/setup-requirement-form', {
    title: mode === 'new' ? 'Add setup requirement' : 'Edit setup requirement',
    mode, requirement, values, errors, employees, teams, categories,
    ROLES, roleLabel, VERIFICATIONS, VERIFICATION_LABEL, VERIFICATION_HELP,
  });
}

// ------------------------------------------------------------------ audit helpers
const auditDiff = (before, after) => {
  const changes = {};
  for (const key of ['label', 'category', 'audience', 'required', 'verification', 'companyControlled', 'allowPersonalAccount', 'credentialSystem', 'ownerRole', 'dueDays']) {
    if (before[key] !== after[key]) changes[key] = { from: before[key], to: after[key] };
  }
  if (String(before.dueDate || '') !== String(after.dueDate || '')) changes.dueDate = { from: before.dueDate, to: after.dueDate };
  if (!sameSet(before.roles, after.roles)) changes.roles = { from: before.roles, to: after.roles };
  if (before.description !== after.description) changes.description = { changed: true };
  return changes;
};

async function syncTargets(admin, requirementId, before, after) {
  const addProfiles = after.profileIds.filter((id) => !before.profileIds.includes(id));
  const removeProfiles = before.profileIds.filter((id) => !after.profileIds.includes(id));
  const addTeams = after.teamIds.filter((id) => !before.teamIds.includes(id));
  const removeTeams = before.teamIds.filter((id) => !after.teamIds.includes(id));
  if (!addProfiles.length && !removeProfiles.length && !addTeams.length && !removeTeams.length) return null;
  await prisma.$transaction([
    prisma.setupRequirementTarget.deleteMany({ where: { requirementId, OR: [{ profileId: { in: removeProfiles } }, { teamId: { in: removeTeams } }] } }),
    ...addProfiles.map((profileId) => prisma.setupRequirementTarget.create({ data: { requirementId, profileId, createdById: admin.id } })),
    ...addTeams.map((teamId) => prisma.setupRequirementTarget.create({ data: { requirementId, teamId, createdById: admin.id } })),
  ]);
  return { addedEmployees: addProfiles, removedEmployees: removeProfiles, addedTeams: addTeams, removedTeams: removeTeams };
}

async function placeAt(admin, requirementId, position) {
  const active = await prisma.setupRequirement.findMany({ where: { organizationId: admin.organizationId, archivedAt: null }, orderBy: { displayOrder: 'asc' }, select: { id: true } });
  const order = active.map((r) => r.id).filter((id) => id !== requirementId);
  order.splice(Math.min(Math.max(position - 1, 0), order.length), 0, requirementId);
  await prisma.$transaction(order.map((id, i) => prisma.setupRequirement.update({ where: { id }, data: { displayOrder: i } })));
}

/** How many ACTIVE employees does this requirement apply to right now, and how many of those still lack it? */
async function impactOf(admin, requirementId) {
  const profiles = await prisma.profile.findMany({ where: { organizationId: admin.organizationId, status: 'ACTIVE', ...excludeOtherAdminsTestProfiles(admin) } });
  const setups = await loadSetupForProfiles(admin.organizationId, profiles);
  let applies = 0; let pending = 0;
  for (const p of profiles) {
    const row = setups.get(p.id).rows.find((r) => r.requirement.id === requirementId);
    if (!row) continue;
    applies += 1;
    if (row.counts && row.status !== 'COMPLETED') pending += 1;
  }
  return { applies, pending };
}

// ------------------------------------------------------------------ list
router.get('/setup-requirements', advanced, async (req, res) => {
  const admin = req.profile;
  await ensureDefaultRequirements(admin.organizationId);
  const showArchived = req.query.view === 'archived';
  const [requirements, targets] = await Promise.all([
    prisma.setupRequirement.findMany({ where: { organizationId: admin.organizationId, archivedAt: showArchived ? { not: null } : null }, orderBy: { displayOrder: 'asc' } }),
    prisma.setupRequirementTarget.findMany({ where: { requirement: { organizationId: admin.organizationId } } }),
  ]);
  const int = (v) => (/^\d{1,5}$/.test(String(v || '')) ? Number(v) : null);
  res.render('admin/setup-requirements', {
    title: 'Setup requirements',
    requirements,
    targets,
    showArchived,
    roleLabel,
    rolesList,
    VERIFICATION_LABEL,
    saved: req.query.saved === '1',
    applied: int(req.query.applied),
    pending: int(req.query.pending),
    error: typeof req.query.error === 'string' ? req.query.error.slice(0, 200) : null,
  });
});

// ------------------------------------------------------------------ create
router.get('/setup-requirements/new', advanced, (req, res) => renderForm(res, req.profile, { mode: 'new', values: emptyValues() }));

router.post('/setup-requirements', advanced, async (req, res) => {
  const admin = req.profile;
  const { values, errors } = await readForm(admin, req.body, null);
  if (errors.length) return renderForm(res, admin, { mode: 'new', values, errors, status: 400 });

  const last = await prisma.setupRequirement.aggregate({ where: { organizationId: admin.organizationId }, _max: { displayOrder: true } });
  const created = await prisma.setupRequirement.create({
    data: {
      organizationId: admin.organizationId,
      key: await uniqueKey(admin.organizationId, values.label),
      label: values.label,
      description: values.description || null,
      category: values.category,
      kind: 'MANUAL',
      audience: values.audience,
      rolesJson: values.roles.length ? JSON.stringify(values.roles) : null,
      required: values.required,
      verification: values.verification,
      companyControlled: values.companyControlled,
      allowPersonalAccount: values.allowPersonalAccount,
      credentialSystem: values.credentialSystem,
      ownerRole: values.ownerRole, dueDays: values.dueDays, dueDate: values.dueDate,
      displayOrder: (last._max.displayOrder ?? -1) + 1,
    },
  });
  await syncTargets(admin, created.id, { profileIds: [], teamIds: [] }, values);
  if (values.position) await placeAt(admin, created.id, values.position);
  await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'setup.requirement_created', targetTable: 'SetupRequirement', targetId: created.id, metadata: { key: created.key, label: values.label, category: values.category, audience: values.audience, roles: values.roles, required: values.required, verification: values.verification, employees: values.profileIds.length, teams: values.teamIds.length } });
  if (values.profileIds.length || values.teamIds.length) {
    await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'setup.requirement_assigned', targetTable: 'SetupRequirement', targetId: created.id, metadata: { key: created.key, addedEmployees: values.profileIds, addedTeams: values.teamIds } });
  }
  const impact = await impactOf(admin, created.id);
  res.redirect(`/admin/setup-requirements?saved=1&applied=${impact.applies}&pending=${values.required ? impact.pending : 0}`);
});

// ------------------------------------------------------------------ edit
router.get('/setup-requirements/:id/edit', advanced, async (req, res) => {
  const requirement = await loadOwn(req.profile, req.params.id);
  if (!requirement) return notFound(res);
  await renderForm(res, req.profile, { mode: 'edit', requirement, values: valuesFromRow(requirement) });
});

router.post('/setup-requirements/:id', advanced, async (req, res) => {
  const admin = req.profile;
  const existing = await loadOwn(admin, req.params.id);
  if (!existing) return notFound(res);
  const { values, errors } = await readForm(admin, req.body, existing);
  if (errors.length) return renderForm(res, admin, { mode: 'edit', requirement: existing, values, errors, status: 400 });

  const before = valuesFromRow(existing);
  await prisma.setupRequirement.update({
    where: { id: existing.id },
    data: {
      label: values.label,
      description: values.description || null,
      category: values.category,
      audience: values.audience,
      rolesJson: values.roles.length ? JSON.stringify(values.roles) : null,
      required: values.required,
      verification: values.verification,
      companyControlled: values.companyControlled,
      allowPersonalAccount: values.allowPersonalAccount,
      credentialSystem: values.credentialSystem,
      ownerRole: values.ownerRole, dueDays: values.dueDays, dueDate: values.dueDate,
    },
  });
  const targetChange = await syncTargets(admin, existing.id, before, values);
  if (values.position && !existing.archivedAt) await placeAt(admin, existing.id, values.position);

  const changes = auditDiff(before, values);
  const meta = { key: existing.key };
  if (Object.keys(changes).length) await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'setup.requirement_updated', targetTable: 'SetupRequirement', targetId: existing.id, metadata: { ...meta, changes } });
  if (changes.audience || changes.roles) await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'setup.requirement_roles_changed', targetTable: 'SetupRequirement', targetId: existing.id, metadata: { ...meta, from: { audience: before.audience, roles: before.roles }, to: { audience: values.audience, roles: values.roles } } });
  if (changes.verification) await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'setup.requirement_verification_changed', targetTable: 'SetupRequirement', targetId: existing.id, metadata: { ...meta, from: before.verification, to: values.verification } });
  if (targetChange) await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'setup.requirement_assigned', targetTable: 'SetupRequirement', targetId: existing.id, metadata: { ...meta, ...targetChange } });

  const impact = await impactOf(admin, existing.id);
  res.redirect(`/admin/setup-requirements?saved=1&applied=${impact.applies}&pending=${values.required ? impact.pending : 0}`);
});

// ------------------------------------------------------------------ order / archive / restore
router.post('/setup-requirements/:id/move', advanced, async (req, res) => {
  const admin = req.profile;
  const existing = await loadOwn(admin, req.params.id);
  if (!existing) return notFound(res);
  const up = req.body.direction === 'up';
  const active = await prisma.setupRequirement.findMany({ where: { organizationId: admin.organizationId, archivedAt: null }, orderBy: { displayOrder: 'asc' } });
  const index = active.findIndex((r) => r.id === existing.id);
  const other = index + (up ? -1 : 1);
  if (index >= 0 && active[other]) {
    // Renumber the whole list so ties or gaps left by earlier archiving can never make a move a no-op.
    const order = active.map((r) => r.id);
    [order[index], order[other]] = [order[other], order[index]];
    await prisma.$transaction(order.map((id, i) => prisma.setupRequirement.update({ where: { id }, data: { displayOrder: i } })));
    await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'setup.requirement_reordered', targetTable: 'SetupRequirement', targetId: existing.id, metadata: { key: existing.key, direction: up ? 'up' : 'down' } });
  }
  res.redirect('/admin/setup-requirements');
});

async function setArchived(req, res, archive) {
  const admin = req.profile;
  const existing = await loadOwn(admin, req.params.id);
  if (!existing) return notFound(res);
  // Archiving keeps every employee's setup history; the item just stops counting from now on.
  await prisma.setupRequirement.update({ where: { id: existing.id }, data: { archivedAt: archive ? new Date() : null } });
  await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: archive ? 'setup.requirement_archived' : 'setup.requirement_restored', targetTable: 'SetupRequirement', targetId: existing.id, metadata: { key: existing.key, label: existing.label } });
  res.redirect(archive ? '/admin/setup-requirements?saved=1' : '/admin/setup-requirements?view=archived&saved=1');
}
router.post('/setup-requirements/:id/archive', advanced, (req, res) => setArchived(req, res, true));
router.post('/setup-requirements/:id/restore', advanced, (req, res) => setArchived(req, res, false));

// ------------------------------------------------------------------ policies
// The simple on/off access & approval toggles (credentials.ownerCanView, leave.supervisorFinalApproval)
// moved to Settings → Security (routes/admin/settings.js) — everyday settings, not gated behind
// System Configuration Access. This page keeps only the deeper Training/Skill-scoring configuration.
async function renderPolicies(req, res, error = null, values = {}) {
  const admin = req.profile;
  const [minPassingScore, retentionDays, scoring, statusBands, retentionSchedule, declinePoints, dueSoonDays] = await Promise.all(['training.minPassingScore', 'calls.retentionDays', 'scoring.config', 'skills.statusBands', 'retention.schedule', 'retention.declinePoints', 'dev.dueSoonDays'].map((key) => getSetting(admin.organizationId, key)));
  res.render('admin/policies', {
    title: 'Training Configuration', saved: !error && req.query.saved === '1', values, minPassingScore, retentionDays, scoring, DEFAULT_SCORING, SOURCE_KEYS, TYPE_KEYS, statusBands, retentionSchedule, declinePoints, dueSoonDays,
    purged: /^\d{1,6}$/.test(String(req.query.purged || '')) ? Number(req.query.purged) : null,
    error: error || (typeof req.query.error === 'string' ? req.query.error.slice(0, 200) : null),
  });
}
router.get('/policies', advanced, (req, res) => renderPolicies(req, res));

// Training minimum passing score, customer-call retention and the Skill Graph evidence weights.
// Every value is range-checked by lib/orgSettings; anything out of range is refused, never clamped silently.
router.post('/policies/ai', advanced, async (req, res) => {
  const admin = req.profile;
  const org = admin.organizationId;
  const existingScoring = await getSetting(org, 'scoring.config');
  const has = (k) => req.body[k] !== undefined;
  const next = {
    'training.minPassingScore': Number(req.body.minPassingScore),
    'calls.retentionDays': Number(req.body.retentionDays === '' ? 0 : req.body.retentionDays),
    'scoring.config': {
      ...existingScoring,
      sourceWeights: Object.fromEntries(SOURCE_KEYS.map((k) => [k, Number(req.body['source_' + k])])),
      difficultyWeights: Object.fromEntries([1, 2, 3, 4, 5].map((k) => [k, Number(req.body['difficulty_' + k])])),
      halfLifeDays: Number(req.body.halfLifeDays),
      typeWeights: Object.fromEntries(TYPE_KEYS.map((k) => [k, has('type_' + k) ? Number(req.body['type_' + k]) : existingScoring.typeWeights[k]])),
    },
  };
  // Optional Phase 3 fields: only applied when the form sent them.
  if (has('band_min_0')) {
    const bands = [];
    for (let i = 0; has('band_min_' + i) && i < 8; i += 1) { if (String(req.body['band_label_' + i] || '').trim()) bands.push({ min: Number(req.body['band_min_' + i]), label: String(req.body['band_label_' + i]).trim().slice(0, 30), tone: String(req.body['band_tone_' + i] || '') }); }
    next['skills.statusBands'] = bands;
  }
  if (has('retentionSchedule')) next['retention.schedule'] = String(req.body.retentionSchedule).split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  if (has('declinePoints')) next['retention.declinePoints'] = Number(req.body.declinePoints);
  if (has('dueSoonDays')) next['dev.dueSoonDays'] = Number(req.body.dueSoonDays);
  if (!Object.entries(next).every(([key, value]) => isValidSetting(key, value))) {
    return renderPolicies(req, res.status(400), 'One of the values is outside its allowed range. Please check the limits shown next to each field. Nothing was saved; your entered values are retained.', req.body);
  }
  const changed = [];
  for (const [key, value] of Object.entries(next)) {
    const before = await getSetting(org, key);
    await setSetting(org, key, value, admin.id);
    if (JSON.stringify(before) !== JSON.stringify(await getSetting(org, key))) changed.push({ key, from: before, to: value });
  }
  for (const c of changed) await logAudit({ organizationId: org, actorId: admin.id, action: 'policy.changed', targetTable: 'OrgSetting', targetId: c.key, metadata: c });
  // A change to the scoring rules re-derives every cached skill score from the (unchanged) evidence; history keeps the old values.
  if (changed.some((c) => c.key === 'scoring.config')) {
    const recalculated = await recomputeOrganization(org);
    await logAudit({ organizationId: org, actorId: admin.id, action: 'skills.recalculated', targetTable: 'OrgSetting', targetId: 'scoring.config', metadata: { skills: recalculated, engineVersion: require('../../lib/skillEngine').ENGINE_VERSION } });
  }
  res.redirect('/admin/policies?saved=1');
});

router.post('/policies/purge-calls', advanced, async (req, res) => {
  const count = await purgeExpiredCalls(req.profile.organizationId, { actorId: req.profile.id });
  res.redirect('/admin/policies?purged=' + count);
});

module.exports = router;
