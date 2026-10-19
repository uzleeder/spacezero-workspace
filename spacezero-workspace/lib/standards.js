'use strict';

// Company Standards & Workflow — single source of truth for what an employee/supervisor/admin
// may READ and what counts as "acknowledged". Mirrors lib/employeeSetup.js's role in the app:
// every route re-derives visibility and acknowledgement state from here rather than trusting
// the client, so a direct URL/role-manipulation attempt can never see or act on content that
// does not apply to the requester.
const { prisma } = require('./prisma');
const { containsText } = require('./textSearch');

const CONTENT_TYPES = ['STANDARD', 'RESPONSIBILITY', 'WORKFLOW', 'DISCLOSURE'];
const CONTENT_TYPE_LABEL = { STANDARD: 'Standard', RESPONSIBILITY: 'Responsibility', WORKFLOW: 'Workflow', DISCLOSURE: 'Required Disclosure' };
// Reuses TrainingStatus (DRAFT/PUBLISHED/ARCHIVED) rather than a duplicate enum.
const STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'];
const STATUS_LABEL = { DRAFT: 'Draft', PUBLISHED: 'Published', ARCHIVED: 'Archived' };
const ROLES = ['TRAVEL_AGENT', 'FLIGHT_EXPERT', 'SUPERVISOR', 'ADMIN'];

function rolesList(item) {
  if (!item || !item.rolesJson) return [];
  try { return JSON.parse(item.rolesJson); } catch { return []; }
}

// null/empty rolesJson = everyone. An Admin always sees everything (management needs this),
// matching the same convention as lib/library.js's isVisible().
function isVisibleToRole(rolesJson, role) {
  if (role === 'ADMIN' || !rolesJson) return true;
  try { return JSON.parse(rolesJson).includes(role); } catch { return false; }
}

const isPublishedForReading = (item) => !item.archivedAt && item.currentVersionId && item.currentVersion && item.currentVersion.status === 'PUBLISHED';

async function visibleStandardsItems(organizationId, role, filters = {}) {
  const items = await prisma.standardsItem.findMany({
    where: {
      organizationId,
      archivedAt: null,
      currentVersionId: { not: null },
      contentType: filters.contentType && CONTENT_TYPES.includes(filters.contentType) ? filters.contentType : undefined,
      title: typeof filters.q === 'string' && filters.q.trim() ? containsText(filters.q) : undefined,
    },
    include: { currentVersion: true },
    orderBy: { title: 'asc' },
  });
  return items.filter((item) => isPublishedForReading(item) && isVisibleToRole(item.rolesJson, role));
}

// Simple search across title/category/short description — enough for the spec's own examples
// ("award", "follow up", "quote", "ticketing"). Authorization-filtered the same way as browsing.
async function searchStandards(organizationId, role, q) {
  const text = String(q || '').trim().slice(0, 100);
  if (!text) return [];
  const items = await prisma.standardsItem.findMany({
    where: {
      organizationId,
      archivedAt: null,
      currentVersionId: { not: null },
      OR: [
        { title: containsText(text) },
        { category: containsText(text) },
        { currentVersion: { shortDescription: containsText(text) } },
      ],
    },
    include: { currentVersion: true },
    orderBy: { title: 'asc' },
  });
  return items.filter((item) => isPublishedForReading(item) && isVisibleToRole(item.rolesJson, role));
}

async function quickReferenceItems(organizationId, role) {
  const items = await prisma.standardsItem.findMany({
    where: { organizationId, archivedAt: null, quickReference: true, currentVersionId: { not: null } },
    include: { currentVersion: true },
    orderBy: { title: 'asc' },
  });
  return items.filter((item) => isPublishedForReading(item) && isVisibleToRole(item.rolesJson, role));
}

// Loads one item for reading, including its ordered steps/responsibilities. Returns null if it
// does not exist, is archived, has no published version yet, or does not apply to this role —
// the route treats null as 404, never leaking whether the item exists.
async function getItemForReading(organizationId, id, role) {
  const item = await prisma.standardsItem.findFirst({
    where: { id, organizationId },
    include: { currentVersion: { include: { steps: { orderBy: { displayOrder: 'asc' } }, responsibilities: { orderBy: { displayOrder: 'asc' } } } } },
  });
  if (!item || !isPublishedForReading(item) || !isVisibleToRole(item.rolesJson, role)) return null;
  return item;
}

/**
 * For a set of {id, role} profiles, how many required (acknowledgementRequired, published,
 * role-applicable) items has each acknowledged against the CURRENT version? Used by the profile
 * card (one profile) and the supervisor/admin team-status view (many profiles) — one query
 * either way, never N+1.
 */
