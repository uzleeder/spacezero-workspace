'use strict';

// Employee record tabs shared by Admin (any employee), Supervisor (their assigned team) and the
// employee themself: Setup, Training, Skills, Activity. Vacation lives in routes/leave.js and the
// vault in routes/credentials.js. Every handler authorizes through loadEmployeeFor().
const router = require('express').Router();
const { prisma } = require('../lib/prisma');
const { requireSession, requireRole } = require('../lib/authMiddleware');
const { loadEmployeeFor, credentialAccess } = require('../lib/employeeAccess');
const { loadSetupForProfile, STATUSES, STATUS_LABEL, VERIFICATION_LABEL, requirementAppliesToProfile, effectiveRule, isValidLocalPhone } = require('../lib/employeeSetup');
const { encryptText, decryptText } = require('../lib/credentialCrypto');
const { logAudit } = require('../lib/audit');
const { getMyTrainingList } = require('../lib/training');
const { employeeTabs } = require('../lib/employeeTabs');
const { roleLabel } = require('../lib/roles');
const { readinessFor } = require('../lib/readiness');
const { employeeTimeline } = require('../lib/timeline');
const { createNotification } = require('../lib/notifications');
const { safeRedirect } = require('../lib/requestSecurity');
const { hasCapability, canViewSetupTab } = require('../lib/supervisorCapabilities');
const { parseDateOfBirth } = require('../lib/birthdays');
const { passportAccess,passportStatus, maskPassportNumber, validatePassportNumber, parseExpirationDate, decryptPassportNumber, encryptPassportNumber, STATUS_LABEL: PASSPORT_STATUS_LABEL, STATUS_TONE: PASSPORT_STATUS_TONE } = require('../lib/passport');
const { verifyPassword } = require('../lib/password');
const { isRateLimited, recordAttempt } = require('../lib/rateLimit');

const notFound = (res) => res.status(404).render('not-found', { layout: false });
// An Admin may manage (bulk-check, verify) their OWN setup — the org's highest authority does not
// need a second admin to sign off on their own PC/GDS/etc. A Supervisor still cannot self-verify,
// and beyond that needs the Admin-granted 'setup.manage' capability for anyone else's setup —
// unconditional role === 'SUPERVISOR' access was removed; see lib/supervisorCapabilities.js.
async function canManageSetup(actor, ctx) {
  if (actor.role === 'ADMIN') return true;
  if (actor.role !== 'SUPERVISOR' || ctx.isSelf) return false;
  return hasCapability(actor, 'setup.manage');
}

// A Save that cannot be allowed ends on the Setup page itself, with the reason in plain words, instead of
// a bare "Access denied" dead end (the status stays 403, so nothing is saved and nothing changes).
function denySetup(req, res, ctx, message) { res.status(403); return renderSetup(req, res, ctx, { error: message }); }
const NO_MANAGE_MESSAGE = 'You do not have permission to change this person\u2019s Setup. Ask an administrator to enable \u201cManage Team Setup\u201d for you under Settings \u2192 Supervisor Permissions.';
const NOT_ACTIVE_MESSAGE = 'Setup can only be saved once the account is active.';
const impersonatingMessage = (req, ctx) => `You are viewing ${ctx.employee.fullName}\u2019s account as ${req.impersonation.adminName}. Only ${ctx.employee.fullName} can confirm their own items here \u2014 use \u201cReturn to admin and manage this Setup\u201d to change it yourself.`;
async function frame(req, ctx) {
  const [access, readinessMap, canViewSetup] = await Promise.all([
    credentialAccess(req.profile, ctx.employee, { impersonating: Boolean(req.impersonation) }),
    readinessFor(req.profile.organizationId, [ctx.employee]),
    canViewSetupTab(req.profile, ctx),
  ]);
  const readiness = readinessMap.get(ctx.employee.id) || null;
  return { tabs: employeeTabs(req.profile, ctx, { credentials: access.view || access.manage, canViewSetup }), employee: ctx.employee, isSelf: ctx.isSelf, roleLabel, readiness };
}

async function renderSetup(req, res, ctx, extra = {}) {
  const actor = req.profile;
  const setup = await loadSetupForProfile(actor.organizationId, ctx.employee);
  let address = '';
  if (ctx.employee.currentAddressEnc) {
    try { address = decryptText(ctx.employee.currentAddressEnc, `address:${ctx.employee.id}`); } catch { address = ''; }
  }
  const canManage = await canManageSetup(actor, ctx);
  const passAccess = await passportAccess(actor, ctx.employee);
  const passStatus = passportStatus(ctx.employee.passportExpiresAt);
  // Self sees their own full number (it is their own data, no reveal step needed); a management
  // viewer with view access sees only the masked form here — the full value needs the separate,
  // password-gated /passport/reveal action, exactly like the Credential Vault.
  let passportFull = null;
  let passportMasked = null;
  if (ctx.employee.passportNumberEnc) {
    try {
      const plain = decryptPassportNumber(ctx.employee.id, ctx.employee.passportNumberEnc);
      if (ctx.isSelf && passAccess.view) passportFull = plain;
      else if (passAccess.view) passportMasked = maskPassportNumber(plain);
    } catch { /* undecryptable: treated as not shown */ }
  }
  res.render('employee/setup', {
    title: `${ctx.employee.fullName} — Setup`,
    ...(await frame(req, ctx)),
    setup,
    STATUSES,
    STATUS_LABEL,
    VERIFICATION_LABEL,
    manage: canManage && ctx.employee.status !== 'INVITED', // setup starts when the employee is activated
    isAdmin: actor.role === 'ADMIN',
    canEditContact: ctx.isSelf || canManage,
    address,
    passAccess,
    passStatus,
    PASSPORT_STATUS_LABEL,
    PASSPORT_STATUS_TONE,
    passportFull,
    passportMasked,
    passportExpiresAt: ctx.employee.passportExpiresAt ? ctx.employee.passportExpiresAt.toISOString().slice(0, 10) : '',
    dateOfBirth: ctx.employee.dateOfBirth ? ctx.employee.dateOfBirth.toISOString().slice(0, 10) : '',
    error: null,
    saved: false,
    changed: null,
    conflicts: 0,
    ...extra,
  });
}

