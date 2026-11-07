'use strict';

// Office Management - assets. Only the office manager (Profile.officeManager) reaches this, never while someone views
// as them, and always inside their own organization (routes/office.js checks every request).
//
// Each asset is one physical thing with a stable asset tag (SZ-0001), its own name, an optional model/product, a
// category, a physical location, a condition and a lifecycle. Custody is separate: an asset is either with a person
// (holderId) or placed at a desk (deskId) - never both - or with neither (unassigned). The meanings below are the one
// definition used for the Overview numbers AND for the Assets filters they link to, so a count always matches its list:
//   assigned            not retired, and with a person or at a desk
//   unassigned          not retired, with no person and no desk
//   available           unassigned AND in service (ACTIVE) AND condition Good AND physically checked (verifiedAt) AND
//                       nothing left to review. An unassigned asset is NOT automatically available.
//   attention           not retired, condition Needs repair OR Broken
//   repair              lifecycle In repair (an open repair puts it there; resolving or cancelling takes it out)
//   review              not retired, and marked Needs review, or missing a model or a location
//   retired             lifecycle Retired (kept with its history instead of being deleted)
// An asset can only be given to a person or placed at a desk while it is in service and Good.
const { prisma } = require('./prisma');
const activity = require('./officeActivity');

const CATEGORIES = {
  COMPUTER: 'Computer', CASE: 'Computer case', MONITOR: 'Monitor', KEYBOARD: 'Keyboard', MOUSE: 'Mouse', HEADPHONES: 'Headphones',
  TV: 'TV', PRINTER: 'Printer', FURNITURE: 'Furniture', APPLIANCE: 'Appliance', ACCESSORY: 'Accessory', OTHER: 'Other',
};
const CONDITIONS = { GOOD: 'Good', NEEDS_REPAIR: 'Needs repair', BROKEN: 'Broken' };
const LIFECYCLES = { ACTIVE: 'In service', IN_REPAIR: 'In repair', RETIRED: 'Retired' };
const MAX_AT_ONCE = 200;
const PAGE_SIZES = [25, 50, 100];
const TAG_PREFIX = 'SZ-';

const VIEWS = {
  all: { label: 'All in service', definition: 'Every asset that is not retired.', test: (i) => i.lifecycle !== 'RETIRED' },
  assigned: { label: 'Assigned', definition: 'With a person or placed at a desk.', test: (i) => i.lifecycle !== 'RETIRED' && Boolean(i.holderId || i.deskId) },
  unassigned: { label: 'Unassigned', definition: 'Not with a person and not at a desk. Not the same as available.', test: (i) => i.lifecycle !== 'RETIRED' && !i.holderId && !i.deskId },
  available: { label: 'Confirmed available', definition: 'Unassigned, in service, Good, physically checked and nothing left to review: ready to give out.', test: (i) => i.lifecycle === 'ACTIVE' && !i.holderId && !i.deskId && i.condition === 'GOOD' && Boolean(i.verifiedAt) && !needsReview(i) },
  attention: { label: 'Needs repair or broken', definition: 'Condition Needs repair or Broken (both are counted and listed).', test: (i) => i.lifecycle !== 'RETIRED' && (i.condition === 'NEEDS_REPAIR' || i.condition === 'BROKEN') },
  repair: { label: 'Under repair', definition: 'In repair: an open repair is recorded for it.', test: (i) => i.lifecycle === 'IN_REPAIR' },
  review: { label: 'Needs review', definition: 'Marked for review, or missing a model or a location.', test: (i) => i.lifecycle !== 'RETIRED' && needsReview(i) },
  retired: { label: 'Retired', definition: 'Taken out of service; kept with its history.', test: (i) => i.lifecycle === 'RETIRED' },
};
const SORTS = { tag: 'Asset tag', name: 'Item', category: 'Category', custodian: 'Person / desk', location: 'Location', condition: 'Condition', updated: 'Last change' };

function needsReview(i) { return Boolean(i.needsReview || !i.model || !i.location); }

