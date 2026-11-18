'use strict';

// Office Management -> Desks. Each desk: its number, team label, who sits there (a person, or a written name), the
// assets linked to it (OfficeItem.deskId - the real records), its older written equipment notes (kept as written until
// the office manager links real assets; never matched automatically), the computer's password and a note.
//
// Readiness: a desk is "ready" when someone sits there and it has, linked: a computer or computer case, a monitor and
// headphones (none retired). "Incomplete" = occupied but not ready. "Unoccupied" = no person and no written name.
//
// The password is encrypted at rest, bound to the desk id ("officedesk:<id>") - desk ids never change. It is never put
// in a page, only shown on request (audited, not cached, hidden again after 20 s). When the person at a desk changes,
// the saved password is removed unless the office manager explicitly keeps it, so a new occupant never inherits the
// previous person's password by accident. The same applies when an employee claims a free desk on their Setup page.
const { prisma } = require('./prisma');
const { encryptText, decryptText } = require('./credentialCrypto');
const activity = require('./officeActivity');

const aadOf = (id) => `officedesk:${id}`;
const clean = (v, max) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
const FIELDS = ['monitor', 'pcCase', 'keyboard', 'mouse', 'headphone'];
const READY_NEEDS = [{ label: 'computer', types: ['COMPUTER', 'CASE'] }, { label: 'monitor', types: ['MONITOR'] }, { label: 'headphones', types: ['HEADPHONES'] }];
const VIEWS = { all: 'All desks', occupied: 'Occupied', unoccupied: 'Unoccupied', incomplete: 'Occupied, not ready' };

function readiness(d) {
  const linked = (d.items || []).filter((i) => i.lifecycle !== 'RETIRED');
  const occupied = Boolean(d.profileId || d.personName);
  const missing = READY_NEEDS.filter((n) => !linked.some((i) => n.types.includes(i.type))).map((n) => n.label);
  return { occupied, missing, ready: occupied && !missing.length, legacy: FIELDS.some((f) => d[f]) };
}

const DESK_INCLUDE = {
  profile: { select: { id: true, fullName: true, status: true, firedAt: true, teamMemberships: { select: { team: { select: { name: true, archivedAt: true } } } } } },
  items: { select: { id: true, assetTag: true, name: true, model: true, type: true, condition: true, lifecycle: true, version: true }, orderBy: { assetTag: 'asc' } },
};

function shape(d) {
  const memberTeam = d.profile && d.profile.teamMemberships.map((m) => m.team).find((t) => !t.archivedAt);
  const row = {
    ...d,
    teamShown: d.team || (memberTeam && memberTeam.name) || '',
    who: d.profile ? d.profile.fullName + (d.profile.status === 'ARCHIVED' || d.profile.firedAt ? ' (former employee)' : '') : (d.personName || ''),
    hasPassword: Boolean(d.passwordEnc),
    ...readiness(d),
  };
  delete row.passwordEnc;                             // pages never get the password itself
  return row;
}

/** Desks with their linked assets and readiness, filtered (all / occupied / unoccupied / incomplete) and searched. */
async function listDesks(actor, { view = 'all', q = '' } = {}) {
  const rows = (await prisma.officeDesk.findMany({ where: { organizationId: actor.organizationId }, include: DESK_INCLUDE, orderBy: { number: 'asc' } })).map(shape);
  const text = clean(q, 80).toLowerCase();
  return rows.filter((d) => (view === 'occupied' ? d.occupied : view === 'unoccupied' ? !d.occupied : view === 'incomplete' ? d.occupied && !d.ready : true)
    && (!text || [String(d.number), d.who, d.teamShown, d.note, ...d.items.map((i) => i.assetTag + ' ' + i.name)].some((x) => String(x || '').toLowerCase().includes(text))));
}

async function deskCounts(actor) {
  const rows = (await prisma.officeDesk.findMany({ where: { organizationId: actor.organizationId }, include: DESK_INCLUDE })).map(shape);
  return { all: rows.length, occupied: rows.filter((d) => d.occupied).length, unoccupied: rows.filter((d) => !d.occupied).length, incomplete: rows.filter((d) => d.occupied && !d.ready).length };
}