router.get('/my/setup', requireSession, (req, res) => res.redirect(`/employees/${req.profile.id}/setup`));

router.get('/employees/:id/setup', requireSession, async (req, res) => {
  const actor = req.profile;
  const ctx = await loadEmployeeFor(actor, req.params.id);
  if (!ctx) return notFound(res);
  if (!(await canViewSetupTab(actor, ctx))) return res.status(403).render('forbidden');
  const digits = (v) => (/^\d{1,4}$/.test(String(v || '')) ? Number(v) : null);
  await renderSetup(req, res, ctx, { saved: req.query.saved === '1', changed: digits(req.query.changed), conflicts: digits(req.query.conflicts) || 0 });
});

// Compact-checklist bulk save: one submit changes many plain checkbox items at once (checked =
// Completed, unchecked = Not Set Up). Only MANUAL, non-company-controlled requirements are eligible
// here — anything with a special status (In Progress / Issue / Not Required), a derived value, or a
// company-controlled item stays on the individual "..." editor, which keeps every existing status,
// note, verification and Telegram-style account-type field working exactly as before. Every row that
// actually changes gets its own audit entry (never one vague "Setup updated"), and a row whose stored
// updatedAt no longer matches what the browser last saw is skipped rather than silently overwritten.
// Registered BEFORE the :requirementId route below — otherwise Express would match "bulk" as an id.
router.post('/employees/:id/setup/bulk', requireSession, async (req, res) => {
  const actor = req.profile;
  const ctx = await loadEmployeeFor(actor, req.params.id);
  if (!ctx) return notFound(res);
  if (!(await canManageSetup(actor, ctx))) return actor.role === 'SUPERVISOR' ? denySetup(req, res, ctx, NO_MANAGE_MESSAGE) : res.status(403).render('forbidden');
  if (ctx.employee.status === 'INVITED') return renderSetup(req, res, ctx, { error: 'Setup starts once the employee has activated their account.' });

  const allRequirements = await prisma.setupRequirement.findMany({ where: { organizationId: actor.organizationId, archivedAt: null } });
  const applicable = [];
  for (const requirement of allRequirements) {
    if (requirement.kind !== 'MANUAL' || requirement.companyControlled) continue;
    if (await requirementAppliesToProfile(requirement, ctx.employee)) applicable.push(requirement);
  }
  if (!applicable.length) return res.redirect(`/employees/${ctx.employee.id}/setup?saved=1&changed=0`);

  const rawChecked = req.body.checked;
  const checkedIds = new Set((Array.isArray(rawChecked) ? rawChecked : rawChecked ? [rawChecked] : []).map(String));
  const existingItems = await prisma.employeeSetupItem.findMany({ where: { profileId: ctx.employee.id, requirementId: { in: applicable.map((r) => r.id) } } });
  const existingByReq = new Map(existingItems.map((i) => [i.requirementId, i]));

  const changes = [];
  const mayVerify = await hasCapability(actor, 'setup.verify');
  let conflicts = 0;
  for (const requirement of applicable) {
    const existing = existingByReq.get(requirement.id) || null;
    const currentStatus = existing?.status || 'NOT_SET_UP';
    // A row already in an exception state (In Progress / Issue / Not Required) is left alone here —
    // it is not part of the plain checked/unchecked toggle and must be changed from the "..." editor.
    const pendingAdminVerification = actor.role === 'ADMIN' && currentStatus === 'IN_PROGRESS' && Boolean(existing?.employeeConfirmedAt);
    if (pendingAdminVerification && !checkedIds.has(requirement.id)) continue; // Saving another checkbox must not withdraw a pending confirmation.
    if (currentStatus !== 'NOT_SET_UP' && currentStatus !== 'COMPLETED' && !pendingAdminVerification) continue;
    const targetStatus = checkedIds.has(requirement.id) ? 'COMPLETED' : 'NOT_SET_UP';
    if (targetStatus === currentStatus) continue;
    if (targetStatus === 'COMPLETED' && effectiveRule(requirement) !== 'EMPLOYEE_CONFIRMATION' && !mayVerify) {
      return renderSetup(req, res, ctx, { error: 'You do not have permission to verify this item. Ask an Admin to grant "Verify Team Setup".' });
    }

    const loadedTs = req.body['ts_' + requirement.id];
    if (existing && loadedTs && new Date(loadedTs).getTime() !== existing.updatedAt.getTime()) { conflicts += 1; continue; }

    changes.push({ requirement, from: currentStatus, to: targetStatus, existing });
  }

  if (changes.length) {
    await prisma.$transaction(changes.map(({ requirement, to, existing }) => prisma.employeeSetupItem.upsert({
      where: { profileId_requirementId: { profileId: ctx.employee.id, requirementId: requirement.id } },
      update: {
        status: to,
        verifiedById: to === 'COMPLETED' ? actor.id : null,
        verifiedAt: to === 'COMPLETED' ? new Date() : null,
        employeeConfirmedAt: to === 'NOT_SET_UP' ? null : (existing?.employeeConfirmedAt ?? null),
        updatedById: actor.id,
      },
      create: { profileId: ctx.employee.id, requirementId: requirement.id, status: to, verifiedById: to === 'COMPLETED' ? actor.id : null, verifiedAt: to === 'COMPLETED' ? new Date() : null, updatedById: actor.id },
    })));
    for (const c of changes) {
      await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'setup.status_changed', targetTable: 'Profile', targetId: ctx.employee.id, metadata: { requirement: c.requirement.key, from: c.from, to: c.to, via: 'bulk' } });
      if (c.to === 'COMPLETED') await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'setup.item_verified', targetTable: 'Profile', targetId: ctx.employee.id, metadata: { requirement: c.requirement.key, via: 'bulk' } });
    }
  }

  const qs = new URLSearchParams({ saved: '1', changed: String(changes.length) });
  if (conflicts) qs.set('conflicts', String(conflicts));
  res.redirect(`/employees/${ctx.employee.id}/setup?${qs.toString()}`);
});

