'use strict';

// Company Standards & Workflow — admin management. Admin only, checked server-side on every
// request (spec section 18/29: Supervisor must never be able to create/edit/publish/archive a
// company rule, only read the same published content everyone else does).
const express = require('express');
const router = express.Router();

const { prisma } = require('../../lib/prisma');
const { requireAdmin } = require('../../lib/authMiddleware');
const { requireSystemConfigAccess } = require('../../lib/supervisorCapabilities');
// Authoring company Standards/Responsibilities/Workflows/Disclosures is "Admin Configuration"
// (Task 3) — it changes what every employee is shown org-wide, not day-to-day employee management.
const advanced = [requireAdmin, requireSystemConfigAccess];
const { logAudit } = require('../../lib/audit');
const { roleLabel } = require('../../lib/roles');
const { CONTENT_TYPES, CONTENT_TYPE_LABEL, STATUS_LABEL, ROLES, rolesList, acknowledgementRowsForItem, enrichStepRefs } = require('../../lib/standards');
const { BLOCK_TYPES, BLOCK_TYPE_LABEL, parseBlocksFromForm, parseBlocks, blocksToJson } = require('../../lib/richContent');

const notFound = (res) => res.status(404).render('not-found', { layout: false });
const text = (v, max) => String(v ?? '').trim().slice(0, max);
const asList = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]).map(String);

async function loadOwn(admin, id) {
  return prisma.standardsItem.findFirst({ where: { id, organizationId: admin.organizationId } });
}

async function latestVersionFor(itemId) {
  return prisma.standardsVersion.findFirst({ where: { itemId }, orderBy: { version: 'desc' }, include: { steps: { orderBy: { displayOrder: 'asc' } }, responsibilities: { orderBy: { displayOrder: 'asc' } } } });
}

// ------------------------------------------------------------------ reading the form
function readCore(body) {
  const errors = [];
  const title = text(body.title, 140);
  if (title.length < 2) errors.push('Enter a title.');
  const category = text(body.category, 60);
  const audience = body.rolesAudience === 'ROLES' ? 'ROLES' : 'ALL';
  const roles = asList(body.roles).filter((r) => ROLES.includes(r));
  if (audience === 'ROLES' && roles.length === 0) errors.push('Choose at least one role, or apply it to everyone.');
  const values = {
    title,
    category: category || null,
    rolesAudience: audience,
    roles: audience === 'ROLES' ? roles : [],
    shortDescription: text(body.shortDescription, 300) || null,
    important: body.important === '1',
    requiredReading: body.requiredReading === '1',
    acknowledgementRequired: body.acknowledgementRequired === '1',
    requireReacknowledgement: body.requireReacknowledgement === '1',
    quickReference: body.quickReference === '1',
  };
  return { errors, values };
}

function parseSteps(body) {
  const titles = asList(body.stepTitle);
  const instructions = asList(body.stepInstruction);
  const explanations = asList(body.stepExplanation);
  const checklists = asList(body.stepChecklist);
  const importantNotes = asList(body.stepImportantNote);
  const warnings = asList(body.stepWarning);
  const disclosureRefs = asList(body.stepDisclosureRefId);
  const relatedItems = asList(body.stepRelatedItemId);
  const steps = [];
  for (let i = 0; i < titles.length; i += 1) {
    const title = text(titles[i], 140);
    const instruction = text(instructions[i], 1000);
    if (!title && !instruction) continue;
    const checklist = (checklists[i] || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 20);
    const detail = {};
    if (explanations[i] && explanations[i].trim()) detail.explanation = text(explanations[i], 2000);
    if (checklist.length) detail.checklist = checklist;
    if (importantNotes[i] && importantNotes[i].trim()) detail.importantNote = text(importantNotes[i], 500);
    if (warnings[i] && warnings[i].trim()) detail.warning = text(warnings[i], 500);
    if (disclosureRefs[i]) detail.disclosureRefId = String(disclosureRefs[i]);
    if (relatedItems[i]) detail.relatedItemId = String(relatedItems[i]);
    steps.push({ title: title || 'Step', instruction, detailJson: Object.keys(detail).length ? JSON.stringify(detail) : null });
  }
  return steps;
}