/** May this request use Office Management? The office manager themself only (never while someone views as them). */
const canManageOffice = (req) => Boolean(req.profile && req.profile.officeManager && !req.impersonation);

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
/** Natural order: "Monitor 2" before "Monitor 10", SZ-0009 before SZ-0010. */
const naturalCompare = (a, b) => collator.compare(String(a || ''), String(b || ''));
const clean = (v, max) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
const tagNumber = (tag) => { const m = /^SZ-(\d+)$/.exec(String(tag || '')); return m ? Number(m[1]) : 0; };
const formatTag = (n) => TAG_PREFIX + String(n).padStart(4, '0');

/** People an asset can be given to: everyone active in the organization. */
const people = (actor) => prisma.profile.findMany({ where: { organizationId: actor.organizationId, status: { not: 'ARCHIVED' }, firedAt: null, testOwnerAdminId: null }, select: { id: true, fullName: true }, orderBy: { fullName: 'asc' } });
/** Desks assets can be placed at. */
const desks = (actor) => prisma.officeDesk.findMany({ where: { organizationId: actor.organizationId }, select: { id: true, number: true, profile: { select: { fullName: true } }, personName: true }, orderBy: { number: 'asc' } });
/** Locations already in use, for suggestions. */
async function locations(actor) {
  const rows = await prisma.officeItem.findMany({ where: { organizationId: actor.organizationId, location: { not: null } }, select: { location: true }, distinct: ['location'] });
  return rows.map((r) => r.location).sort(naturalCompare);
}

const INCLUDE = { holder: { select: { id: true, fullName: true, status: true, firedAt: true } }, desk: { select: { id: true, number: true, profile: { select: { fullName: true } }, personName: true } } };

/** One asset as the pages need it: who/where it is, and its flags (computed from the same definitions as above). */
function shape(i) {
  const custodian = i.holder ? i.holder.fullName + (i.holder.status === 'ARCHIVED' || i.holder.firedAt ? ' (former employee)' : '')
    : i.desk ? `Desk ${i.desk.number}${i.desk.profile ? ' · ' + i.desk.profile.fullName : i.desk.personName ? ' · ' + i.desk.personName : ''}` : '';
  return {
    ...i,
    custodian,
    shownLocation: i.desk ? `Desk ${i.desk.number}` : (i.location || ''),
    assigned: VIEWS.assigned.test(i), available: VIEWS.available.test(i), attention: VIEWS.attention.test(i), review: VIEWS.review.test(i),
    assignable: i.lifecycle === 'ACTIVE' && i.condition === 'GOOD',
  };
}

async function allItems(actor) {
  const rows = await prisma.officeItem.findMany({ where: { organizationId: actor.organizationId }, include: INCLUDE });
  return rows.map(shape);
}

/** Reads the list filters from the address bar. Unknown values are ignored. */
function readFilters(query) {
  const pick = (v, allowed) => (allowed.includes(String(v || '')) ? String(v) : '');
  const perPage = PAGE_SIZES.includes(Number(query.per)) ? Number(query.per) : 25;
  return {
    q: clean(query.q, 80),
    view: pick(query.view, Object.keys(VIEWS)) || 'all',
    category: pick(query.category, Object.keys(CATEGORIES)),
    condition: pick(query.condition, Object.keys(CONDITIONS)),
    lifecycle: pick(query.lifecycle, Object.keys(LIFECYCLES)),
    location: clean(query.location, 80),
    custodian: clean(query.custodian, 40),        // a profile id, "desk:<id>", "none"
    sort: pick(query.sort, Object.keys(SORTS)) || 'tag',
    dir: query.dir === 'desc' ? 'desc' : 'asc',
    per: perPage,
    page: Math.max(1, parseInt(query.page, 10) || 1),
  };
}