// The employee's own compact checklist: I Have / I Don't Have for many items, one Save. Same
// verification-rule preservation as the existing /confirm route below (I Have completes the item
// outright only when the requirement's rule is EMPLOYEE_CONFIRMATION; otherwise it only moves the
// item to "awaiting verification" — management still has to verify it). I Don't Have requires a
// note and reuses the existing ISSUE status. Registered BEFORE the :requirementId route below —
// otherwise Express would match "self-bulk" as an id.
router.post('/employees/:id/setup/self-bulk', requireSession, async (req, res) => {
  const actor = req.profile;
  if (req.params.id !== actor.id) return res.status(403).render('forbidden');
  const ctx = await loadEmployeeFor(actor, actor.id);
  if (!ctx) return notFound(res);
  if (req.impersonation) return denySetup(req, res, ctx, impersonatingMessage(req, ctx));
  if (actor.status !== 'ACTIVE') return denySetup(req, res, ctx, NOT_ACTIVE_MESSAGE);

  const allRequirements = await prisma.setupRequirement.findMany({ where: { organizationId: actor.organizationId, archivedAt: null } });
  const applicable = [];
  for (const requirement of allRequirements) {
    if (requirement.kind !== 'MANUAL' || requirement.companyControlled) continue;
    if (effectiveRule(requirement) === 'MANAGEMENT_ONLY') continue;
    if (await requirementAppliesToProfile(requirement, ctx.employee)) applicable.push(requirement);
  }
  if (!applicable.length) return res.redirect(`/employees/${actor.id}/setup?saved=1&changed=0`);

  const existingItems = await prisma.employeeSetupItem.findMany({ where: { profileId: actor.id, requirementId: { in: applicable.map((r) => r.id) } } });
  const existingByReq = new Map(existingItems.map((i) => [i.requirementId, i]));
  // Two ways to say the same thing: the checklist's checkboxes (mode=checkbox — ticked means "I have
  // this", un-ticking withdraws the employee's own confirmation) or the original explicit radio
  // choice_<id>. "I haven't" is never decided by an un-ticked box — it needs a note, so it has its own
  // request route (POST .../:requirementId/report-issue) and an unticked box never touches an issue.
  const checkboxMode = req.body.mode === 'checkbox';
  const rawChecked = req.body.checked;
  const checkedIds = new Set((Array.isArray(rawChecked) ? rawChecked : rawChecked ? [rawChecked] : []).map(String));
  const choiceFor = (id) => {
    if (checkboxMode) {
      const existing = existingByReq.get(id) || null;
      const haveNow = existing && (existing.status === 'COMPLETED' || existing.status === 'IN_PROGRESS');
      if (checkedIds.has(id)) return haveNow ? null : 'have';
      return haveNow && existing.employeeConfirmedAt ? 'withdraw' : null;
    }
    const v = req.body['choice_' + id];
    return v === 'have' || v === 'dontHave' ? v : null;
  };

  // Every "I Don't Have" needs a note before ANYTHING in this batch is saved — never a partial,
  // confusing save where some items applied and one silently didn't for lack of a note.
  const missingNotes = [];
  for (const requirement of applicable) {
    if (choiceFor(requirement.id) !== 'dontHave') continue;
    const note = String(req.body['note_' + requirement.id] || '').trim();
    if (!note) missingNotes.push(requirement.label);
  }
  if (missingNotes.length) return renderSetup(req, res, ctx, { error: `Add a short note for: ${missingNotes.join(', ')} — a note is required for "I Don't Have".` });

  const changes = [];
  let conflicts = 0;
  for (const requirement of applicable) {
    const existing = existingByReq.get(requirement.id) || null;
    const currentStatus = existing?.status || 'NOT_SET_UP';
    if (currentStatus === 'NOT_REQUIRED') continue; // management marked this not required for them
    if (currentStatus === 'COMPLETED' && existing?.verifiedById) continue; // management-verified; not theirs to change here
    const choice = choiceFor(requirement.id);
    if (!choice) continue; // untouched — leave exactly as-is
    const wantsDontHave = choice === 'dontHave';

    const loadedTs = req.body['ts_' + requirement.id];
    if (existing && loadedTs && new Date(loadedTs).getTime() !== existing.updatedAt.getTime()) { conflicts += 1; continue; }

    let data; let action;
    if (choice === 'withdraw') {
      data = { status: 'NOT_SET_UP', note: null, employeeConfirmedAt: null, verifiedById: null, verifiedAt: null };
      action = 'setup.employee_withdrew';
    } else if (wantsDontHave) {
      const note = String(req.body['note_' + requirement.id] || '').trim().slice(0, 500);
      if (currentStatus === 'ISSUE' && existing.note === note) continue; // no actual change
      data = { status: 'ISSUE', note, employeeConfirmedAt: null, verifiedById: null, verifiedAt: null };
      action = 'setup.employee_flagged_issue';
    } else {
      const rule = effectiveRule(requirement);
      const nextStatus = rule === 'EMPLOYEE_CONFIRMATION' ? 'COMPLETED' : 'IN_PROGRESS';
      if (currentStatus === nextStatus) continue; // already there — no-op
      data = { status: nextStatus, note: null, employeeConfirmedAt: new Date(), verifiedById: null, verifiedAt: null };
      action = 'setup.employee_confirmed';
    }
    changes.push({ requirement, from: currentStatus, to: data.status, data, action });
  }

  if (changes.length) {
    await prisma.$transaction(changes.map(({ requirement, data }) => prisma.employeeSetupItem.upsert({
      where: { profileId_requirementId: { profileId: actor.id, requirementId: requirement.id } },
      update: { ...data, updatedById: actor.id },
      create: { profileId: actor.id, requirementId: requirement.id, ...data, updatedById: actor.id },
    })));
    for (const c of changes) {
      await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: c.action, targetTable: 'Profile', targetId: actor.id, metadata: { requirement: c.requirement.key, from: c.from, to: c.to, via: 'self-bulk' } });
    }
  }

  const qs = new URLSearchParams({ saved: '1', changed: String(changes.length) });
  if (conflicts) qs.set('conflicts', String(conflicts));
  res.redirect(`/employees/${actor.id}/setup?${qs.toString()}`);
});

