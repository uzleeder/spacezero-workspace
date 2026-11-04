'use strict';

// Office Management: one simple list of everything in the SpaceZero office. Only the office manager (Fred Marco,
// Profile.officeManager) sees and changes it - not Admins, not "View as". Each item: a name, a type, who has it
// (or "Office / storage"), its condition and a note.
const { prisma } = require('./prisma');

const TYPES = { COMPUTER: 'Computer', MONITOR: 'Monitor', HEADPHONES: 'Headphones', CASE: 'Case', TV: 'TV', OTHER: 'Other' };
const CONDITIONS = { GOOD: 'Good', NEEDS_REPAIR: 'Needs repair', BROKEN: 'Broken' };
const MAX_AT_ONCE = 200;

/** May this request use Office Management? The office manager themself only (never while someone views as them). */
const canManageOffice = (req) => Boolean(req.profile && req.profile.officeManager && !req.impersonation);

/** The product an item belongs to: its name without the number added when several were added at once ("Mouse 7" -> "Mouse"). */
const productOf = (name) => String(name || '').replace(/\s+\d+$/, '');

const clean = (v, max) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Reads and checks the form. Returns { data } or { error }. holderId must be an active person of the organization. */
async function readItem(actor, body) {
  const name = clean(body.name, 120);
  if (!name) return { error: 'Write the name of the item.' };
  const type = TYPES[body.type] ? body.type : 'OTHER';
  const condition = CONDITIONS[body.condition] ? body.condition : 'GOOD';
  const note = clean(body.note, 500) || null;
  let holderId = String(body.holderId || '') || null;
  if (holderId) {
    const person = await prisma.profile.findFirst({ where: { id: holderId, organizationId: actor.organizationId, status: { not: 'ARCHIVED' } }, select: { id: true } });
    if (!person) return { error: 'Choose someone from the list.' };
  }
  return { data: { name, type, condition, note, holderId } };
}

/** The list, with the filters of the page (search, type, who has it, condition). */
async function listItems(actor, { q = '', type = '', holder = '', condition = '', product = '' } = {}) {
  const where = { organizationId: actor.organizationId };
  if (TYPES[type]) where.type = type;
  if (CONDITIONS[condition]) where.condition = condition;
  if (holder === 'office') where.holderId = null;
  else if (holder) where.holderId = String(holder);
  const text = clean(q, 80);
  if (text) where.OR = [{ name: { contains: text } }, { note: { contains: text } }, { holder: { fullName: { contains: text } } }];
  const items = await prisma.officeItem.findMany({ where, include: { holder: { select: { id: true, fullName: true } } }, orderBy: [{ type: 'asc' }, { name: 'asc' }] });
  return product ? items.filter((i) => productOf(i.name) === product) : items;
}

/** Totals for the tiles on top. */
async function summary(actor) {
  const items = await prisma.officeItem.findMany({ where: { organizationId: actor.organizationId }, select: { name: true, type: true, holderId: true, condition: true } });
  // every type and every product with its count: "Monitors 48", "Case myPro 17 - 3 with people, 14 in the office"
  const byType = Object.keys(TYPES).map((t) => ({ type: t, label: TYPES[t], count: items.filter((i) => i.type === t).length })).filter((t) => t.count);
  const products = new Map();
  for (const i of items) {
    const name = productOf(i.name);
    const p = products.get(name) || { name, type: i.type, total: 0, withPeople: 0, inOffice: 0, needsAttention: 0 };
    p.total += 1; if (i.holderId) p.withPeople += 1; else p.inOffice += 1; if (i.condition !== 'GOOD') p.needsAttention += 1;
    products.set(name, p);
  }
  const order = Object.keys(TYPES);
  return {
    total: items.length,
    inUse: items.filter((i) => i.holderId).length,
    inOffice: items.filter((i) => !i.holderId).length,
    needsAttention: items.filter((i) => i.condition !== 'GOOD').length,
    byType,
    products: [...products.values()].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || a.name.localeCompare(b.name)),
  };
}

/** Adds one item, or several of the same ("Headphones" x 25 -> "Headphones 1" ... "Headphones 25"). */
async function addItems(actor, body) {
  const read = await readItem(actor, body);
  if (read.error) return read;
  const count = Math.max(1, Math.min(MAX_AT_ONCE, parseInt(body.count, 10) || 1));
  const rows = Array.from({ length: count }, (_, i) => ({
    ...read.data, name: count === 1 ? read.data.name : `${read.data.name} ${i + 1}`, organizationId: actor.organizationId, createdById: actor.id,
  }));
  await prisma.officeItem.createMany({ data: rows });
  return { added: count, name: read.data.name };
}

async function updateItem(actor, id, body) {
  const item = await prisma.officeItem.findFirst({ where: { id: String(id), organizationId: actor.organizationId } });
  if (!item) return { error: 'Not found', status: 404 };
  const read = await readItem(actor, body);
  if (read.error) return read;
  await prisma.officeItem.update({ where: { id: item.id }, data: read.data });
  return { name: read.data.name };
}

async function deleteItem(actor, id) {
  const { count } = await prisma.officeItem.deleteMany({ where: { id: String(id), organizationId: actor.organizationId } });
  return count > 0;
}

/** People an item can be given to: everyone active in the organization. */
const people = (actor) => prisma.profile.findMany({ where: { organizationId: actor.organizationId, status: { not: 'ARCHIVED' }, testOwnerAdminId: null }, select: { id: true, fullName: true }, orderBy: { fullName: 'asc' } });

module.exports = { TYPES, CONDITIONS, MAX_AT_ONCE, productOf, canManageOffice, listItems, summary, addItems, updateItem, deleteItem, people };
