'use strict';

// Office Management -> Desks by team. Each desk: its number, who sits there, what is on it (monitor, case, keyboard,
// mouse, headphone), the computer's password and a note. Only the office manager reaches this (routes/office.js).
// The password is encrypted at rest (bound to the desk: "officedesk:<id>") and is only shown on request; every
// request is in the audit log. The page never contains a password until "Show" is pressed.
const { prisma } = require('./prisma');
const { encryptText, decryptText } = require('./credentialCrypto');

const aadOf = (id) => `officedesk:${id}`;
const clean = (v, max) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
const FIELDS = ['monitor', 'pcCase', 'keyboard', 'mouse', 'headphone'];

/** The desks grouped by team, in desk-number order. Team = the person's team, else the desk's own team label. */
async function desksByTeam(actor) {
  const desks = await prisma.officeDesk.findMany({
    where: { organizationId: actor.organizationId },
    include: { profile: { select: { id: true, fullName: true, teamMemberships: { select: { team: { select: { name: true, archivedAt: true } } } } } } },
    orderBy: { number: 'asc' },
  });
  const groups = new Map();
  for (const d of desks) {
    const memberTeam = d.profile && d.profile.teamMemberships.map((m) => m.team).find((t) => !t.archivedAt);
    const team = d.team || (memberTeam && memberTeam.name) || 'Other desks';
    const row = { ...d, hasPassword: Boolean(d.passwordEnc), who: d.profile ? d.profile.fullName : (d.personName || 'Free desk') };
    delete row.passwordEnc;                       // the page never gets the password itself
    if (!groups.has(team)) groups.set(team, []);
    groups.get(team).push(row);
  }
  return [...groups.entries()].map(([team, list]) => ({ team, desks: list }));
}

async function readDesk(actor, body) {
  const number = Number(body.number);
  if (!Number.isInteger(number) || number < 1 || number > 9999) return { error: 'Write the desk number (1-9999).' };
  let profileId = String(body.profileId || '') || null;
  if (profileId) {
    const person = await prisma.profile.findFirst({ where: { id: profileId, organizationId: actor.organizationId, status: { not: 'ARCHIVED' } }, select: { id: true } });
    if (!person) return { error: 'Choose someone from the list.' };
  }
  const data = { number, profileId, team: clean(body.team, 80) || null, personName: profileId ? null : (clean(body.personName, 80) || null), note: clean(body.note, 500) || null };
  for (const f of FIELDS) data[f] = clean(body[f], 80) || null;
  return { data, password: String(body.password || '').slice(0, 200) };
}

async function saveDesk(actor, id, body) {
  const read = await readDesk(actor, body);
  if (read.error) return read;
  const clash = await prisma.officeDesk.findFirst({ where: { organizationId: actor.organizationId, number: read.data.number, ...(id ? { id: { not: String(id) } } : {}) }, select: { id: true } });
  if (clash) return { error: `Desk ${read.data.number} already exists.` };
  let desk;
  if (id) {
    desk = await prisma.officeDesk.findFirst({ where: { id: String(id), organizationId: actor.organizationId } });
    if (!desk) return { error: 'Not found', status: 404 };
    desk = await prisma.officeDesk.update({ where: { id: desk.id }, data: read.data });
  } else {
    desk = await prisma.officeDesk.create({ data: { ...read.data, organizationId: actor.organizationId } });
  }
  // the password changes only when a new one is typed ("Remove password" clears it)
  if (body.clearPassword === '1') await prisma.officeDesk.update({ where: { id: desk.id }, data: { passwordEnc: null } });
  else if (read.password) await prisma.officeDesk.update({ where: { id: desk.id }, data: { passwordEnc: encryptText(read.password, aadOf(desk.id)) } });
  return { desk };
}

/** The desk's computer password, for the office manager who asked for it (null when none is saved). */
async function revealPassword(actor, id) {
  const desk = await prisma.officeDesk.findFirst({ where: { id: String(id), organizationId: actor.organizationId }, select: { id: true, number: true, passwordEnc: true } });
  if (!desk) return { status: 404 };
  return { desk, password: desk.passwordEnc ? decryptText(desk.passwordEnc, aadOf(desk.id)) : null };
}