/** The Assets list: filtered, naturally sorted and paginated; also the total that matches. */
async function listAssets(actor, f) {
  const all = await allItems(actor);
  const text = f.q.toLowerCase();
  let rows = all.filter((i) => VIEWS[f.view].test(i)
    && (!f.category || i.type === f.category)
    && (!f.condition || i.condition === f.condition)
    && (!f.lifecycle || i.lifecycle === f.lifecycle)
    && (!f.location || (i.shownLocation || '').toLowerCase() === f.location.toLowerCase())
    && (!f.custodian || (f.custodian === 'none' ? !i.holderId && !i.deskId : f.custodian.startsWith('desk:') ? i.deskId === f.custodian.slice(5) : i.holderId === f.custodian))
    && (!text || [i.assetTag, i.name, i.model, i.note, i.custodian, i.shownLocation, CATEGORIES[i.type]].some((v) => String(v || '').toLowerCase().includes(text))));
  const key = {
    tag: (i) => i.assetTag || '~', name: (i) => i.name, category: (i) => CATEGORIES[i.type] || i.type, custodian: (i) => i.custodian || '~',
    location: (i) => i.shownLocation || '~', condition: (i) => i.condition, updated: (i) => i.updatedAt.toISOString(),
  }[f.sort];
  rows.sort((a, b) => naturalCompare(key(a), key(b)) || naturalCompare(a.assetTag, b.assetTag) || naturalCompare(a.name, b.name));
  if (f.dir === 'desc') rows.reverse();
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / f.per));
  const page = Math.min(f.page, pages);
  return { rows: rows.slice((page - 1) * f.per, page * f.per), total, page, pages };
}

/** Overview numbers - each with the same predicate as the Assets view it links to. */
async function overview(actor) {
  const all = await allItems(actor);
  const counts = Object.fromEntries(Object.entries(VIEWS).map(([k, v]) => [k, all.filter(v.test).length]));
  const inService = all.filter(VIEWS.all.test);
  const byCategory = Object.entries(CATEGORIES).map(([k, label]) => ({ key: k, label, count: inService.filter((i) => i.type === k).length })).filter((c) => c.count);
  const missing = {
    model: inService.filter((i) => !i.model).length,
    location: inService.filter((i) => !i.location && !i.deskId).length,
    unverified: inService.filter((i) => !i.verifiedAt).length,
  };
  return { counts, total: all.length, byCategory, missing };
}

async function getAsset(actor, id) {
  const row = await prisma.officeItem.findFirst({ where: { id: String(id || ''), organizationId: actor.organizationId }, include: INCLUDE });
  return row ? shape(row) : null;
}

/** Next free asset tags for an organization (never reuses or restarts numbering). */
async function nextTags(db, organizationId, count) {
  const rows = await db.officeItem.findMany({ where: { organizationId, assetTag: { startsWith: TAG_PREFIX } }, select: { assetTag: true } });
  const max = rows.reduce((m, r) => Math.max(m, tagNumber(r.assetTag)), 0);
  return Array.from({ length: count }, (_, i) => formatTag(max + 1 + i));
}

/** Reads the add/edit form. Returns { data } or { error }; never trusts ids from the form. */
function readDetails(body) {
  const name = clean(body.name, 120);
  if (!name) return { error: 'Write the name of the asset.' };
  return {
    data: {
      name,
      model: clean(body.model, 120) || null,
      type: CATEGORIES[body.type] ? body.type : 'OTHER',
      condition: CONDITIONS[body.condition] ? body.condition : 'GOOD',
      location: clean(body.location, 80) || null,
      note: clean(body.note, 500) || null,
    },
  };
}

/**
 * Adds one asset, or several of the same model. Several are shown as a preview first (their tags and names) and only
 * created with confirm=1; at most MAX_AT_ONCE at a time. New assets are unassigned, in service and not yet checked
 * unless "I have checked them" is ticked.
 */
async function createAssets(actor, body) {
  const read = readDetails(body);
  if (read.error) return read;
  const count = parseInt(body.count, 10) || 1;
  if (count < 1 || count > MAX_AT_ONCE) return { error: `Add between 1 and ${MAX_AT_ONCE} at a time.` };
  const verifiedAt = body.verified === '1' ? new Date() : null;
  return prisma.$transaction(async (tx) => {
    const tags = await nextTags(tx, actor.organizationId, count);
    const names = Array.from({ length: count }, (_, i) => (count === 1 ? read.data.name : `${read.data.name} ${i + 1}`));
    if (count > 1 && body.confirm !== '1') return { preview: { count, tags, names, data: read.data, verified: Boolean(verifiedAt) } };
    const created = [];
    for (let i = 0; i < count; i++) {
      const item = await tx.officeItem.create({ data: { ...read.data, name: names[i], assetTag: tags[i], verifiedAt, organizationId: actor.organizationId, createdById: actor.id } });
      created.push(item);
      await activity.log(tx, actor, { itemId: item.id, action: 'CREATED', summary: `${item.assetTag} ${item.name} added`, after: pickLog(item) });
    }
    return { created };
  });
}