async function getDesk(actor, id) {
  const d = await prisma.officeDesk.findFirst({ where: { id: String(id || ''), organizationId: actor.organizationId }, include: DESK_INCLUDE });
  return d ? shape(d) : null;
}

async function readDesk(actor, body) {
  const number = Number(body.number);
  if (!Number.isInteger(number) || number < 1 || number > 9999) return { error: 'Write the desk number (1-9999).' };
  let profileId = String(body.profileId || '') || null;
  if (profileId) {
    const person = await prisma.profile.findFirst({ where: { id: profileId, organizationId: actor.organizationId, status: { not: 'ARCHIVED' }, firedAt: null }, select: { id: true } });
    if (!person) return { error: 'Choose an active person from the list.' };
  }
  const data = { number, profileId, team: clean(body.team, 80) || null, personName: profileId ? null : (clean(body.personName, 80) || null), note: clean(body.note, 500) || null };
  for (const f of FIELDS) data[f] = clean(body[f], 80) || null;
  return { data, password: String(body.password || '').slice(0, 200) };
}

/** Adds or changes a desk (with a conflict check). A new occupant does not inherit the saved password unless kept on purpose. */
async function saveDesk(actor, id, body) {
  const read = await readDesk(actor, body);
  if (read.error) return read;
  return prisma.$transaction(async (tx) => {
    const clash = await tx.officeDesk.findFirst({ where: { organizationId: actor.organizationId, number: read.data.number, ...(id ? { id: { not: String(id) } } : {}) }, select: { id: true } });
    if (clash) return { error: `Desk ${read.data.number} already exists.` };
    let desk; let before = null;
    if (id) {
      before = await tx.officeDesk.findFirst({ where: { id: String(id), organizationId: actor.organizationId } });
      if (!before) return { status: 404 };
      const occupantChanged = (before.profileId || before.personName || null) !== (read.data.profileId || read.data.personName || null);
      const extra = occupantChanged && before.passwordEnc && body.keepPassword !== '1' && !read.password ? { passwordEnc: null } : {};
      const { count } = await tx.officeDesk.updateMany({ where: { id: before.id, organizationId: actor.organizationId, version: Number(body.version) }, data: { ...read.data, ...extra, version: { increment: 1 } } });
      if (!count) return { error: 'Someone else changed this desk after you opened it. Nothing was saved - check it and try again.', conflict: true };
      desk = await tx.officeDesk.findUnique({ where: { id: before.id } });
    } else {
      desk = await tx.officeDesk.create({ data: { ...read.data, organizationId: actor.organizationId } });
    }
    if (body.clearPassword === '1') desk = await tx.officeDesk.update({ where: { id: desk.id }, data: { passwordEnc: null } });
    else if (read.password) desk = await tx.officeDesk.update({ where: { id: desk.id }, data: { passwordEnc: encryptText(read.password, aadOf(desk.id)) } });
    const fields = ['number', 'team', 'profileId', 'personName', 'note', ...FIELDS];
    const changed = before ? fields.filter((f) => (before[f] ?? null) !== (desk[f] ?? null)) : fields.filter((f) => desk[f] != null);
    const passwordChanged = before ? Boolean(before.passwordEnc) !== Boolean(desk.passwordEnc) || Boolean(read.password) : Boolean(desk.passwordEnc);
    await activity.log(tx, actor, {
      deskId: desk.id, action: before ? 'DESK_UPDATED' : 'DESK_ADDED',
      summary: before ? `Desk ${desk.number} changed${changed.length ? ': ' + changed.join(', ') : ''}${passwordChanged ? ' (PC password changed)' : ''}` : `Desk ${desk.number} added`,
      before: before ? Object.fromEntries(changed.map((f) => [f, before[f] ?? null])) : null,
      after: Object.fromEntries(changed.map((f) => [f, desk[f] ?? null])),
    });
    return { desk };
  });
}