/** The desk a person sits at, for their own Setup page ("My PC"): number and things, never the password itself. */
async function deskOf(profileId) {
  const d = await prisma.officeDesk.findFirst({ where: { profileId }, select: { id: true, number: true, monitor: true, pcCase: true, keyboard: true, mouse: true, headphone: true, passwordEnc: true } });
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
const pcState = (desk) => !desk ? 'NONE' : desk.number && desk.monitor && desk.headphone && desk.passwordEnc ? 'COMPLETE' : 'PARTIAL';

/**
 * The person fills in their own PC on their Setup page ("My PC"). Their desk is updated, or created; a PC number the
 * office manager recorded without a person is claimed; a number that belongs to someone else is refused.
 */
async function saveOwnDesk(actor, body) {
  const number = Number(body.number);
  if (!Number.isInteger(number) || number < 1 || number > 9999) return { error: 'Write your PC number (the number on your computer or desk).' };
  const fields = {};
  for (const f of FIELDS) fields[f] = clean(body[f], 80) || null;
  const password = String(body.password || '').slice(0, 200);
  const mine = await prisma.officeDesk.findFirst({ where: { organizationId: actor.organizationId, profileId: actor.id } });
  const atNumber = await prisma.officeDesk.findFirst({ where: { organizationId: actor.organizationId, number }, include: { profile: { select: { fullName: true } } } });
  if (atNumber && atNumber.profileId && atNumber.profileId !== actor.id) return { error: `PC ${number} is recorded for ${atNumber.profile.fullName}. Check the number, or ask the office manager.` };
  let desk;
  if (atNumber && (!mine || mine.id !== atNumber.id)) {
    // the office manager recorded this PC without a person: it is theirs now (their old desk record, if any, is freed)
    if (mine) await prisma.officeDesk.update({ where: { id: mine.id }, data: { profileId: null } });
    desk = await prisma.officeDesk.update({ where: { id: atNumber.id }, data: { ...pickFilled(fields, atNumber), profileId: actor.id, personName: null } });
  } else if (mine) {
    desk = await prisma.officeDesk.update({ where: { id: mine.id }, data: { ...fields, number } });
  } else {
    desk = await prisma.officeDesk.create({ data: { ...fields, number, organizationId: actor.organizationId, profileId: actor.id } });
  }
  if (password) desk = await prisma.officeDesk.update({ where: { id: desk.id }, data: { passwordEnc: encryptText(password, aadOf(desk.id)) } });
  const state = pcState(desk);
  if (state === 'COMPLETE') await tickPcItem(actor);
  return { desk, state };
}
/** My PC is complete: the person's Setup item "PC" is ticked for them (their own confirmation), like ticking it themselves. */
async function tickPcItem(actor) {
  const requirement = await prisma.setupRequirement.findFirst({ where: { organizationId: actor.organizationId, key: 'pc', archivedAt: null }, select: { id: true } });
  if (!requirement) return;
  const item = await prisma.employeeSetupItem.findUnique({ where: { profileId_requirementId: { profileId: actor.id, requirementId: requirement.id } } });
  if (item && (item.status === 'NOT_REQUIRED' || (item.status === 'COMPLETED' && (item.verifiedById || item.employeeConfirmedAt)))) return;
  const now = new Date();
  const data = { status: 'COMPLETED', employeeConfirmedAt: now, updatedById: actor.id, note: 'Filled in My PC.' };
  if (item) await prisma.employeeSetupItem.update({ where: { id: item.id }, data });
  else await prisma.employeeSetupItem.create({ data: { profileId: actor.id, requirementId: requirement.id, ...data } });
}

// when claiming a desk the office manager already filled in, an empty field keeps what is recorded
const pickFilled = (fields, existing) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v || existing[k] || null]));

async function deleteDesk(actor, id) {
  const { count } = await prisma.officeDesk.deleteMany({ where: { id: String(id), organizationId: actor.organizationId } });
  return count > 0;
}

module.exports = { desksByTeam, saveDesk, saveOwnDesk, pcState, revealPassword, deleteDesk, deskOf, ownPassword, aadOf, FIELDS };