const LOGGED = ['assetTag', 'name', 'model', 'type', 'condition', 'location', 'lifecycle', 'holderId', 'deskId', 'note', 'verifiedAt', 'needsReview'];
const pickLog = (i) => Object.fromEntries(LOGGED.map((k) => [k, i[k] instanceof Date ? i[k].toISOString() : i[k] ?? null]));
const diff = (before, after) => {
  const b = {}; const a = {};
  for (const k of LOGGED) { const x = pickLog(before)[k]; const y = pickLog(after)[k]; if (x !== y) { b[k] = x; a[k] = y; } }
  return { before: b, after: a, changed: Object.keys(a) };
};

/** A conflict: someone saved this record after the manager opened it. Nothing is written. */
const CONFLICT = { error: 'Someone else changed this record after you opened it. Nothing was saved - check the current values and try again.', conflict: true };

/** Saves name/model/category/condition/location/note and the review/check marks, if the record is unchanged since it was opened. */
async function updateDetails(actor, id, body) {
  const read = readDetails(body);
  if (read.error) return read;
  return prisma.$transaction(async (tx) => {
    const before = await tx.officeItem.findFirst({ where: { id: String(id), organizationId: actor.organizationId } });
    if (!before) return { status: 404 };
    if (before.lifecycle === 'RETIRED') return { error: 'This asset is retired. Restore it before changing it.' };
    const data = { ...read.data };
    if (before.deskId) data.location = before.location;                       // at a desk: the desk is where it is
    if (body.verified === '1' && !before.verifiedAt) data.verifiedAt = new Date();
    if (body.verified === '0') data.verifiedAt = null;
    if (body.reviewed === '1') data.needsReview = false;
    const { count } = await tx.officeItem.updateMany({ where: { id: before.id, organizationId: actor.organizationId, version: Number(body.version) }, data: { ...data, version: { increment: 1 } } });
    if (!count) return CONFLICT;
    const after = await tx.officeItem.findUnique({ where: { id: before.id } });
    const d = diff(before, after);
    if (d.changed.length) {
      const action = d.changed.includes('condition') ? 'CONDITION_CHANGED' : d.changed.includes('location') ? 'LOCATION_CHANGED' : 'UPDATED';
      await activity.log(tx, actor, { itemId: after.id, action, summary: `${after.assetTag || after.name}: ${d.changed.join(', ')} changed`, before: d.before, after: d.after });
    }
    return { item: after };
  });
}

/**
 * Custody, in one transaction with its history: give to a person, place at a desk, move from one to the other
 * (transfer), or return (to a location, e.g. "Storage"). Only in-service, Good assets can be given out; a person and a
 * desk never hold the same asset at once; the person must be an active member of the organization.
 */
