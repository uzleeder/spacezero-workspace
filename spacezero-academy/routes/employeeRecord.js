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

const notFound = (res) => res.status(404).render('not-found', { layout: false });
// Nobody verifies their own setup — not even an admin; another admin or the supervisor must.
const canManageSetup = (actor, ctx) => !ctx.isSelf && (actor.role === 'ADMIN' || actor.role === 'SUPERVISOR');

async function frame(req, ctx) {
  const access = await credentialAccess(req.profile, ctx.employee, { impersonating: Boolean(req.impersonation) });
  const readiness = (await readinessFor(req.profile.organizationId, [ctx.employee])).get(ctx.employee.id) || null;
  return { tabs: employeeTabs(req.profile, ctx, { credentials: access.view || access.manage }), employee: ctx.employee, isSelf: ctx.isSelf, roleLabel, readiness };
}

async function renderSetup(req, res, ctx, extra = {}) {
  const actor = req.profile;
  const setup = await loadSetupForProfile(actor.organizationId, ctx.employee);
  let address = '';
  if (ctx.employee.currentAddressEnc) {
    try { address = decryptText(ctx.employee.currentAddressEnc, `address:${ctx.employee.id}`); } catch { address = ''; }
  }
  res.render('employee/setup', {
    title: `${ctx.employee.fullName} — Setup`,
    ...(await frame(req, ctx)),
    setup,
    STATUSES,
    STATUS_LABEL,
    VERIFICATION_LABEL,
    manage: canManageSetup(actor, ctx) && ctx.employee.status !== 'INVITED', // setup starts when the employee is activated
    isAdmin: actor.role === 'ADMIN',
    canEditContact: ctx.isSelf || canManageSetup(actor, ctx),
    address,
    error: null,
    saved: false,
    ...extra,
  });
}

router.get('/my/setup', requireSession, (req, res) => res.redirect(`/employees/${req.profile.id}/setup`));

router.get('/employees/:id/setup', requireSession, async (req, res) => {
  const ctx = await loadEmployeeFor(req.profile, req.params.id);
  if (!ctx) return notFound(res);
  await renderSetup(req, res, ctx, { saved: req.query.saved === '1' });
});

router.post('/employees/:id/setup/:requirementId', requireSession, async (req, res) => {
  const actor = req.profile;
  const ctx = await loadEmployeeFor(actor, req.params.id);
  if (!ctx) return notFound(res);
  if (!canManageSetup(actor, ctx)) return res.status(403).render('forbidden');

  const requirement = await prisma.setupRequirement.findFirst({ where: { id: req.params.requirementId, organizationId: actor.organizationId, archivedAt: null } });
  if (!requirement || !(await requirementAppliesToProfile(requirement, ctx.employee))) return notFound(res);
  if (ctx.employee.status === 'INVITED') return renderSetup(req, res, ctx, { error: 'Setup starts once the employee has activated their account.' });

  const status = String(req.body.status || '');
  const fail = (message) => renderSetup(req, res, ctx, { error: message });
  if (!STATUSES.includes(status)) return fail('Choose a valid status.');
  if (status === 'NOT_REQUIRED' && actor.role !== 'ADMIN') return res.status(403).render('forbidden');
  if (requirement.kind !== 'MANUAL' && !['NOT_SET_UP', 'NOT_REQUIRED'].includes(status)) {
    return fail(`${requirement.label} is calculated automatically from the employee's real data and cannot be ticked by hand.`);
  }
  const confirmed = req.body.companyControlConfirmed === '1';
  if (status === 'COMPLETED' && requirement.companyControlled && !confirmed) {
    return fail(`Confirm that the company owns and can recover this ${requirement.label} account/number before marking it completed.`);
  }
  const note = String(req.body.note || '').trim().slice(0, 500) || null;
  // The company-controlled number/account (WhatsApp, Telegram). A phone number, not a secret — but it is still never written to audit metadata.
  let companyNumber;
  if (requirement.companyControlled && req.body.companyNumber !== undefined) {
    companyNumber = String(req.body.companyNumber).trim().slice(0, 40) || null;
    if (companyNumber && !/^[+@\w][\w+@ ().-]{2,39}$/.test(companyNumber)) return fail('Enter the company number or account handle without extra characters.');
  }

  const existing = await prisma.employeeSetupItem.findUnique({ where: { profileId_requirementId: { profileId: ctx.employee.id, requirementId: requirement.id } } });
  const data = {
    status,
    note,
    employeeConfirmedAt: status === 'NOT_SET_UP' ? null : existing?.employeeConfirmedAt ?? null,
    ...(companyNumber !== undefined ? { companyNumber } : {}),
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
  if (req.params.id !== actor.id || req.impersonation) return res.status(403).render('forbidden'); // nobody confirms on someone else's behalf
  const ctx = await loadEmployeeFor(actor, actor.id);
  if (!ctx) return notFound(res);
  const requirement = await prisma.setupRequirement.findFirst({ where: { id: req.params.requirementId, organizationId: actor.organizationId, archivedAt: null } });
  if (!requirement || !(await requirementAppliesToProfile(requirement, ctx.employee))) return notFound(res);
  const rule = effectiveRule(requirement);
  if (requirement.kind !== 'MANUAL' || rule === 'MANAGEMENT_ONLY') return res.status(403).render('forbidden');
  if (actor.status !== 'ACTIVE') return res.status(403).render('forbidden');

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
  if (!ctx.isSelf && !canManageSetup(actor, ctx)) return res.status(403).render('forbidden');

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

router.get('/employees/:id/training', requireSession, async (req, res) => {
  const ctx = await loadEmployeeFor(req.profile, req.params.id);
  if (!ctx) return notFound(res);
  const list = await getMyTrainingList(ctx.employee.id);
  res.render('employee/training', { title: `${ctx.employee.fullName} — Training`, ...(await frame(req, ctx)), list });
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
