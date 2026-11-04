'use strict';
// Fired agents: an Admin fires an agent with a reason; Fired agents lists ONE row per company account with every former
// agent inside (real passport names, Admin only); the account goes to a new agent with its saved passwords readable by
// them, while nothing personal of the former agents passes on.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { encryptText, encryptJson, decryptJson } = require('../lib/credentialCrypto');
const { encryptPassportNumber } = require('../lib/passport');
const app = require('../server');

let org, admin, supervisor, max, team, cookies = {};
const KEY = () => `max.${org.id}@above9.test`;
const as = (p) => cookies[p.id];
const login = async (p) => { const t = generateToken(); await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookies[p.id] = `sz_session=${t.raw}`; };
const get = (p, url) => request(app).get(url).set('Cookie', as(p));
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', as(p)).type('form').send(body);

async function agent(fullName, email, username, { passport, phone, address } = {}) {
  const p = await prisma.profile.create({ data: { organizationId: org.id, fullName, username, email, role: 'TRAVEL_AGENT', status: 'ACTIVE', employmentStartDate: new Date('2026-06-01'), phonePrimary: phone || null } });
  await prisma.profile.update({ where: { id: p.id }, data: {
    passportFirstName: passport ? passport[0] : null, passportLastName: passport ? passport[1] : null,
    passportNumberEnc: passport ? encryptPassportNumber(p.id, passport[2]) : null,
    currentAddressEnc: address ? encryptText(address, `address:${p.id}`) : null,
  } });
  await prisma.teamMembership.create({ data: { teamId: team.id, profileId: p.id } });
  await prisma.supervisorAssignment.create({ data: { supervisorId: supervisor.id, agentId: p.id, teamId: team.id, assignedById: admin.id } });
  return p;
}

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Fired agents tests' } });
  const mk = (role, name) => prisma.profile.create({ data: { organizationId: org.id, fullName: `FA ${name}`, username: `fa_${org.id}_${name}`, email: `fa_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
  admin = await mk('ADMIN', 'admin'); supervisor = await mk('SUPERVISOR', 'sup');
  await login(admin); await login(supervisor);
  team = await prisma.team.create({ data: { organizationId: org.id, name: 'Sales A' } });
  max = await agent('Max', KEY(), `max_${org.id}`, { passport: ['Pablo', 'Gomez', 'FA1234567'], phone: '+998 90 111 22 33', address: 'Tashkent, Chilonzor 5' });
  await login(max);
  for (const [system, password] of [['Sabre', 'S@bre-123'], ['Company email', 'Mail-456']]) {
    const c = await prisma.credential.create({ data: { organizationId: org.id, ownerId: max.id, system, payloadEnc: 'x' } });
    await prisma.credential.update({ where: { id: c.id }, data: { payloadEnc: encryptJson({ username: 'max', password }, `cred:${org.id}:${max.id}`) } });
  }
});
after(async () => { await prisma.$disconnect(); });

test('the profile offers Fire; only an Admin can fire, and only with a reason', async () => {
  const page = await get(admin, `/admin/employees/${max.id}`);
  assert.match(page.text, new RegExp(`href="/admin/employees/${max.id}/fire"`));
  assert.ok([403, 404].includes((await post(supervisor, `/admin/employees/${max.id}/fire`, { reason: 'x' })).status)); // refused (the employee is not theirs to see)
  const noReason = await post(admin, `/admin/employees/${max.id}/fire`, { reason: '' });
  assert.equal(noReason.status, 400); assert.match(noReason.text, /Write the reason/);
  assert.equal((await prisma.profile.findUnique({ where: { id: max.id } })).firedAt, null);
});

test('firing signs the agent out, takes them off the team and moves them to Fired agents', async () => {
  const res = await post(admin, `/admin/employees/${max.id}/fire`, { reason: 'Repeated no-shows' });
  assert.equal(res.status, 302); assert.match(res.headers.location, /fired\/account\?key=/);
  const p = await prisma.profile.findUnique({ where: { id: max.id } });
  assert.equal(p.status, 'ARCHIVED'); assert.ok(p.firedAt); assert.equal(p.firedReason, 'Repeated no-shows'); assert.equal(p.accountKey, KEY());
  assert.equal(await prisma.session.count({ where: { profileId: max.id } }), 0);
  assert.equal(await prisma.teamMembership.count({ where: { profileId: max.id } }), 0);
  assert.ok((await prisma.supervisorAssignment.findFirst({ where: { agentId: max.id } })).unassignedAt);
  assert.equal(await prisma.credential.count({ where: { ownerId: max.id } }), 2);                       // kept for the next agent
  assert.equal((await get(max, '/dashboard')).status, 302);                                           // cannot sign in any more
});

test('the account goes to a new agent: same email and username, passwords readable by them, nothing personal', async () => {
  const add = await post(admin, '/admin/employees/new', { fullName: 'Someone', username: `x_${org.id}`, email: KEY(), role: 'TRAVEL_AGENT', supervisorId: supervisor.id, employmentStartDate: '2026-11-01' });
  assert.match(add.text, /company account of a fired agent/);                                         // Add employee points to the hand-over

  const res = await post(admin, '/admin/employees/fired/account/new-agent', { key: KEY(), fullName: 'Sardor Karimov', employmentStartDate: '2026-11-04', teamId: team.id, supervisorId: supervisor.id });
  assert.equal(res.status, 302);
  const next = await prisma.profile.findFirst({ where: { email: KEY() } });
  assert.equal(next.fullName, 'Sardor Karimov'); assert.equal(next.username, `max_${org.id}`); assert.equal(next.status, 'INVITED'); assert.equal(next.firedAt, null);
  assert.equal(next.passportNumberEnc, null); assert.equal(next.currentAddressEnc, null); assert.equal(next.phonePrimary, null); assert.equal(next.passportFirstName, null);
  const logins = await prisma.credential.findMany({ where: { ownerId: next.id }, orderBy: { system: 'asc' } });
  assert.deepEqual(logins.map((c) => decryptJson(c.payloadEnc, `cred:${org.id}:${next.id}`).password), ['Mail-456', 'S@bre-123']);   // readable for the new owner
  const old = await prisma.profile.findUnique({ where: { id: max.id } });
  assert.notEqual(old.email, KEY()); assert.equal(old.accountKey, KEY()); assert.equal(old.passportFirstName, 'Pablo');   // the former agent keeps their own record
});

test('Fired agents shows ONE row per account; opening it lists every former agent with their real passport name', async () => {
  const next = await prisma.profile.findFirst({ where: { email: KEY() } });
  await prisma.profile.update({ where: { id: next.id }, data: { status: 'ACTIVE', passportFirstName: 'Sardor', passportLastName: 'Karimov' } });
  assert.equal((await post(admin, `/admin/employees/${next.id}/fire`, { reason: 'Left after probation' })).status, 302);

  const list = await get(admin, '/admin/employees/fired');
  assert.equal(list.status, 200);
  assert.equal((list.text.match(new RegExp(KEY().replace(/[.+]/g, '\\$&'), 'g')) || []).length >= 1, true);
  assert.equal((list.text.match(/<tr data-href=/g) || []).length, 1);                                   // two agents, ONE account row
  assert.match(list.text, /Free for a new agent/);

  const page = await get(admin, `/admin/employees/fired/account?key=${encodeURIComponent(KEY())}`);
  assert.equal(page.status, 200);
  assert.equal((page.text.match(/data-former-agent=/g) || []).length, 2);
  assert.match(page.text, /Sardor Karimov/); assert.match(page.text, /Pablo Gomez/);                   // real passport names
  assert.match(page.text, /FA1234567/); assert.match(page.text, /Tashkent, Chilonzor 5/); assert.match(page.text, /Repeated no-shows/);
  assert.match(page.text, /Give this account to a new agent/);
});

test('only Admins see Fired agents', async () => {
  for (const url of ['/admin/employees/fired', `/admin/employees/fired/account?key=${encodeURIComponent(KEY())}`]) {
    assert.equal((await get(supervisor, url)).status, 403, url);
  }
});