function parseResponsibilities(body) {
  return asList(body.respText).map((t) => text(t, 500)).filter(Boolean).slice(0, 60).map((t) => ({ text: t }));
}

// ------------------------------------------------------------------ persisting a version
/**
 * Saves the submitted content onto the correct version row: updates the existing DRAFT in place
 * if there is one, otherwise creates the next version number as a new draft (spec section 19 —
 * editing a published item always produces a new version, never rewrites history). If action is
 * 'publish', immediately publishes it: archives the previously-current version and repoints the
 * item's currentVersionId, all inside one transaction.
 */
async function persistVersion(admin, item, contentType, coreValues, typeValues, action) {
  const latest = await latestVersionFor(item.id);
  const isDraftInPlace = latest && latest.status === 'DRAFT';
  const nextVersionNumber = latest ? latest.version + (isDraftInPlace ? 0 : 1) : 1;

  const data = {
    shortDescription: coreValues.shortDescription,
    important: coreValues.important,
    requiredReading: coreValues.requiredReading,
    acknowledgementRequired: coreValues.acknowledgementRequired,
    requireReacknowledgement: coreValues.requireReacknowledgement,
    contentJson: contentType === 'STANDARD' ? blocksToJson(typeValues.blocks) : null,
    disclosureWhenItApplies: contentType === 'DISCLOSURE' ? typeValues.whenItApplies : null,
    disclosureApprovedWording: contentType === 'DISCLOSURE' ? typeValues.approvedWording : null,
    disclosureAdditionalInstructions: contentType === 'DISCLOSURE' ? typeValues.additionalInstructions : null,
  };

  let versionId;
  if (isDraftInPlace) {
    versionId = latest.id;
    await prisma.$transaction([
      prisma.standardsVersion.update({ where: { id: versionId }, data }),
      prisma.standardsStep.deleteMany({ where: { versionId } }),
      prisma.standardsResponsibilityItem.deleteMany({ where: { versionId } }),
    ]);
  } else {
    const created = await prisma.standardsVersion.create({ data: { itemId: item.id, version: nextVersionNumber, status: 'DRAFT', createdById: admin.id, ...data } });
    versionId = created.id;
  }

  if (contentType === 'WORKFLOW' && typeValues.steps.length) {
    await prisma.standardsStep.createMany({ data: typeValues.steps.map((s, i) => ({ versionId, displayOrder: i, ...s })) });
  }
  if (contentType === 'RESPONSIBILITY' && typeValues.responsibilities.length) {
    await prisma.standardsResponsibilityItem.createMany({ data: typeValues.responsibilities.map((r, i) => ({ versionId, displayOrder: i, ...r })) });
  }

  await prisma.standardsItem.update({
    where: { id: item.id },
    data: { title: coreValues.title, category: coreValues.category, rolesJson: coreValues.roles.length ? JSON.stringify(coreValues.roles) : null, quickReference: coreValues.quickReference },
  });

  if (action === 'publish') {
    const previousCurrentId = item.currentVersionId;
    await prisma.$transaction([
      prisma.standardsVersion.update({ where: { id: versionId }, data: { status: 'PUBLISHED', publishedById: admin.id, publishedAt: new Date() } }),
      ...(previousCurrentId && previousCurrentId !== versionId ? [prisma.standardsVersion.update({ where: { id: previousCurrentId }, data: { status: 'ARCHIVED', archivedAt: new Date() } })] : []),
      prisma.standardsItem.update({ where: { id: item.id }, data: { currentVersionId: versionId } }),
    ]);
  }

  return versionId;
}