// "I haven't": the employee tells management they do not have this item yet. A note is required —
// it is the request. The item becomes an Issue (the same status and the same "Setup access issues"
// signal management already watches) and every Admin, plus the employee's own Supervisor, is
// notified. Self only; never for management-only, calculated or company-controlled items.
router.post('/employees/:id/setup/:requirementId/report-issue', requireSession, async (req, res) => {
  const actor = req.profile;
  if (req.params.id !== actor.id) return res.status(403).render('forbidden');
  const ctx = await loadEmployeeFor(actor, actor.id);
  if (!ctx) return notFound(res);
  if (req.impersonation) return denySetup(req, res, ctx, impersonatingMessage(req, ctx));
  if (actor.status !== 'ACTIVE') return denySetup(req, res, ctx, NOT_ACTIVE_MESSAGE);
  const requirement = await prisma.setupRequirement.findFirst({ where: { id: req.params.requirementId, organizationId: actor.organizationId, archivedAt: null } });
  if (!requirement || !(await requirementAppliesToProfile(requirement, ctx.employee))) return notFound(res);
  if (requirement.kind !== 'MANUAL' || requirement.companyControlled || effectiveRule(requirement) === 'MANAGEMENT_ONLY') return res.status(403).render('forbidden');

  const note = String(req.body.note || '').trim().slice(0, 500);
  if (!note) return renderSetup(req, res, ctx, { error: `Write a short note for “${requirement.label}” — it is sent to your administrator so they know what you are missing.` });
  const existing = await prisma.employeeSetupItem.findUnique({ where: { profileId_requirementId: { profileId: actor.id, requirementId: requirement.id } } });
  if (existing?.status === 'NOT_REQUIRED' || (existing?.status === 'COMPLETED' && existing.verifiedById)) return res.redirect(`/employees/${actor.id}/setup`);

  const data = { status: 'ISSUE', note, employeeConfirmedAt: null, verifiedById: null, verifiedAt: null };
  await prisma.employeeSetupItem.upsert({
    where: { profileId_requirementId: { profileId: actor.id, requirementId: requirement.id } },
    update: { ...data, updatedById: actor.id },
    create: { profileId: actor.id, requirementId: requirement.id, ...data, updatedById: actor.id },
  });
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'setup.employee_flagged_issue', targetTable: 'Profile', targetId: actor.id, metadata: { requirement: requirement.key, from: existing?.status || 'NOT_SET_UP', to: 'ISSUE', via: 'report-issue' } });

  const admins = await prisma.profile.findMany({ where: { organizationId: actor.organizationId, role: 'ADMIN', status: 'ACTIVE', testOwnerAdminId: null, NOT: { id: actor.id } }, select: { id: true } });
  const supervisorIds = (ctx.employee.supervisedBy || []).map((s) => s.supervisorId);
  const { setupLinkFor } = require('../lib/supervisorCapabilities');
  const title = 'Setup request';
  const body = `${actor.fullName} does not have “${requirement.label}” yet: ${note.slice(0, 160)}`;
  for (const recipientId of [...new Set([...admins.map((a) => a.id), ...supervisorIds])]) {
    await createNotification({ profileId: recipientId, type: 'setup.employee_request', title, body, link: await setupLinkFor(recipientId, actor.id) }).catch(() => undefined);
  }
  res.redirect(`/employees/${actor.id}/setup?saved=1&changed=1`);
});

