'use strict';
// Date of birth (saved with the passport details) and the automatic birthday greeting.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { parseDateOfBirth, isBirthdayToday, birthdayLetter, runBirthdayGreetings } = require('../lib/birthdays');
const app = require('../server');

let org, admin, agent, other, cookies = {};
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);
const dob = (p) => prisma.profile.findUnique({ where: { id: p.id }, select: { dateOfBirth: true } }).then((r) => r.dateOfBirth && r.dateOfBirth.toISOString().slice(0, 10));
const PASSPORT = { passportFirstName: 'Ali', passportLastName: 'Valiyev', passportNumber: 'AB1234567', passportExpiresAt: '2032-01-01' };

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Birthday tests' } });
  async function user(role, name, extra = {}) {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: name, username: `bd_${org.id}_${role}_${name.replace(/\W/g, '')}`, email: `bd_${org.id}_${role}_${name.replace(/\W/g, '')}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date(), ...extra } });
    const t = generateToken();
    await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } });
    cookies[p.id] = `sz_session=${t.raw}`;
    return p;
  }
  admin = await user('ADMIN', 'Birthday Admin');
  agent = await user('TRAVEL_AGENT', 'Dilnoza Karimova');
  other = await user('TRAVEL_AGENT', 'Someone Else');
});
after(async () => { await prisma.$disconnect(); });

test('parseDateOfBirth accepts real past dates only', () => {
  const now = new Date('2026-10-03T00:00:00.000Z');
  assert.equal(parseDateOfBirth('1995-04-12', now).date.toISOString().slice(0, 10), '1995-04-12');
  for (const bad of ['', 'abc', '1995-13-01', '1995-02-30', '2027-01-01', '1850-01-01', '12/04/1995']) assert.ok(parseDateOfBirth(bad, now).error, bad);
});

test('isBirthdayToday matches the day on the company calendar, and 29 Feb is celebrated on 28 Feb in common years', () => {
  const born = new Date('1995-04-12T00:00:00.000Z');
  assert.equal(isBirthdayToday(born, new Date('2026-04-12T07:00:00.000Z')), true);
  assert.equal(isBirthdayToday(born, new Date('2026-04-11T07:00:00.000Z')), false);
  assert.equal(isBirthdayToday(born, new Date('2026-04-11T20:00:00.000Z')), true); // already 12 April in Tashkent (UTC+5)
  const leap = new Date('2000-02-29T00:00:00.000Z');
  assert.equal(isBirthdayToday(leap, new Date('2026-02-28T07:00:00.000Z')), true);
  assert.equal(isBirthdayToday(leap, new Date('2028-02-28T07:00:00.000Z')), false);
  assert.equal(isBirthdayToday(leap, new Date('2028-02-29T07:00:00.000Z')), true);
  assert.equal(isBirthdayToday(null), false);
});

test('the passport form saves the date of birth for self and for an admin; bad dates are rejected; omitting it keeps the stored value', async () => {
  assert.match((await get(agent, `/employees/${agent.id}/setup`)).text, /name="dateOfBirth"/);
  const saved = await post(agent, `/employees/${agent.id}/passport`, { ...PASSPORT, dateOfBirth: '1995-04-12' });
  assert.equal(saved.status, 302);
  assert.equal(await dob(agent), '1995-04-12');
  const bad = await post(agent, `/employees/${agent.id}/passport`, { ...PASSPORT, dateOfBirth: '2999-01-01' });
  assert.equal(bad.status, 200);
  assert.match(bad.text, /cannot be in the future/);
  assert.equal(await dob(agent), '1995-04-12');
  const blank = await post(agent, `/employees/${agent.id}/passport`, { ...PASSPORT, dateOfBirth: '' });
  assert.match(blank.text, /Date of birth is required/);
  await post(agent, `/employees/${agent.id}/passport`, PASSPORT); // field not sent: unchanged
  assert.equal(await dob(agent), '1995-04-12');
  assert.match((await get(agent, `/employees/${agent.id}/setup`)).text, /April 12, 1995/);
  await post(admin, `/employees/${other.id}/passport`, { ...PASSPORT, passportNumber: 'CD7654321', dateOfBirth: '1990-12-31' });
  assert.equal(await dob(other), '1990-12-31');
  assert.equal((await post(other, `/employees/${agent.id}/passport`, { ...PASSPORT, dateOfBirth: '1980-01-01' })).status === 302, false); // someone else cannot change it
  assert.equal(await dob(agent), '1995-04-12');
});

test('the greeting is sent once per year, only on the birthday, only to active people with a date of birth', async () => {
  const day = new Date('2026-04-12T07:00:00.000Z');
  assert.equal(await runBirthdayGreetings(org.id, day), 1); // agent: 12 April
  assert.equal(await runBirthdayGreetings(org.id, day), 0); // idempotent
  assert.equal(await runBirthdayGreetings(org.id, new Date('2026-04-12T15:00:00.000Z')), 0);
  const n = await prisma.notification.findMany({ where: { profileId: agent.id, type: 'birthday.greeting' } });
  assert.equal(n.length, 1);
  assert.equal(n[0].title, 'Happy Birthday, Dilnoza! 🎂');
  assert.equal(n[0].link, '/birthday');
  assert.equal((await prisma.notification.count({ where: { profileId: other.id, type: 'birthday.greeting' } })), 0);
  assert.equal(await runBirthdayGreetings(org.id, new Date('2027-04-12T07:00:00.000Z')), 1); // next year again
  await prisma.profile.update({ where: { id: other.id }, data: { status: 'DISABLED' } });
  assert.equal(await runBirthdayGreetings(org.id, new Date('2026-12-31T07:00:00.000Z')), 0); // disabled: no greeting
});

test('/birthday shows the card to the person; /admin/birthday-preview is Admin-only and shows the letter and upcoming birthdays', async () => {
  const mine = await get(agent, '/birthday');
  assert.equal(mine.status, 200);
  assert.match(mine.text, /Dear Dilnoza,/);
  assert.match(mine.text, /Happy Birthday!/);
  const none = await get(admin, '/birthday'); // no date of birth, no greeting
  assert.equal(none.status, 200);
  assert.doesNotMatch(none.text, /Dear /);
  const preview = await get(admin, '/admin/birthday-preview');
  assert.equal(preview.status, 200);
  assert.match(preview.text, /Dear Birthday,/);
  assert.match(preview.text, /Upcoming birthdays/);
  assert.match(preview.text, /Dilnoza Karimova/);
  assert.ok([302, 403, 404].includes((await get(agent, '/admin/birthday-preview')).status));
  assert.equal(birthdayLetter({ fullName: 'Madina Aliyeva' }).greeting, 'Dear Madina,');
  assert.match(mine.text, /The SpaceZero Team/);
  assert.doesNotMatch(mine.text, /SpaceZero Workspace Team/);
});