async function changeCustody(actor, id, body) {
  const mode = String(body.mode || '');
  if (!['person', 'desk', 'return'].includes(mode)) return { error: 'Choose what to do with the asset.' };
  return prisma.$transaction(async (tx) => {
    const before = await tx.officeItem.findFirst({ where: { id: String(id), organizationId: actor.organizationId }, include: { holder: { select: { fullName: true } }, desk: { select: { number: true } } } });
    if (!before) return { status: 404 };
    const data = {};
    let action; let summary;
    const from = before.holder ? before.holder.fullName : before.desk ? `desk ${before.desk.number}` : null;
    if (mode === 'return') {
      if (!before.holderId && !before.deskId) return { error: 'This asset is not with anyone.' };
      const location = clean(body.location, 80);
      if (!location) return { error: 'Write where the asset goes back to (for example Storage).' };
      Object.assign(data, { holderId: null, deskId: null, location });
      action = 'RETURNED'; summary = `${before.assetTag || before.name} returned from ${from} to ${location}`;
    } else {
      if (before.lifecycle !== 'ACTIVE') return { error: `This asset is ${LIFECYCLES[before.lifecycle].toLowerCase()} and cannot be given out.` };
      if (before.condition !== 'GOOD') return { error: `This asset is marked ${CONDITIONS[before.condition].toLowerCase()} and cannot be given out until it is Good.` };
      if (mode === 'person') {
        const person = await tx.profile.findFirst({ where: { id: String(body.holderId || ''), organizationId: actor.organizationId, status: { not: 'ARCHIVED' }, firedAt: null }, select: { id: true, fullName: true } });
        if (!person) return { error: 'Choose an active person from the list.' };
        if (before.holderId === person.id) return { error: `${person.fullName} already has this asset.` };
        Object.assign(data, { holderId: person.id, deskId: null });
        summary = `${before.assetTag || before.name} ${from ? `moved from ${from} to` : 'given to'} ${person.fullName}`;
      } else {
        const desk = await tx.officeDesk.findFirst({ where: { id: String(body.deskId || ''), organizationId: actor.organizationId }, select: { id: true, number: true } });
        if (!desk) return { error: 'Choose a desk from the list.' };
        if (before.deskId === desk.id) return { error: `This asset is already at desk ${desk.number}.` };
        Object.assign(data, { deskId: desk.id, holderId: null, location: `Desk ${desk.number}` });
        summary = `${before.assetTag || before.name} ${from ? `moved from ${from} to` : 'placed at'} desk ${desk.number}`;
      }
      action = from ? 'TRANSFERRED' : 'ASSIGNED';
    }
    const { count } = await tx.officeItem.updateMany({ where: { id: before.id, organizationId: actor.organizationId, version: Number(body.version) }, data: { ...data, version: { increment: 1 } } });
    if (!count) return CONFLICT;
    const after = await tx.officeItem.findUnique({ where: { id: before.id } });
    const d = diff(before, after);
    await activity.log(tx, actor, { itemId: after.id, deskId: after.deskId || before.deskId, action, summary, before: d.before, after: d.after });
    return { item: after, summary };
  });
}

/** Retire (out of service, kept with its history) or restore. Retiring returns it from whoever had it. */
async function setRetired(actor, id, body, retire) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.officeItem.findFirst({ where: { id: String(id), organizationId: actor.organizationId } });
    if (!before) return { status: 404 };
    let data; let summary;
    if (retire) {
      if (before.lifecycle === 'RETIRED') return { error: 'This asset is already retired.' };
      const reason = clean(body.reason, 300);
      if (!reason) return { error: 'Write why the asset is retired.' };
      const open = await tx.officeRepair.count({ where: { itemId: before.id, status: { in: ['NEW', 'IN_PROGRESS', 'WAITING'] } } });
      if (open) return { error: 'Resolve or cancel its open repair first (resolving can retire it).' };
      data = { lifecycle: 'RETIRED', retiredAt: new Date(), holderId: null, deskId: null, location: before.location || 'Retired' };
      summary = `${before.assetTag || before.name} retired: ${reason}`;
    } else {
      if (before.lifecycle !== 'RETIRED') return { error: 'This asset is not retired.' };
      data = { lifecycle: 'ACTIVE', retiredAt: null, verifiedAt: null };     // check it again before giving it out
      summary = `${before.assetTag || before.name} restored to service (to be checked)`;
    }
    const { count } = await tx.officeItem.updateMany({ where: { id: before.id, organizationId: actor.organizationId, version: Number(body.version) }, data: { ...data, version: { increment: 1 } } });
    if (!count) return CONFLICT;
    const after = await tx.officeItem.findUnique({ where: { id: before.id } });
    const d = diff(before, after);
    await activity.log(tx, actor, { itemId: after.id, action: retire ? 'RETIRED' : 'RESTORED', summary, before: d.before, after: d.after });
    return { item: after, summary };
  });
}

module.exports = {
  CATEGORIES, CONDITIONS, LIFECYCLES, VIEWS, SORTS, PAGE_SIZES, MAX_AT_ONCE, TAG_PREFIX,
  canManageOffice, naturalCompare, needsReview, readFilters, listAssets, overview, getAsset, people, desks, locations,
  nextTags, formatTag, tagNumber, createAssets, updateDetails, changeCustody, setRetired,
};