// The employee enters their own WhatsApp / Telegram number (or @handle) and saves: that completes the
// item automatically (lib/employeeSetup.js#selfSupplied) — no separate management verification.
// Self only; an item management already verified is not theirs to change here.
router.post('/employees/:id/setup/:requirementId/account', requireSession, async (req, res) => {
  const actor = req.profile;
  if (req.params.id !== actor.id) return res.status(403).render('forbidden');
  const ctx = await loadEmployeeFor(actor, actor.id);
  if (!ctx) return notFound(res);
  if (req.impersonation) return denySetup(req, res, ctx, impersonatingMessage(req, ctx));
  if (actor.status !== 'ACTIVE') return denySetup(req, res, ctx, NOT_ACTIVE_MESSAGE);
  const requirement = await prisma.setupRequirement.findFirst({ where: { id: req.params.requirementId, organizationId: actor.organizationId, archivedAt: null } });
  if (!requirement || !(await requirementAppliesToProfile(requirement, ctx.employee))) return notFound(res);
  if (requirement.kind !== 'MANUAL' || !requirement.companyControlled) return res.status(403).render('forbidden');

  const value = String(req.body.companyNumber || '').trim().slice(0, 40);
  if (!value) return renderSetup(req, res, ctx, { error: `Enter your ${requirement.label} number first.` });
  if (!/^[+@\w][\w+@ ().-]{2,39}$/.test(value)) return renderSetup(req, res, ctx, { error: `Enter your ${requirement.label} number or @username without extra characters.` });
  const existing = await prisma.employeeSetupItem.findUnique({ where: { profileId_requirementId: { profileId: actor.id, requirementId: requirement.id } } });
  if (existing?.status === 'NOT_REQUIRED') return res.redirect(`/employees/${actor.id}/setup`);
  if (existing?.status === 'COMPLETED' && existing.verifiedById) return renderSetup(req, res, ctx, { error: `${requirement.label} was already verified by management. Ask an administrator if it needs to change.` });

  const data = {
    status: 'COMPLETED', note: null, companyNumber: value, employeeConfirmedAt: new Date(), verifiedById: null, verifiedAt: null,
    ...(requirement.allowPersonalAccount ? { accountType: 'PERSONAL_WORK' } : {}),
  };
  await prisma.employeeSetupItem.upsert({
    where: { profileId_requirementId: { profileId: actor.id, requirementId: requirement.id } },
    update: { ...data, updatedById: actor.id },
    create: { profileId: actor.id, requirementId: requirement.id, ...data, updatedById: actor.id },
  });
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'setup.employee_saved_account', targetTable: 'Profile', targetId: actor.id, metadata: { requirement: requirement.key, from: existing?.status || 'NOT_SET_UP', to: 'COMPLETED', via: 'account' } });
  res.redirect(`/employees/${actor.id}/setup?saved=1&changed=1`);
});

router.post('/employees/:id/setup/:requirementId', requireSession, async (req, res) => {
  const actor = req.profile;
  const ctx = await loadEmployeeFor(actor, req.params.id);
  if (!ctx) return notFound(res);
  if (!(await canManageSetup(actor, ctx))) return actor.role === 'SUPERVISOR' ? denySetup(req, res, ctx, NO_MANAGE_MESSAGE) : res.status(403).render('forbidden');

  const requirement = await prisma.setupRequirement.findFirst({ where: { id: req.params.requirementId, organizationId: actor.organizationId, archivedAt: null } });
  if (!requirement || !(await requirementAppliesToProfile(requirement, ctx.employee))) return notFound(res);
  if (ctx.employee.status === 'INVITED') return renderSetup(req, res, ctx, { error: 'Setup starts once the employee has activated their account.' });

  const status = String(req.body.status || '');
  const fail = (message) => renderSetup(req, res, ctx, { error: message });
  if (!STATUSES.includes(status)) return fail('Choose a valid status.');
  if (status === 'NOT_REQUIRED' && actor.role !== 'ADMIN') return denySetup(req, res, ctx, 'Only an administrator can mark an item as Not required.');
  if (requirement.kind !== 'MANUAL' && !['NOT_SET_UP', 'NOT_REQUIRED'].includes(status)) {
    return fail(`${requirement.label} is calculated automatically from the employee's real data and cannot be ticked by hand.`);
  }
  const confirmed = req.body.companyControlConfirmed === '1';
  const accountType = requirement.allowPersonalAccount && ['COMPANY', 'PERSONAL_WORK'].includes(req.body.accountType) ? req.body.accountType : null;
  if (status === 'COMPLETED' && requirement.companyControlled && !confirmed && accountType !== 'PERSONAL_WORK') {
    return fail(`Confirm that the company owns and can recover this ${requirement.label} account/number before marking it completed${requirement.allowPersonalAccount ? ', or choose a personal number used for work' : ''}.`);
  }
  const note = String(req.body.note || '').trim().slice(0, 500) || null;
  // The company-controlled number/account (WhatsApp, Telegram). A phone number, not a secret — but it is still never written to audit metadata.
  let companyNumber;
  if (requirement.companyControlled && req.body.companyNumber !== undefined) {
    companyNumber = String(req.body.companyNumber).trim().slice(0, 40) || null;
    if (companyNumber && !/^[+@\w][\w+@ ().-]{2,39}$/.test(companyNumber)) return fail('Enter the company number or account handle without extra characters.');
  }

  const existing = await prisma.employeeSetupItem.findUnique({ where: { profileId_requirementId: { profileId: ctx.employee.id, requirementId: requirement.id } } });

  // Verification depends on the requirement, not its previous state: resetting to NOT_SET_UP
  // or completing a fresh item must never bypass the separate verification permission.
  if (status === 'COMPLETED' && effectiveRule(requirement) !== 'EMPLOYEE_CONFIRMATION' && actor.role === 'SUPERVISOR' && !(await hasCapability(actor, 'setup.verify'))) {
    return fail('You do not have permission to verify this item. Ask an Admin to grant "Verify Team Setup".');
  }

  const data = {
    status,
    note,
    employeeConfirmedAt: status === 'NOT_SET_UP' ? null : existing?.employeeConfirmedAt ?? null,
    ...(companyNumber !== undefined ? { companyNumber } : {}),
    ...(requirement.allowPersonalAccount ? { accountType } : {}),
    companyControlConfirmed: requirement.companyControlled && ['COMPLETED', 'IN_PROGRESS', 'ISSUE'].includes(status) ? confirmed : false,
    verifiedById: status === 'COMPLETED' ? actor.id : null,
    verifiedAt: status === 'COMPLETED' ? new Date() : null,
    updatedById: actor.id,
  };
  await prisma.employeeSetupItem.upsert({
    where: { profileId_requirementId: { profileId: ctx.employee.id, requirementId: requirement.id } },
    update: data,
    create: { profileId: ctx.employee.id, requirementId: requirement.id, ...data },
  });

  const meta = { requirement: requirement.key, from: existing?.status || 'NOT_SET_UP', to: status };
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'setup.status_changed', targetTable: 'Profile', targetId: ctx.employee.id, metadata: meta });
  if (status === 'COMPLETED') await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'setup.item_verified', targetTable: 'Profile', targetId: ctx.employee.id, metadata: { requirement: requirement.key } });
  res.redirect(`/employees/${ctx.employee.id}/setup?saved=1`);
});