// ------------------------------------------------------------------ rendering the form
async function renderForm(res, admin, { mode, item = null, contentType, values, blocks = [], steps = [], responsibilities = [], disclosure = {}, errors = [], status = 200 }) {
  const [disclosures, relatable] = await Promise.all([
    prisma.standardsItem.findMany({ where: { organizationId: admin.organizationId, contentType: 'DISCLOSURE', archivedAt: null }, select: { id: true, title: true } }),
    prisma.standardsItem.findMany({ where: { organizationId: admin.organizationId, archivedAt: null, id: item ? { not: item.id } : undefined }, select: { id: true, title: true, contentType: true } }),
  ]);
  res.status(status).render('admin/standards/form', {
    title: mode === 'new' ? `New ${CONTENT_TYPE_LABEL[contentType]}` : `Edit — ${values.title || CONTENT_TYPE_LABEL[contentType]}`,
    mode, item, contentType, values, blocks, steps, responsibilities, disclosure, errors,
    ROLES, roleLabel, BLOCK_TYPES, BLOCK_TYPE_LABEL, CONTENT_TYPE_LABEL, disclosures, relatable,
  });
}

function emptyValues() {
  return { title: '', category: '', rolesAudience: 'ALL', roles: [], shortDescription: '', important: false, requiredReading: false, acknowledgementRequired: false, requireReacknowledgement: false, quickReference: false };
}

function valuesFromItemVersion(item, version) {
  return {
    title: item.title,
    category: item.category || '',
    rolesAudience: item.rolesJson ? 'ROLES' : 'ALL',
    roles: rolesList(item),
    shortDescription: (version && version.shortDescription) || '',
    important: Boolean(version && version.important),
    requiredReading: Boolean(version && version.requiredReading),
    acknowledgementRequired: Boolean(version && version.acknowledgementRequired),
    requireReacknowledgement: Boolean(version && version.requireReacknowledgement),
    quickReference: item.quickReference,
  };
}

// ------------------------------------------------------------------ list
router.get('/standards', advanced, async (req, res) => {
  const admin = req.profile;
  const filter = String(req.query.filter || 'all');
  const showArchived = filter === 'archived';
  const where = { organizationId: admin.organizationId, archivedAt: showArchived ? { not: null } : null };
  if (CONTENT_TYPES.includes(filter)) where.contentType = filter;
  const items = await prisma.standardsItem.findMany({
    where,
    include: { currentVersion: true, versions: { orderBy: { version: 'desc' }, take: 1 } },
    orderBy: { updatedAt: 'desc' },
  });
  const rows = items
    .map((item) => {
      const latest = item.versions[0];
      const effectiveStatus = item.archivedAt ? 'ARCHIVED' : (latest ? latest.status : 'DRAFT');
      return { item, latest, effectiveStatus };
    })
    .filter((r) => filter === 'draft' ? r.effectiveStatus === 'DRAFT' : filter === 'published' ? r.effectiveStatus === 'PUBLISHED' : true);

  res.render('admin/standards/list', {
    title: 'Company Standards & Workflow — Manage',
    rows, filter, CONTENT_TYPES, CONTENT_TYPE_LABEL, STATUS_LABEL, roleLabel, rolesList,
    saved: req.query.saved === '1',
  });
});

// ------------------------------------------------------------------ create chooser + form
router.get('/standards/new', advanced, (req, res) => {
  const type = String(req.query.type || '').toUpperCase();
  if (!CONTENT_TYPES.includes(type)) {
    return res.render('admin/standards/chooser', { title: 'Create — Company Standards & Workflow', CONTENT_TYPES, CONTENT_TYPE_LABEL });
  }
  renderForm(res, req.profile, { mode: 'new', contentType: type, values: emptyValues() });
});

