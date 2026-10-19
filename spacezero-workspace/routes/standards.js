'use strict';

// Company Standards & Workflow — the employee-facing handbook: read published, role-applicable
// content and acknowledge what requires it. Every read is filtered server-side by role and
// PUBLISHED status (lib/standards.js); nobody can see draft content or content meant for a role
// they don't have by guessing a URL.
const express = require('express');
const router = express.Router();

const { prisma } = require('../lib/prisma');
const { requireSession, requireRole } = require('../lib/authMiddleware');
const { logAudit } = require('../lib/audit');
const { roleLabel } = require('../lib/roles');
const { supervisedProfileIds } = require('../lib/authz');
const {
  CONTENT_TYPES, CONTENT_TYPE_LABEL, visibleStandardsItems, searchStandards, quickReferenceItems,
  getItemForReading, ackSummaryForProfiles, enrichStepRefs, rolesList,
} = require('../lib/standards');
const { parseBlocks } = require('../lib/richContent');
const { getSetting } = require('../lib/orgSettings');
const { TYPE_INFO, STATE_LABEL, STATE_ACTION, readingStates, progressOf, buildReaderModel } = require('../lib/standardsReader');

const notFound = (res) => res.status(404).render('not-found', { layout: false });

router.get('/standards', requireSession, async (req, res) => {
  const me = req.profile;
  const [standards, responsibilities, workflows, disclosures, quickRef, pageDescription] = await Promise.all([
    visibleStandardsItems(me.organizationId, me.role, { contentType: 'STANDARD' }),
    visibleStandardsItems(me.organizationId, me.role, { contentType: 'RESPONSIBILITY' }),
    visibleStandardsItems(me.organizationId, me.role, { contentType: 'WORKFLOW' }),
    visibleStandardsItems(me.organizationId, me.role, { contentType: 'DISCLOSURE' }),
    quickReferenceItems(me.organizationId, me.role),
    getSetting(me.organizationId, 'standards.pageDescription'),
  ]);
  // Reading progress comes from the existing acknowledgement records only (nothing new is stored).
  const everything = [...standards, ...responsibilities, ...workflows, ...disclosures];
  const states = await readingStates(me.id, everything);
  const todoIn = (list) => list.filter((i) => ['TODO', 'UPDATED'].includes(states.get(i.id).state)).length;
  res.render('standards/landing', {
    title: 'Company Standards & Workflow',
    pageDescription,
    counts: { STANDARD: standards.length, RESPONSIBILITY: responsibilities.length, WORKFLOW: workflows.length, DISCLOSURE: disclosures.length },
    todo: { STANDARD: todoIn(standards), RESPONSIBILITY: todoIn(responsibilities), WORKFLOW: todoIn(workflows), DISCLOSURE: todoIn(disclosures) },
    progress: progressOf(everything, states),
    TYPE_INFO,
    quickRef,
  });
});

router.get('/standards/search', requireSession, async (req, res) => {
  const me = req.profile;
  const q = String(req.query.q || '');
  const results = q ? await searchStandards(me.organizationId, me.role, q) : [];
  res.render('standards/search', { title: 'Search — Company Standards & Workflow', q, results, CONTENT_TYPE_LABEL, states: await readingStates(me.id, results), STATE_LABEL });
});

router.get('/standards/team-status', requireRole('ADMIN', 'SUPERVISOR'), async (req, res) => {
  const me = req.profile;
  const profileIds = me.role === 'SUPERVISOR' ? await supervisedProfileIds(me.id) : null;
  const profiles = await prisma.profile.findMany({
    where: { organizationId: me.organizationId, status: 'ACTIVE', ...(profileIds ? { id: { in: profileIds } } : { role: { in: ['TRAVEL_AGENT', 'FLIGHT_EXPERT', 'SUPERVISOR'] } }) },
    select: { id: true, fullName: true, role: true },
    orderBy: { fullName: 'asc' },
  });
  const summaries = await ackSummaryForProfiles(me.organizationId, profiles);
  const rows = profiles.map((p) => ({ profile: p, summary: summaries.get(p.id) }));
  res.render('standards/team-status', { title: 'Team acknowledgement status', rows, roleLabel });
});

router.get('/standards/browse/:type', requireSession, async (req, res) => {
  const me = req.profile;
  const type = String(req.params.type).toUpperCase();
  if (!CONTENT_TYPES.includes(type)) return notFound(res);
  const items = await visibleStandardsItems(me.organizationId, me.role, { contentType: type });
  res.render('standards/browse', {
    title: `${TYPE_INFO[type].label} — Company Standards & Workflow`,
    type, items, CONTENT_TYPE_LABEL, TYPE_INFO, STATE_LABEL, STATE_ACTION, rolesList, roleLabel,
    states: await readingStates(me.id, items),
  });
});

router.get('/standards/:id', requireSession, async (req, res) => {
  const me = req.profile;
  const item = await getItemForReading(me.organizationId, req.params.id, me.role);
  if (!item) return notFound(res);
  const version = item.currentVersion;
  // An acknowledgement of an EARLIER version of this item still satisfies the current one unless
  // the admin explicitly turned on requireReacknowledgement when publishing (spec section 22).
  let ackState = null;
  if (version.acknowledgementRequired) {
    const acks = await prisma.standardsAcknowledgement.findMany({ where: { itemId: item.id, profileId: me.id }, orderBy: { acceptedAt: 'desc' }, include: { version: { select: { version: true } } } });
    const exact = acks.find((a) => a.versionId === version.id);
    const carried = !version.requireReacknowledgement ? acks[0] : null;
    const satisfying = exact || carried;
    // stale = it was acknowledged before, but this version needs another look (Admin turned on re-acknowledgement).
    ackState = { needed: !satisfying, stale: !satisfying && acks.length > 0, acceptedAt: satisfying ? satisfying.acceptedAt : null, version: satisfying ? satisfying.version.version : null };
  }
  const steps = await enrichStepRefs(me.organizationId, version.steps || [], me.role);
  const blocks = parseBlocks(version.contentJson);
  res.render('standards/show', {
    title: item.title,
    item, version, blocks, steps,
    reader: buildReaderModel({ item, version, blocks, steps }),
    isPreview: false, ackState,
    acknowledged: req.query.acknowledged === '1',
    CONTENT_TYPE_LABEL,
  });
});

// Writes exactly one acknowledgement row for the CURRENT session's own profile — never a
// body-supplied profile id, closing the "cannot acknowledge for another employee" requirement.
router.post('/standards/:id/acknowledge', requireSession, async (req, res) => {
  const me = req.profile;
  const item = await getItemForReading(me.organizationId, req.params.id, me.role);
  if (!item) return notFound(res);
  const version = item.currentVersion;
  if (!version.acknowledgementRequired) return res.redirect(`/standards/${item.id}`);
  await prisma.standardsAcknowledgement.upsert({
    where: { versionId_profileId: { versionId: version.id, profileId: me.id } },
    update: {},
    create: { itemId: item.id, versionId: version.id, profileId: me.id },
  });
  await logAudit({ organizationId: me.organizationId, actorId: me.id, action: 'standards.acknowledged', targetTable: 'StandardsItem', targetId: item.id, metadata: { title: item.title, version: version.version } });
  res.redirect(`/standards/${item.id}?acknowledged=1`);
});

module.exports = router;