// The employee's own "I have this" tick. What it achieves depends on the requirement's verification
// rule, which an Admin configures: employee confirmation completes the item, management
// verification only moves it to "awaiting verification", management-only items cannot be ticked here.
router.post('/employees/:id/setup/:requirementId/confirm', requireSession, async (req, res) => {
  const actor = req.profile;
  if (req.params.id !== actor.id) return res.status(403).render('forbidden'); // nobody confirms on someone else's behalf
  const ctx = await loadEmployeeFor(actor, actor.id);
  if (!ctx) return notFound(res);
  if (req.impersonation) return denySetup(req, res, ctx, impersonatingMessage(req, ctx));
  const requirement = await prisma.setupRequirement.findFirst({ where: { id: req.params.requirementId, organizationId: actor.organizationId, archivedAt: null } });
  if (!requirement || !(await requirementAppliesToProfile(requirement, ctx.employee))) return notFound(res);
  const rule = effectiveRule(requirement);
  if (requirement.kind !== 'MANUAL' || rule === 'MANAGEMENT_ONLY') return res.status(403).render('forbidden');
  if (actor.status !== 'ACTIVE') return denySetup(req, res, ctx, NOT_ACTIVE_MESSAGE);

  const existing = await prisma.employeeSetupItem.findUnique({ where: { profileId_requirementId: { profileId: actor.id, requirementId: requirement.id } } });
  if (existing?.status === 'NOT_REQUIRED') return res.status(409).render('error', { layout: false, message: 'Management marked this item as not required for you.' });
  const withdraw = req.body.undo === '1';
  const verifiedByManagement = Boolean(existing?.verifiedById);
  if (existing?.status === 'COMPLETED' && (verifiedByManagement || !withdraw)) return res.redirect(`/employees/${actor.id}/setup`); // already done; management-verified items are not the employee's to undo

  let data;
  if (withdraw) data = { status: 'NOT_SET_UP', employeeConfirmedAt: null, verifiedById: null, verifiedAt: null };
  else if (rule === 'EMPLOYEE_CONFIRMATION') data = { status: 'COMPLETED', employeeConfirmedAt: new Date(), verifiedById: null, verifiedAt: null };
  else data = { status: 'IN_PROGRESS', employeeConfirmedAt: new Date(), verifiedById: null, verifiedAt: null };
  await prisma.employeeSetupItem.upsert({
    where: { profileId_requirementId: { profileId: actor.id, requirementId: requirement.id } },
    update: { ...data, updatedById: actor.id },
    create: { profileId: actor.id, requirementId: requirement.id, ...data, updatedById: actor.id },
  });
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: withdraw ? 'setup.employee_withdrew' : 'setup.employee_confirmed', targetTable: 'Profile', targetId: actor.id, metadata: { requirement: requirement.key, rule, result: data.status } });
  res.redirect(`/employees/${actor.id}/setup?saved=1`);
});
// Local phone + current living address. The address is encrypted at rest, is only ever rendered
// on this authorized profile view, and its value is never written to audit metadata.
router.post('/employees/:id/contact', requireSession, async (req, res) => {
  const actor = req.profile;
  const ctx = await loadEmployeeFor(actor, req.params.id);
  if (!ctx) return notFound(res);
  if (!ctx.isSelf && !(await canManageSetup(actor, ctx))) return actor.role === 'SUPERVISOR' ? denySetup(req, res, ctx, NO_MANAGE_MESSAGE) : res.status(403).render('forbidden');

  const phone = String(req.body.localPhone || '').trim();
  const address = String(req.body.currentAddress || '').trim();
  if (phone && !isValidLocalPhone(phone)) return renderSetup(req, res, ctx, { error: 'Enter a valid phone number (7-15 digits, optional +, spaces, dashes or brackets).' });
  if (address.length > 500) return renderSetup(req, res, ctx, { error: 'Address is too long (500 characters maximum).' });

  const phoneChanged = (ctx.employee.localPhone || '') !== phone;
  const data = { localPhone: phone || null };
  let addressChanged = false;
  if (req.body.currentAddress !== undefined) {
    const before = (() => { try { return ctx.employee.currentAddressEnc ? decryptText(ctx.employee.currentAddressEnc, `address:${ctx.employee.id}`) : ''; } catch { return ''; } })();
    addressChanged = before !== address;
    data.currentAddressEnc = address ? encryptText(address, `address:${ctx.employee.id}`) : null;
  }
  await prisma.profile.update({ where: { id: ctx.employee.id }, data });
  if (phoneChanged || addressChanged) {
    await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'employee.contact_updated', targetTable: 'Profile', targetId: ctx.employee.id, metadata: { phoneChanged, addressChanged } });
  }
  res.redirect(`/employees/${ctx.employee.id}/setup?saved=1`);
});