async function ackSummaryForProfiles(organizationId, profiles) {
  const requiredItems = await prisma.standardsItem.findMany({
    where: { organizationId, archivedAt: null, currentVersionId: { not: null }, currentVersion: { status: 'PUBLISHED', acknowledgementRequired: true } },
    select: { id: true, title: true, rolesJson: true, currentVersionId: true, currentVersion: { select: { requireReacknowledgement: true } } },
  });
  const itemIds = requiredItems.map((i) => i.id);
  const profileIds = profiles.map((p) => p.id);
  // Every acknowledgement of THIS item (any version) — not just the current one — because an
  // acknowledgement of an earlier version still satisfies the current one unless the admin set
  // requireReacknowledgement when publishing (spec section 22).
  const acks = itemIds.length && profileIds.length
    ? await prisma.standardsAcknowledgement.findMany({ where: { itemId: { in: itemIds }, profileId: { in: profileIds } }, select: { itemId: true, versionId: true, profileId: true } })
    : [];
  const acksByKey = new Map();
  for (const a of acks) {
    const key = a.profileId + '::' + a.itemId;
    if (!acksByKey.has(key)) acksByKey.set(key, []);
    acksByKey.get(key).push(a.versionId);
  }
  const isSatisfied = (item, profileId) => {
    const versionIds = acksByKey.get(profileId + '::' + item.id) || [];
    if (versionIds.includes(item.currentVersionId)) return true;
    return !item.currentVersion.requireReacknowledgement && versionIds.length > 0;
  };

  const result = new Map();
  for (const profile of profiles) {
    const applicable = requiredItems.filter((i) => isVisibleToRole(i.rolesJson, profile.role));
    const pending = applicable.filter((i) => !isSatisfied(i, profile.id));
    result.set(profile.id, { required: applicable.length, acknowledged: applicable.length - pending.length, pending: pending.length, pendingTitles: pending.map((i) => i.title) });
  }
  return result;
}

async function ackSummaryForProfile(organizationId, profile) {
  const map = await ackSummaryForProfiles(organizationId, [profile]);
  return map.get(profile.id) || { required: 0, acknowledged: 0, pending: 0, pendingTitles: [] };
}

// Admin visibility (spec section 24): for one item, every ACTIVE employee it applies to, whether
// they acknowledged the CURRENT version, and — if their acknowledgement is against an older,
// superseded version — whether it still counts (carried forward, when requireReacknowledgement
// was off for the new version) or is genuinely stale (re-acknowledgement owed).
async function acknowledgementRowsForItem(organizationId, item) {
  const [profiles, currentVersion] = await Promise.all([
    prisma.profile.findMany({ where: { organizationId, status: 'ACTIVE' }, select: { id: true, fullName: true, role: true }, orderBy: { fullName: 'asc' } }),
    prisma.standardsVersion.findUnique({ where: { id: item.currentVersionId }, select: { requireReacknowledgement: true } }),
  ]);
  const applicable = profiles.filter((p) => isVisibleToRole(item.rolesJson, p.role));
  const acks = await prisma.standardsAcknowledgement.findMany({
    where: { itemId: item.id, profileId: { in: applicable.map((p) => p.id) } },
    orderBy: { acceptedAt: 'desc' },
    include: { version: { select: { version: true } } },
  });
  const latestByProfile = new Map();
  for (const ack of acks) if (!latestByProfile.has(ack.profileId)) latestByProfile.set(ack.profileId, ack);

  return applicable.map((profile) => {
    const latest = latestByProfile.get(profile.id) || null;
    const current = latest ? latest.versionId === item.currentVersionId : false;
    const carried = Boolean(latest) && !current && currentVersion && !currentVersion.requireReacknowledgement;
    return {
      profile,
      acknowledged: Boolean(latest) && (current || carried),
      stale: Boolean(latest) && !current && !carried,
      acceptedAt: latest ? latest.acceptedAt : null,
      version: latest ? latest.version.version : null,
      current,
    };
  });
}

// A workflow step's optional detailJson may reference another item by plain id
// (disclosureRefId / relatedItemId — see lib/richContent.js's comment on why these are not
// FKs). Resolves those ids to titles/links here, server-side, once per page render, so the
// view never queries the database and a reference to an archived/deleted item just disappears
// rather than erroring.
// `role` is the viewer's — the title/existence of a role-restricted Disclosure/Standard must not
// leak through a step that merely references it, even though the link itself already 404s for an
// unauthorized viewer via getItemForReading (that check happens too late: the title and the fact
// that a referenced item exists were already rendered on the page by then).
async function enrichStepRefs(organizationId, steps, role) {
  const parsed = steps.map((s) => ({ ...s, detail: s.detailJson ? (() => { try { return JSON.parse(s.detailJson); } catch { return {}; } })() : {} }));
  const ids = new Set();
  for (const s of parsed) { if (s.detail.disclosureRefId) ids.add(s.detail.disclosureRefId); if (s.detail.relatedItemId) ids.add(s.detail.relatedItemId); }
  if (!ids.size) return parsed;
  const found = (await prisma.standardsItem.findMany({ where: { id: { in: [...ids] }, organizationId, archivedAt: null, currentVersionId: { not: null } }, select: { id: true, title: true, contentType: true, rolesJson: true } }))
    .filter((f) => isVisibleToRole(f.rolesJson, role));
  const byId = new Map(found.map((f) => [f.id, f]));
  for (const s of parsed) {
    if (s.detail.disclosureRefId) s.disclosureRef = byId.get(s.detail.disclosureRefId) || null;
    if (s.detail.relatedItemId) s.relatedItem = byId.get(s.detail.relatedItemId) || null;
  }
  return parsed;
}

module.exports = {
  CONTENT_TYPES, CONTENT_TYPE_LABEL, STATUSES, STATUS_LABEL, ROLES,
  rolesList, isVisibleToRole,
  visibleStandardsItems, searchStandards, quickReferenceItems, getItemForReading,
  ackSummaryForProfiles, ackSummaryForProfile, acknowledgementRowsForItem, enrichStepRefs,
};