router.post('/standards', advanced, async (req, res) => {
  const admin = req.profile;
  const type = String(req.body.contentType || '').toUpperCase();
  if (!CONTENT_TYPES.includes(type)) return res.status(400).render('not-found', { layout: false });
  const { errors, values } = readCore(req.body);
  const typeValues = { blocks: parseBlocksFromForm(req.body), steps: parseSteps(req.body), responsibilities: parseResponsibilities(req.body), whenItApplies: text(req.body.disclosureWhenItApplies, 500) || null, approvedWording: text(req.body.disclosureApprovedWording, 4000) || null, additionalInstructions: text(req.body.disclosureAdditionalInstructions, 2000) || null };
  if (errors.length) return renderForm(res, admin, { mode: 'new', contentType: type, values, blocks: typeValues.blocks, steps: typeValues.steps, responsibilities: typeValues.responsibilities, disclosure: typeValues, errors, status: 400 });

  const item = await prisma.standardsItem.create({ data: { organizationId: admin.organizationId, contentType: type, title: values.title, category: values.category, rolesJson: values.roles.length ? JSON.stringify(values.roles) : null, quickReference: values.quickReference, createdById: admin.id } });
  const action = req.body.action === 'publish' ? 'publish' : 'draft';
  const versionId = await persistVersion(admin, item, type, values, typeValues, action);

  await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'standards.item_created', targetTable: 'StandardsItem', targetId: item.id, metadata: { title: values.title, contentType: type, audience: values.rolesAudience, roles: values.roles } });
  if (action === 'publish') await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'standards.published', targetTable: 'StandardsItem', targetId: item.id, metadata: { title: values.title, versionId, version: 1 } });
  res.redirect('/admin/standards?saved=1');
});

// ------------------------------------------------------------------ edit
router.get('/standards/:id/edit', advanced, async (req, res) => {
  const admin = req.profile;
  const item = await loadOwn(admin, req.params.id);
  if (!item) return notFound(res);
  const latest = await latestVersionFor(item.id);
  const values = valuesFromItemVersion(item, latest);
  const blocks = item.contentType === 'STANDARD' ? parseBlocks(latest && latest.contentJson) : [];
  const steps = item.contentType === 'WORKFLOW' && latest ? latest.steps : [];
  const responsibilities = item.contentType === 'RESPONSIBILITY' && latest ? latest.responsibilities : [];
  const disclosure = { whenItApplies: (latest && latest.disclosureWhenItApplies) || '', approvedWording: (latest && latest.disclosureApprovedWording) || '', additionalInstructions: (latest && latest.disclosureAdditionalInstructions) || '' };
  renderForm(res, admin, { mode: 'edit', item, contentType: item.contentType, values, blocks, steps, responsibilities, disclosure });
});

router.post('/standards/:id', advanced, async (req, res) => {
  const admin = req.profile;
  const item = await loadOwn(admin, req.params.id);
  if (!item) return notFound(res);
  const { errors, values } = readCore(req.body);
  const typeValues = { blocks: parseBlocksFromForm(req.body), steps: parseSteps(req.body), responsibilities: parseResponsibilities(req.body), whenItApplies: text(req.body.disclosureWhenItApplies, 500) || null, approvedWording: text(req.body.disclosureApprovedWording, 4000) || null, additionalInstructions: text(req.body.disclosureAdditionalInstructions, 2000) || null };
  if (errors.length) return renderForm(res, admin, { mode: 'edit', item, contentType: item.contentType, values, blocks: typeValues.blocks, steps: typeValues.steps, responsibilities: typeValues.responsibilities, disclosure: typeValues, errors, status: 400 });

  const before = { audience: item.rolesJson ? 'ROLES' : 'ALL', roles: rolesList(item) };
  const action = req.body.action === 'publish' ? 'publish' : 'draft';
  const wasPublished = Boolean(item.currentVersionId);
  const versionId = await persistVersion(admin, item, item.contentType, values, typeValues, action);

  await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'standards.version_created', targetTable: 'StandardsItem', targetId: item.id, metadata: { title: values.title, versionId } });
  if (before.audience !== values.rolesAudience || JSON.stringify(before.roles) !== JSON.stringify(values.roles)) {
    await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'standards.audience_changed', targetTable: 'StandardsItem', targetId: item.id, metadata: { from: before, to: { audience: values.rolesAudience, roles: values.roles } } });
  }
  if (action === 'publish') {
    await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'standards.published', targetTable: 'StandardsItem', targetId: item.id, metadata: { title: values.title, versionId, newVersionOfPublished: wasPublished } });
  }
  res.redirect('/admin/standards?saved=1');
});