// Passport Details (Number + Expiration Date only, never a scan). Self may update their own;
// otherwise only an Admin may (a Supervisor's access here is capped at view, never manage — see
// lib/passport.js#passportAccess). The number is encrypted the same way as Credential Vault
// secrets and is never written to audit metadata; only the fact that it changed is.
const REVEAL_LIMIT = { maxAttempts: 10, windowMs: 15 * 60 * 1000 };
router.post('/employees/:id/passport', requireSession, async (req, res) => {
  const actor = req.profile;
  const ctx = await loadEmployeeFor(actor, req.params.id);
  if (!ctx) return notFound(res);
  const access = await passportAccess(actor, ctx.employee);
  if (!access.manage) return denySetup(req, res, ctx, 'Only the employee or an administrator can change passport details.');

  const { date: expiresAt, error: dateError } = parseExpirationDate(req.body.passportExpiresAt);
  if (dateError) return renderSetup(req, res, ctx, { error: dateError });

  const isNew = !ctx.employee.passportNumberEnc;
  const numberRaw = String(req.body.passportNumber || '').trim();
  const data = { passportExpiresAt: expiresAt };

  // Date of birth (used for the automatic birthday greeting). A form that does not send the field
  // keeps the stored value; one that sends it must send a real, past date.
  if (req.body.dateOfBirth !== undefined) {
    const { date: dateOfBirth, error: dobError } = parseDateOfBirth(req.body.dateOfBirth);
    if (dobError) return renderSetup(req, res, ctx, { error: dobError });
    data.dateOfBirth = dateOfBirth;
  }

  // First / middle / last name exactly as printed in the passport. A field the form did not send
  // keeps its stored value; first and last are required once merged, middle is optional.
  const NAME_RE = /^[\p{L}][\p{L} .'’-]{0,59}$/u;
  const nameFields = [['passportFirstName', 'First name', true], ['passportMiddleName', 'Middle name', false], ['passportLastName', 'Last name', true]];
  for (const [field, label, required] of nameFields) {
    const sent = req.body[field];
    const value = sent === undefined ? String(ctx.employee[field] || '') : String(sent).trim().replace(/\s+/g, ' ');
    if (!value && required) return renderSetup(req, res, ctx, { error: `${label} is required — enter it exactly as it appears in the passport.` });
    if (value && !NAME_RE.test(value)) return renderSetup(req, res, ctx, { error: `${label} may contain only letters, spaces, hyphens and apostrophes (60 characters maximum).` });
    data[field] = value || null;
  }
  if (numberRaw) {
    // Same "leave blank to keep the current value" convention as the Credential Vault's update
    // form — the current number is never sent back to this page to be re-typed unchanged.
    const numberError = validatePassportNumber(numberRaw);
    if (numberError) return renderSetup(req, res, ctx, { error: numberError });
    data.passportNumberEnc = encryptPassportNumber(ctx.employee.id, numberRaw.toUpperCase());
  } else if (isNew) {
    return renderSetup(req, res, ctx, { error: 'Passport number is required.' });
  }
  await prisma.profile.update({ where: { id: ctx.employee.id }, data });
  const action = isNew ? 'passport.details_added' : ctx.isSelf ? 'passport.details_updated' : 'passport.admin_updated_employee_passport';
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action, targetTable: 'Profile', targetId: ctx.employee.id, metadata: { employeeName: ctx.employee.fullName } });
  res.redirect(`/employees/${ctx.employee.id}/setup?saved=1`);
});

// Full-value reveal: needs the viewer's own password again, is rate limited, and is audited
// without the secret — identical shape to POST /credentials/:credId/reveal.
router.post('/employees/:id/passport/reveal', requireSession, async (req, res) => {
  const actor = req.profile;
  res.set('Cache-Control', 'no-store');
  const ctx = await loadEmployeeFor(actor, req.params.id);
  if (!ctx || !ctx.employee.passportNumberEnc) return res.status(404).json({ error: 'Not found' });
  const access = await passportAccess(actor, ctx.employee);
  if (!access.view) {
    await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'passport.access_denied', targetTable: 'Profile', targetId: ctx.employee.id });
    return res.status(404).json({ error: 'Not found' });
  }
  const bucket = `passportreveal:${actor.id}`;
  if (await isRateLimited(bucket, REVEAL_LIMIT)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  if (!req.body.password || !(await verifyPassword(String(req.body.password), actor.passwordHash))) {
    await recordAttempt(bucket, false);
    await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'passport.reveal_failed', targetTable: 'Profile', targetId: ctx.employee.id });
    return res.status(401).json({ error: 'Your password is incorrect.' });
  }
  await recordAttempt(bucket, true);
  let number;
  try { number = decryptPassportNumber(ctx.employee.id, ctx.employee.passportNumberEnc); } catch { return res.status(500).json({ error: 'This could not be decrypted.' }); }
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'passport.viewed', targetTable: 'Profile', targetId: ctx.employee.id, metadata: { employeeName: ctx.employee.fullName } });
  res.json({ passportNumber: number });
});