/** The desk's computer password, for the office manager who asked for it (null when none is saved). */
async function revealPassword(actor, id) {
  const desk = await prisma.officeDesk.findFirst({ where: { id: String(id), organizationId: actor.organizationId }, select: { id: true, number: true, passwordEnc: true } });
  if (!desk) return { status: 404 };
  return { desk, password: desk.passwordEnc ? decryptText(desk.passwordEnc, aadOf(desk.id)) : null };
}

/** Removes a desk that has no linked assets (move or return them first). Its saved password goes with it. */
async function deleteDesk(actor, id) {
  return prisma.$transaction(async (tx) => {
    const desk = await tx.officeDesk.findFirst({ where: { id: String(id), organizationId: actor.organizationId }, include: { _count: { select: { items: true } } } });
    if (!desk) return { status: 404 };
    if (desk._count.items) return { error: `Desk ${desk.number} still has ${desk._count.items} linked asset${desk._count.items === 1 ? '' : 's'}. Return or move them first.` };
    await tx.officeDesk.delete({ where: { id: desk.id } });
    await activity.log(tx, actor, { deskId: desk.id, action: 'DESK_REMOVED', summary: `Desk ${desk.number} removed` });
    return { removed: desk };
  });
}

/** The desk a person sits at, for their own pages ("My Desk"): number, equipment and linked assets - never the password. */
async function deskOf(profileId) {
  const d = await prisma.officeDesk.findFirst({ where: { profileId }, select: { id: true, number: true, monitor: true, pcCase: true, keyboard: true, mouse: true, headphone: true, passwordEnc: true, items: { where: { lifecycle: { not: 'RETIRED' } }, select: { assetTag: true, name: true, type: true }, orderBy: { assetTag: 'asc' } } } });
  if (!d) return null;
  const { passwordEnc, ...rest } = d;
  return { ...rest, hasPassword: Boolean(passwordEnc) };
}

/** A person's own computer password (their own desk only). */
async function ownPassword(profileId) {
  const d = await prisma.officeDesk.findFirst({ where: { profileId }, select: { id: true, number: true, passwordEnc: true } });
  if (!d) return null;
  return { desk: d, password: d.passwordEnc ? decryptText(d.passwordEnc, aadOf(d.id)) : null };
}

