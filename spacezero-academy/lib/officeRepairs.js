'use strict';

// Office Management -> Repairs: a private queue the office manager keeps for equipment and furniture (no employee
// portal, no automatic emails). Each repair is linked to one asset (and the desk it was at, if any).
//
// States and the moves allowed between them:
//   NEW         -> IN_PROGRESS, WAITING, RESOLVED, CANCELLED
//   IN_PROGRESS -> WAITING, RESOLVED, CANCELLED
//   WAITING     -> IN_PROGRESS, RESOLVED, CANCELLED
//   RESOLVED    -> reopened (IN_PROGRESS)
//   CANCELLED   -> reopened (IN_PROGRESS)
// Effects on the asset, in the same transaction:
//   opening      lifecycle -> In repair; condition becomes what the manager reports (Needs repair or Broken)
//   resolving    the manager states the result: condition (Good / Needs repair / Broken) AND lifecycle (In service or
//                Retired) - nothing is marked Good on its own
//   cancelling   lifecycle -> In service again (if no other repair is open); condition unchanged
//   reopening    lifecycle -> In repair again (a retired asset comes back to In repair)
// Overdue = open and its due date has passed; due soon = open and due within 3 days. Due dates are whole days in
// Tashkent time (UTC+05:00): "due 12 Nov" means by the end of 12 Nov in Tashkent.
const { prisma } = require('./prisma');
const activity = require('./officeActivity');

const STATUSES = { NEW: 'New', IN_PROGRESS: 'In progress', WAITING: 'Waiting', RESOLVED: 'Resolved', CANCELLED: 'Cancelled' };
const OPEN = ['NEW', 'IN_PROGRESS', 'WAITING'];
const MOVES = { NEW: ['IN_PROGRESS', 'WAITING'], IN_PROGRESS: ['WAITING'], WAITING: ['IN_PROGRESS'] };
const PRIORITIES = { LOW: 'Low', NORMAL: 'Normal', HIGH: 'High', URGENT: 'Urgent' };
const SOON_DAYS = 3;
const DAY = 86400000;
const TZ_OFFSET_MS = 5 * 3600000;   // Tashkent, no daylight saving

const clean = (v, max) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanText = (v, max) => String(v || '').trim().slice(0, max);
/** "2026-11-12" -> the end of that day in Tashkent. */
function parseDue(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 23, 59, 0) - TZ_OFFSET_MS);
  return Number.isNaN(d.getTime()) ? null : d;
}
/** The Tashkent calendar date of a due time, for the date field. */
const dueInput = (d) => (d ? new Date(d.getTime() + TZ_OFFSET_MS).toISOString().slice(0, 10) : '');
const formatDay = (d) => (d ? d.toLocaleDateString('en-GB', { timeZone: 'Asia/Tashkent', day: 'numeric', month: 'short', year: 'numeric' }) : '');

const isOpen = (r) => OPEN.includes(r.status);
const isOverdue = (r, now = new Date()) => isOpen(r) && r.dueAt && r.dueAt < now;
const isDueSoon = (r, now = new Date()) => isOpen(r) && r.dueAt && r.dueAt >= now && r.dueAt.getTime() - now.getTime() <= SOON_DAYS * DAY;
const VIEWS = {
  open: { label: 'Open', test: (r) => isOpen(r) },
  overdue: { label: 'Overdue', test: (r, now) => isOverdue(r, now) },
  soon: { label: 'Due soon', test: (r, now) => isDueSoon(r, now) },
  waiting: { label: 'Waiting', test: (r) => r.status === 'WAITING' },
  closed: { label: 'Resolved / cancelled', test: (r) => !isOpen(r) },
  all: { label: 'All', test: () => true },
};

const INCLUDE = { item: { select: { id: true, assetTag: true, name: true, model: true, type: true, condition: true, lifecycle: true, version: true } } };

async function list(actor, { view = 'open', q = '' } = {}, now = new Date()) {
  const rows = await prisma.officeRepair.findMany({ where: { organizationId: actor.organizationId }, include: INCLUDE, orderBy: [{ openedAt: 'desc' }] });
  const v = VIEWS[view] ? view : 'open';
  const text = clean(q, 80).toLowerCase();
  const pr = Object.keys(PRIORITIES);
  return rows.filter((r) => VIEWS[v].test(r, now) && (!text || [r.issue, r.responsible, r.item.assetTag, r.item.name, r.notes].some((x) => String(x || '').toLowerCase().includes(text))))
    // open first; then urgent first; then the earliest due
    .sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)) || pr.indexOf(b.priority) - pr.indexOf(a.priority) || (a.dueAt ? a.dueAt.getTime() : Infinity) - (b.dueAt ? b.dueAt.getTime() : Infinity));
}