router.get('/employees/:id/training', requireSession, async (req, res) => {
  const ctx = await loadEmployeeFor(req.profile, req.params.id);
  if (!ctx) return notFound(res);
  const list = await getMyTrainingList(ctx.employee.id);
  res.render('employee/training', { title: `${ctx.employee.fullName} — Training`, ...(await frame(req, ctx)), list, categoryLabel: require('../lib/trainingCategories').categoryLabel, canRemove: req.profile.role === 'ADMIN' && !req.impersonation, removed: req.query.removed === '1' });
});

// Admin only: take ONE assigned training away from this employee (the assignment stays for everyone else;
// if they were its only recipient the now-empty assignment goes too). Their attempts on it are removed;
// certificates and skill scores already earned stay.
router.get('/employees/:id/training/:recipientId/delete', requireSession, async (req, res) => {
  const actor = req.profile;
  if (actor.role !== 'ADMIN' || req.impersonation) return res.status(403).render('forbidden');
  const ctx = await loadEmployeeFor(actor, req.params.id);
  if (!ctx) return notFound(res);
  const recipient = await prisma.trainingAssignmentRecipient.findFirst({ where: { id: req.params.recipientId, profileId: ctx.employee.id, assignment: { organizationId: actor.organizationId } }, include: { assignment: { include: { course: true, assignedBy: { select: { fullName: true } } } } } });
  if (!recipient) return notFound(res);
  res.render('delete-training-assignment', { title: 'Delete assigned training', assignment: recipient.assignment, employee: ctx.employee, action: `/employees/${ctx.employee.id}/training/${recipient.id}/delete`, returnTo: `/employees/${ctx.employee.id}/training` });
});

router.post('/employees/:id/training/:recipientId/delete', requireSession, async (req, res) => {
  const actor = req.profile;
  if (actor.role !== 'ADMIN' || req.impersonation) return res.status(403).render('forbidden');
  const ctx = await loadEmployeeFor(actor, req.params.id);
  if (!ctx) return notFound(res);
  const recipient = await prisma.trainingAssignmentRecipient.findFirst({
    where: { id: req.params.recipientId, profileId: ctx.employee.id, assignment: { organizationId: actor.organizationId } },
    include: { assignment: { include: { course: { select: { title: true } } } } },
  });
  if (!recipient) return notFound(res);
  const attempts = await prisma.trainingAttempt.count({ where: { recipientId: recipient.id } });
  await prisma.trainingAssignmentRecipient.delete({ where: { id: recipient.id } });
  const left = await prisma.trainingAssignmentRecipient.count({ where: { assignmentId: recipient.assignmentId } });
  if (!left) await prisma.trainingAssignment.delete({ where: { id: recipient.assignmentId } }).catch(() => undefined);
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'training.assignment_removed_from_employee', targetTable: 'Profile', targetId: ctx.employee.id, metadata: { course: recipient.assignment.course.title, assignmentId: recipient.assignmentId, attempts, assignmentDeleted: !left } });
  res.redirect(`/employees/${ctx.employee.id}/training?removed=1`);
});

// Shared "remind" action for the Employees & Teams status-group view (both the single row's
// button and a group header's "Remind all N"). Every id is re-authorized here — a client-
// supplied list is never trusted — and self is never included, even if it slips through.
router.post('/employees/remind', requireRole('ADMIN', 'SUPERVISOR'), async (req, res) => {
  const actor = req.profile;
  const raw = req.body.ids;
  const ids = [...new Set((Array.isArray(raw) ? raw : raw ? [raw] : []).filter((v) => typeof v === 'string'))].slice(0, 200);
  let count = 0;
  for (const id of ids) {
    if (id === actor.id) continue;
    const ctx = await loadEmployeeFor(actor, id);
    if (!ctx || ctx.isSelf) continue;
    await createNotification({
      profileId: ctx.employee.id,
      type: 'employee.reminder',
      title: 'A reminder from your team',
      body: `${actor.fullName} sent you a reminder to finish your setup and training.`,
      link: '/my/setup',
    });
    count++;
  }
  if (count) await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'employee.reminder_sent', metadata: { count } });
  if ((req.get('accept') || '').includes('application/json')) return res.json({ ok: true, count });
  res.redirect(safeRedirect(req.body.back));
});

router.get('/employees/:id/activity', requireSession, async (req, res) => {
  const actor = req.profile;
  const ctx = await loadEmployeeFor(actor, req.params.id);
  if (!ctx) return notFound(res);
  // A readable timeline built from real records. Raw audit entries (including credential events) are security data and stay on the Admin's audit screen.
  const events = await employeeTimeline(ctx.employee);
  res.render('employee/activity', { title: `${ctx.employee.fullName} — Activity`, ...(await frame(req, ctx)), events });
});

module.exports = router;