/** Is the person's PC filled in for Setup? Complete = PC number, monitor, headphone and password; partial = a desk with some of it. */
// "My Desk": the PC and the monitor are written as their name and number ("Ziffler 24\" #12"); headphones, keyboard and
// mouse by name only. Kept in the desk's own text fields. PC, monitor and headphones are required; keyboard and mouse
// are optional.
const PIECES = [
  { field: 'pcCase', label: 'PC', required: true, numbered: true, example: 'myPro' },
  { field: 'monitor', label: 'Monitor', required: true, numbered: true, example: 'Ziffler 24"' },
  { field: 'headphone', label: 'Headphones', required: true, numbered: false, example: 'Logitech' },
  { field: 'keyboard', label: 'Keyboard', required: false, numbered: false, example: 'Logitech K120' },
  { field: 'mouse', label: 'Mouse', required: false, numbered: false, example: 'Logitech M90' },
];
const joinPiece = (name, no) => [name, no ? `#${String(no).replace(/^#/, '')}` : ''].filter(Boolean).join(' ');
/** "Ziffler 24\" #12" -> { name: 'Ziffler 24"', no: '12' }; text without a number keeps it all as the name. */
function splitPiece(text) {
  const m = String(text || '').match(/^(.*?)\s*#(\S+)$/);
  return m ? { name: m[1].trim(), no: m[2] } : { name: String(text || '').trim(), no: '' };
}
const pcState = (desk) => !desk ? 'NONE' : desk.number && desk.pcCase && desk.monitor && desk.headphone && desk.passwordEnc ? 'COMPLETE' : 'PARTIAL';

/**
 * The person fills in their own desk on their Setup page ("My Desk"): the desk number, the PC and monitor by name and
 * number, and the headphones (plus keyboard and mouse if they like) by name. Their desk is updated, or created; a desk the office manager recorded without a person is claimed -
 * without its previously saved password (they enter their own); a desk number that belongs to someone else is refused.
 * Older forms that send one text per piece (monitor=...) still work.
 */
async function saveOwnDesk(actor, body) {
  const number = Number(body.number);
  if (!Number.isInteger(number) || number < 1 || number > 9999) return { error: 'Write your desk number (the number on your desk).' };
  const fields = {};
  for (const f of FIELDS) {
    const piece = PIECES.find((p) => p.field === f);
    if (piece && (body[`${f}Name`] !== undefined || body[`${f}No`] !== undefined)) {
      const name = clean(body[`${f}Name`], 60);
      const no = piece.numbered ? clean(body[`${f}No`], 20).replace(/^#/, '') : '';
      if (piece.numbered && piece.required && (!name || !no)) return { error: `Write the ${piece.label.toLowerCase()} name and its number.` };
      if (!piece.numbered && piece.required && !name) return { error: `Write the ${piece.label.toLowerCase()} name.` };
      fields[f] = joinPiece(name, no) || null;
    } else fields[f] = clean(body[f], 80) || null;
  }
  const password = String(body.password || '').slice(0, 200);
  const mine = await prisma.officeDesk.findFirst({ where: { organizationId: actor.organizationId, profileId: actor.id } });
  const atNumber = await prisma.officeDesk.findFirst({ where: { organizationId: actor.organizationId, number }, include: { profile: { select: { fullName: true } } } });
  if (atNumber && atNumber.profileId && atNumber.profileId !== actor.id) return { error: `Desk ${number} is recorded for ${atNumber.profile.fullName}. Check the number, or ask the office manager.` };
  let desk;
  if (atNumber && (!mine || mine.id !== atNumber.id)) {
    if (mine) await prisma.officeDesk.update({ where: { id: mine.id }, data: { profileId: null, version: { increment: 1 } } });
    desk = await prisma.officeDesk.update({ where: { id: atNumber.id }, data: { ...pickFilled(fields, atNumber), profileId: actor.id, personName: null, passwordEnc: null, version: { increment: 1 } } });
  } else if (mine) {
    desk = await prisma.officeDesk.update({ where: { id: mine.id }, data: { ...fields, number, version: { increment: 1 } } });
  } else {
    desk = await prisma.officeDesk.create({ data: { ...fields, number, organizationId: actor.organizationId, profileId: actor.id } });
  }
  if (password) desk = await prisma.officeDesk.update({ where: { id: desk.id }, data: { passwordEnc: encryptText(password, aadOf(desk.id)) } });
  const state = pcState(desk);
  if (state === 'COMPLETE') await tickPcItem(actor);
  return { desk, state };
}
/** My Desk is complete: the person's Setup item for it (key "pc") is ticked for them (their own confirmation), like ticking it themselves. */
async function tickPcItem(actor) {
  const requirement = await prisma.setupRequirement.findFirst({ where: { organizationId: actor.organizationId, key: 'pc', archivedAt: null }, select: { id: true } });
  if (!requirement) return;
  const item = await prisma.employeeSetupItem.findUnique({ where: { profileId_requirementId: { profileId: actor.id, requirementId: requirement.id } } });
  if (item && (item.status === 'NOT_REQUIRED' || (item.status === 'COMPLETED' && (item.verifiedById || item.employeeConfirmedAt)))) return;
  const data = { status: 'COMPLETED', employeeConfirmedAt: new Date(), updatedById: actor.id, note: 'Filled in My Desk.' };
  if (item) await prisma.employeeSetupItem.update({ where: { id: item.id }, data });
  else await prisma.employeeSetupItem.create({ data: { profileId: actor.id, requirementId: requirement.id, ...data } });
}
// when claiming a desk the office manager already filled in, an empty field keeps what is recorded
const pickFilled = (fields, existing) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v || existing[k] || null]));

module.exports = { VIEWS, READY_NEEDS, listDesks, deskCounts, getDesk, saveDesk, saveOwnDesk, pcState, revealPassword, deleteDesk, deskOf, ownPassword, aadOf, FIELDS, PIECES, splitPiece, joinPiece };