// ------------------------------------------------------------------ publish existing draft as-is / archive / restore / quick reference
router.post('/standards/:id/publish', advanced, async (req, res) => {
  const admin = req.profile;
  const item = await loadOwn(admin, req.params.id);
  if (!item) return notFound(res);
  const latest = await latestVersionFor(item.id);
  if (!latest || latest.status !== 'DRAFT') return res.redirect('/admin/standards?saved=1');
  const previousCurrentId = item.currentVersionId;
  await prisma.$transaction([
    prisma.standardsVersion.update({ where: { id: latest.id }, data: { status: 'PUBLISHED', publishedById: admin.id, publishedAt: new Date() } }),
    ...(previousCurrentId && previousCurrentId !== latest.id ? [prisma.standardsVersion.update({ where: { id: previousCurrentId }, data: { status: 'ARCHIVED', archivedAt: new Date() } })] : []),
    prisma.standardsItem.update({ where: { id: item.id }, data: { currentVersionId: latest.id } }),
  ]);
  await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'standards.published', targetTable: 'StandardsItem', targetId: item.id, metadata: { title: item.title, versionId: latest.id, version: latest.version } });
  res.redirect('/admin/standards?saved=1');
});

async function setArchived(req, res, archive) {
  const admin = req.profile;
  const item = await loadOwn(admin, req.params.id);
  if (!item) return notFound(res);
  await prisma.standardsItem.update({ where: { id: item.id }, data: { archivedAt: archive ? new Date() : null } });
  await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: archive ? 'standards.archived' : 'standards.restored', targetTable: 'StandardsItem', targetId: item.id, metadata: { title: item.title } });
  res.redirect('/admin/standards?saved=1');
}
router.post('/standards/:id/archive', advanced, (req, res) => setArchived(req, res, true));
router.post('/standards/:id/restore', advanced, (req, res) => setArchived(req, res, false));

router.post('/standards/:id/quick-reference', advanced, async (req, res) => {
  const admin = req.profile;
  const item = await loadOwn(admin, req.params.id);
  if (!item) return notFound(res);
  await prisma.standardsItem.update({ where: { id: item.id }, data: { quickReference: !item.quickReference } });
  res.redirect('/admin/standards?saved=1');
});

// ------------------------------------------------------------------ preview (admin only, any status)
router.get('/standards/:id/preview', advanced, async (req, res) => {
  const admin = req.profile;
  const item = await loadOwn(admin, req.params.id);
  if (!item) return notFound(res);
  const latest = await latestVersionFor(item.id);
  if (!latest) return notFound(res);
  const steps = await enrichStepRefs(admin.organizationId, latest.steps || []);
  res.render('standards/show', {
    title: item.title,
    item, version: latest, blocks: parseBlocks(latest.contentJson), steps,
    isPreview: true, ackState: null, CONTENT_TYPE_LABEL,
  });
});

// ------------------------------------------------------------------ acknowledgement visibility (spec section 24)
router.get('/standards/:id/acknowledgements', advanced, async (req, res) => {
  const admin = req.profile;
  const item = await loadOwn(admin, req.params.id);
  if (!item) return notFound(res);
  if (!item.currentVersionId) return res.redirect('/admin/standards?saved=1');
  let rows = await acknowledgementRowsForItem(admin.organizationId, item);
  const roleFilter = String(req.query.role || '');
  const statusFilter = String(req.query.status || '');
  if (ROLES.includes(roleFilter)) rows = rows.filter((r) => r.profile.role === roleFilter);
  if (statusFilter === 'acknowledged') rows = rows.filter((r) => r.acknowledged);
  if (statusFilter === 'pending') rows = rows.filter((r) => !r.acknowledged);
  res.render('admin/standards/acknowledgements', { title: `Acknowledgements — ${item.title}`, item, rows, ROLES, roleLabel, roleFilter, statusFilter });
});

module.exports = router;