async function counts(actor, now = new Date()) {
  const rows = await prisma.officeRepair.findMany({ where: { organizationId: actor.organizationId }, select: { status: true, dueAt: true } });
  return Object.fromEntries(Object.entries(VIEWS).map(([k, v]) => [k, rows.filter((r) => v.test(r, now)).length]));
}

const get = (actor, id) => prisma.officeRepair.findFirst({ where: { id: String(id || ''), organizationId: actor.organizationId }, include: INCLUDE });

function readFields(body) {
  const issue = cleanText(body.issue, 1000);
  if (!issue) return { error: 'Describe the problem.' };
  const dueAt = body.dueAt ? parseDue(body.dueAt) : null;
  if (body.dueAt && !dueAt) return { error: 'Choose a valid due date.' };
  return { data: { issue, priority: PRIORITIES[body.priority] ? body.priority : 'NORMAL', responsible: clean(body.responsible, 120) || null, dueAt, notes: cleanText(body.notes, 2000) || null } };
}

/** Opens a repair for an asset: the asset goes to In repair, with the condition the manager reports. */
async function open(actor, body) {
  const read = readFields(body);
  if (read.error) return read;
  const condition = body.condition === 'BROKEN' ? 'BROKEN' : 'NEEDS_REPAIR';
  return prisma.$transaction(async (tx) => {
    const item = await tx.officeItem.findFirst({ where: { id: String(body.itemId || ''), organizationId: actor.organizationId } });
    if (!item) return { error: 'Choose the asset that needs repair.' };
    if (item.lifecycle === 'RETIRED') return { error: 'This asset is retired. Restore it before opening a repair.' };
    const already = await tx.officeRepair.findFirst({ where: { itemId: item.id, status: { in: OPEN } }, select: { id: true } });
    if (already) return { error: 'This asset already has an open repair.', existingId: already.id };
    const repair = await tx.officeRepair.create({ data: { ...read.data, organizationId: actor.organizationId, itemId: item.id, deskId: item.deskId, createdById: actor.id } });
    await tx.officeItem.update({ where: { id: item.id }, data: { lifecycle: 'IN_REPAIR', condition, version: { increment: 1 } } });
    await activity.log(tx, actor, { itemId: item.id, repairId: repair.id, deskId: item.deskId, action: 'REPAIR_OPENED', summary: `Repair opened for ${item.assetTag || item.name}: ${read.data.issue.slice(0, 120)}`, before: { condition: item.condition, lifecycle: item.lifecycle }, after: { condition, lifecycle: 'IN_REPAIR' } });
    return { repair };
  });
}

/** Changes the details and/or moves an open repair to another open state (New / In progress / Waiting). */
async function update(actor, id, body) {
  const read = readFields(body);
  if (read.error) return read;
  return prisma.$transaction(async (tx) => {
    const r = await tx.officeRepair.findFirst({ where: { id: String(id), organizationId: actor.organizationId } });
    if (!r) return { status: 404 };
    if (!isOpen(r)) return { error: 'This repair is closed. Reopen it to change it.' };
    const status = body.status && body.status !== r.status ? body.status : r.status;
    if (status !== r.status && !(MOVES[r.status] || []).includes(status)) return { error: `A ${STATUSES[r.status].toLowerCase()} repair cannot move to ${String(STATUSES[status] || status).toLowerCase()}.` };
    const { count } = await tx.officeRepair.updateMany({ where: { id: r.id, version: Number(body.version) }, data: { ...read.data, status, version: { increment: 1 } } });
    if (!count) return { error: 'Someone else changed this repair after you opened it. Nothing was saved - check it and try again.', conflict: true };
    await activity.log(tx, actor, { itemId: r.itemId, repairId: r.id, action: 'REPAIR_UPDATED', summary: status !== r.status ? `Repair moved to ${STATUSES[status]}` : 'Repair details updated', before: { status: r.status }, after: { status } });
    return { repair: await tx.officeRepair.findUnique({ where: { id: r.id } }) };
  });
}

