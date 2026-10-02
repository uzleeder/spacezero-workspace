'use strict';
// Pressing Save on a Setup page must never end on a bare "Access denied" dead end. Where a Save is
// refused (an Admin "viewing as" an employee, a Supervisor without the Manage Team Setup permission,
// "Not required" which only an Admin may choose) the Setup page itself explains why - and a Save that
// cannot work is not offered in the first place. Nothing is saved in those cases.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const app = require('../server');

let org, admin, supervisor, agent, pc, raw = {};

async function user(role, name) {
  const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: name, username: `sd_${org.id}_${name}`, email: `sd_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
  const token = generateToken();
  await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
  raw[p.id] = token.raw;
  return p;
}
const cookie = (p) => `sz_session=${raw[p.id]}`;
// An Admin who used "View as": the real session is the employee's, the Admin's own session is parked.
const impersonating = (target, by) => `sz_session=${raw[target.id]}; sz_admin_session=${raw[by.id]}`;
const get = (c, url) => request(app).get(url).set('Cookie', c);
const post = (c, url, body = {}) => request(app).post(url).set('Cookie', c).type('form').send(body);
const state = () => prisma.employeeSetupItem.findFirst({ where: { profileId: agent.id, requirementId: pc.id } });
const DENIED_PAGE = /<title>Access denied/;

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Setup save denied tests' } });
  admin = await user('ADMIN', 'admin');
  supervisor = await user('SUPERVISOR', 'supervisor');
  agent = await user('TRAVEL_AGENT', 'agent');
  await prisma.supervisorAssignment.create({ data: { supervisorId: supervisor.id, agentId: agent.id, assignedById: admin.id } });
  await get(cookie(admin), `/employees/${agent.id}/setup`); // seeds the default requirements
  pc = await prisma.setupRequirement.findFirst({ where: { organizationId: org.id, key: 'pc' } });
});
after(async () => { await prisma.$disconnect(); });

test('an Admin viewing as the employee sees a read-only checklist with a clear way to manage it - not a Save that dead-ends', async () => {
  const page = await get(impersonating(agent, admin), `/employees/${agent.id}/setup`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Viewing as|viewing <strong>/i);
  assert.match(page.text, /read-only/);
  assert.match(page.text, /Return to admin and manage this Setup/);
  assert.match(page.text, /name="next" value="\/employees\/[^"]+\/setup"/);
  const form = page.text.split('setup/self-bulk" data-bulk-setup-form')[1].split('</form>')[0];
  assert.match(form, /type="checkbox" name="checked"[^>]*disabled/, 'checkboxes are disabled');
  assert.match(form, /disabled data-bulk-save/, 'Save is disabled');
});

test('a Save sent anyway while viewing as the employee is explained on the Setup page, and nothing is saved', async () => {
  const res = await post(impersonating(agent, admin), `/employees/${agent.id}/setup/self-bulk`, { mode: 'checkbox', checked: [pc.id] });
  assert.equal(res.status, 403);
  assert.doesNotMatch(res.text, DENIED_PAGE, 'not the bare Access denied page');
  assert.match(res.text, /Only .* can confirm their own items here/);
  assert.match(res.text, /Return to admin and manage this Setup/);
  assert.equal(await state(), null, 'nothing was saved');
  const issue = await post(impersonating(agent, admin), `/employees/${agent.id}/setup/${pc.id}/report-issue`, { note: 'x' });
  assert.equal(issue.status, 403);
  assert.doesNotMatch(issue.text, DENIED_PAGE);
});

test('"Return to admin and manage this Setup" ends the view-as session and lands on that Setup page', async () => {
  // Ending a view-as session deletes the employee session it used, so each call gets a fresh one.
  const fresh = async () => { const t = generateToken(); await prisma.session.create({ data: { profileId: agent.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); raw[agent.id] = t.raw; };
  await fresh();
  const res = await post(impersonating(agent, admin), '/end-impersonation', { next: `/employees/${agent.id}/setup` });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `/employees/${agent.id}/setup`);
  await fresh();
  const evil = await post(impersonating(agent, admin), '/end-impersonation', { next: 'https://evil.example/x' });
  assert.equal(evil.headers.location, '/dashboard', 'only same-site paths are followed');
  await fresh();
  const plain = await post(impersonating(agent, admin), '/end-impersonation', {});
  assert.equal(plain.headers.location, '/dashboard');
  await fresh();
  // As the Admin again, the same Save simply works.
  const saved = await post(cookie(admin), `/employees/${agent.id}/setup/bulk`, { checked: [pc.id] });
  assert.equal(saved.status, 302);
  assert.equal((await state()).status, 'COMPLETED');
  await prisma.employeeSetupItem.deleteMany({ where: { profileId: agent.id } });
});

test('the employee\'s own Save keeps working', async () => {
  const res = await post(cookie(agent), `/employees/${agent.id}/setup/self-bulk`, { mode: 'checkbox', checked: [pc.id] });
  assert.equal(res.status, 302);
  assert.equal((await state()).status, 'COMPLETED');
  await prisma.employeeSetupItem.deleteMany({ where: { profileId: agent.id } });
});

test('a Supervisor without the Manage Team Setup permission is told what to ask for, on the Setup page', async () => {
  await prisma.supervisorCapability.deleteMany({ where: { supervisorId: supervisor.id } });
  await prisma.supervisorCapability.create({ data: { organizationId: org.id, supervisorId: supervisor.id, key: 'setup.view', grantedById: admin.id } });
  const bulk = await post(cookie(supervisor), `/employees/${agent.id}/setup/bulk`, { checked: [pc.id] });
  assert.equal(bulk.status, 403);
  assert.doesNotMatch(bulk.text, DENIED_PAGE);
  assert.match(bulk.text, /Manage Team Setup/);
  const one = await post(cookie(supervisor), `/employees/${agent.id}/setup/${pc.id}`, { status: 'COMPLETED' });
  assert.equal(one.status, 403);
  assert.match(one.text, /Manage Team Setup/);
  assert.equal((await post(cookie(supervisor), `/employees/${agent.id}/contact`, { localPhone: '+998901234567' })).status, 403);
  assert.equal(await state(), null, 'nothing was saved');
});

test('only an Admin may mark an item Not required - a Supervisor with manage rights is told so on the page', async () => {
  await prisma.supervisorCapability.create({ data: { organizationId: org.id, supervisorId: supervisor.id, key: 'setup.manage', grantedById: admin.id } });
  const res = await post(cookie(supervisor), `/employees/${agent.id}/setup/${pc.id}`, { status: 'NOT_REQUIRED' });
  assert.equal(res.status, 403);
  assert.doesNotMatch(res.text, DENIED_PAGE);
  assert.match(res.text, /Only an administrator can mark an item as Not required/);
  assert.equal(await state(), null);
});

test('a leftover parked Admin session no longer makes a freshly signed-in account look "viewed as": sign-in and sign-out clear it', async () => {
  const { hashPassword } = require('../lib/password');
  const person = await prisma.profile.create({ data: { organizationId: org.id, fullName: 'Fresh login', username: `sd_${org.id}_fresh`, email: `sd_${org.id}_fresh@example.invalid`, role: 'TRAVEL_AGENT', status: 'ACTIVE', passwordHash: await hashPassword('Correct-Horse-9!'), employmentStartDate: new Date() } });
  const login = await request(app).post('/login').set('Cookie', `sz_admin_session=${raw[admin.id]}`).type('form').send({ identifier: person.username, password: 'Correct-Horse-9!', companyCode: 'SPACE0' });
  assert.equal(login.status, 302);
  const set = [].concat(login.headers['set-cookie'] || []);
  assert.ok(set.some((c) => /^sz_session=[^;]+/.test(c)), 'signed in');
  assert.ok(set.some((c) => /^sz_admin_session=;/.test(c)), 'the stale parked Admin cookie is cleared');
  const mine = set.find((c) => /^sz_session=/.test(c)).split(';')[0];
  const page = await get(mine, `/employees/${person.id}/setup`);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /Return to admin and manage this Setup|impersonated by/);

  const out = await post(`${mine}; sz_admin_session=${raw[admin.id]}`, '/logout');
  const cleared = [].concat(out.headers['set-cookie'] || []).join(' ');
  assert.match(cleared, /sz_session=;/);
  assert.match(cleared, /sz_admin_session=;/, 'signing out ends any view-as for good');
});

test('someone else\'s Setup is still refused outright (authorization unchanged)', async () => {
  const other = await user('TRAVEL_AGENT', 'other');
  assert.equal((await post(cookie(other), `/employees/${agent.id}/setup/self-bulk`, { mode: 'checkbox', checked: [pc.id] })).status, 403);
  assert.equal((await post(cookie(other), `/employees/${agent.id}/setup/bulk`, { checked: [pc.id] })).status, 404);
  assert.equal(await state(), null);
});