/** Resolves with an explicit result for the asset: its condition and whether it stays in service or is retired. */
async function resolve(actor, id, body) {
  const resolution = cleanText(body.resolution, 1000);
  if (!resolution) return { error: 'Write what was done.' };
  const condition = { GOOD: 'GOOD', NEEDS_REPAIR: 'NEEDS_REPAIR', BROKEN: 'BROKEN' }[body.resultingCondition];
  const lifecycle = { ACTIVE: 'ACTIVE', RETIRED: 'RETIRED' }[body.resultingLifecycle];
  if (!condition || !lifecycle) return { error: 'Choose the asset\'s condition and whether it stays in service.' };
  return prisma.$transaction(async (tx) => {
    const r = await tx.officeRepair.findFirst({ where: { id: String(id), organizationId: actor.organizationId }, include: { item: true } });
    if (!r) return { status: 404 };
    if (!isOpen(r)) return { error: 'This repair is already closed.' };
    const { count } = await tx.officeRepair.updateMany({ where: { id: r.id, version: Number(body.version) }, data: { status: 'RESOLVED', resolution, resolvedAt: new Date(), resultingCondition: condition, resultingLifecycle: lifecycle, version: { increment: 1 } } });
    if (!count) return { error: 'Someone else changed this repair after you opened it. Nothing was saved - check it and try again.', conflict: true };
    const itemData = lifecycle === 'RETIRED' ? { condition, lifecycle, retiredAt: new Date(), holderId: null, deskId: null } : { condition, lifecycle };
    await tx.officeItem.update({ where: { id: r.itemId }, data: { ...itemData, version: { increment: 1 } } });
    await activity.log(tx, actor, { itemId: r.itemId, repairId: r.id, action: 'REPAIR_RESOLVED', summary: `Repair resolved for ${r.item.assetTag || r.item.name}: ${resolution.slice(0, 120)}`, before: { condition: r.item.condition, lifecycle: r.item.lifecycle }, after: { condition, lifecycle } });
    return { repair: r };
  });
}

/** Cancels an open repair: the asset is back in service (unless another repair is open); its condition is unchanged. */
async function cancel(actor, id, body) {
  return prisma.$transaction(async (tx) => {
    const r = await tx.officeRepair.findFirst({ where: { id: String(id), organizationId: actor.organizationId }, include: { item: true } });
    if (!r) return { status: 404 };
    if (!isOpen(r)) return { error: 'This repair is already closed.' };
    const reason = cleanText(body.reason, 500);
    if (!reason) return { error: 'Write why the repair is cancelled.' };
    const { count } = await tx.officeRepair.updateMany({ where: { id: r.id, version: Number(body.version) }, data: { status: 'CANCELLED', resolution: reason, resolvedAt: new Date(), version: { increment: 1 } } });
    if (!count) return { error: 'Someone else changed this repair after you opened it. Nothing was saved - check it and try again.', conflict: true };
    const otherOpen = await tx.officeRepair.count({ where: { itemId: r.itemId, id: { not: r.id }, status: { in: OPEN } } });
    if (!otherOpen && r.item.lifecycle === 'IN_REPAIR') await tx.officeItem.update({ where: { id: r.itemId }, data: { lifecycle: 'ACTIVE', version: { increment: 1 } } });
    await activity.log(tx, actor, { itemId: r.itemId, repairId: r.id, action: 'REPAIR_CANCELLED', summary: `Repair cancelled for ${r.item.assetTag || r.item.name}: ${reason.slice(0, 120)}`, before: { status: r.status }, after: { status: 'CANCELLED' } });
    return { repair: r };
  });
}

/** Reopens a resolved or cancelled repair: it is in progress again and the asset goes back to In repair. */
async function reopen(actor, id, body) {
  return prisma.$transaction(async (tx) => {
    const r = await tx.officeRepair.findFirst({ where: { id: String(id), organizationId: actor.organizationId }, include: { item: true } });
    if (!r) return { status: 404 };
    if (isOpen(r)) return { error: 'This repair is already open.' };
    const other = await tx.officeRepair.findFirst({ where: { itemId: r.itemId, id: { not: r.id }, status: { in: OPEN } }, select: { id: true } });
    if (other) return { error: 'This asset already has another open repair.' };
    const { count } = await tx.officeRepair.updateMany({ where: { id: r.id, version: Number(body.version) }, data: { status: 'IN_PROGRESS', resolvedAt: null, version: { increment: 1 } } });
    if (!count) return { error: 'Someone else changed this repair after you opened it. Nothing was saved - check it and try again.', conflict: true };
    await tx.officeItem.update({ where: { id: r.itemId }, data: { lifecycle: 'IN_REPAIR', retiredAt: null, version: { increment: 1 } } });
    await activity.log(tx, actor, { itemId: r.itemId, repairId: r.id, action: 'REPAIR_REOPENED', summary: `Repair reopened for ${r.item.assetTag || r.item.name}`, before: { status: r.status, lifecycle: r.item.lifecycle }, after: { status: 'IN_PROGRESS', lifecycle: 'IN_REPAIR' } });
    return { repair: r };
  });
}

module.exports = { STATUSES, OPEN, MOVES, PRIORITIES, VIEWS, SOON_DAYS, list, counts, get, open, update, resolve, cancel, reopen, isOpen, isOverdue, isDueSoon, parseDue, dueInput, formatDay };
