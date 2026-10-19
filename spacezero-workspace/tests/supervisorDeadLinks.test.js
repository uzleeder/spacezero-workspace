'use strict';
// A Supervisor holds no management capability until an Admin grants it, so any link/tab/button that
// would end on "Access denied" must not be offered to them in the first place — and must appear as
// soon as the matching capability is granted. The server-side check on each route is unchanged.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { hashPassword } = require('../lib/password');
const { setupLinkFor } = require('../lib/supervisorCapabilities');
const app = require('../server');

let org, admin, sup, agent, cookies = {};
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);

async function makeUser(role, name) {
  const passwordHash = await hashPassword('Correct-Horse-9!');
  const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `DL ${name}`, username: `dl_${org.id}_${name}`, email: `dl_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', passwordHash, employmentStartDate: new Date() } });
  const token = generateToken();
  await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
  cookies[p.id] = `sz_session=${token.raw}`;
  return p;
}

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Dead link tests' } });
  admin = await makeUser('ADMIN', 'admin');
  sup = await makeUser('SUPERVISOR', 'sup');
  agent = await makeUser('TRAVEL_AGENT', 'agent');
  await prisma.supervisorAssignment.create({ data: { supervisorId: sup.id, agentId: agent.id, assignedById: admin.id } });
});
after(async () => { await prisma.$disconnect(); });

test('the Assignments tab is only offered to a Supervisor who may actually open it', async () => {
  assert.equal((await get(sup, '/assignments')).status, 403, 'without training.assign the page itself is refused');
  const without = await get(sup, '/admin/training');
  assert.equal(without.status, 200);
  assert.doesNotMatch(without.text, /href="\/assignments"/, 'no Assignments tab without the grant');
  assert.match((await get(admin, '/admin/training')).text, /href="\/assignments"/, 'an Admin always has it');

  await post(admin, '/admin/supervisor-permissions/' + sup.id, { capabilities: ['training.assign'] });
  assert.match((await get(sup, '/admin/training')).text, /href="\/assignments"/, 'granting training.assign makes the tab appear');
  await post(admin, '/admin/supervisor-permissions/' + sup.id, {});
});

test('a Supervisor without setup.view is not linked to the Setup page of their team members', async () => {
  assert.equal((await get(sup, `/employees/${agent.id}/setup`)).status, 403);
  const profilePage = await get(sup, `/team/${agent.id}`);
  assert.equal(profilePage.status, 200);
  assert.doesNotMatch(profilePage.text, new RegExp(`href="/employees/${agent.id}/setup"`), 'no "Open setup" link');
  // The employee tab bar (Skills / Vacation tabs of the same person) must not offer a Setup tab either.
  for (const tab of ['skills', 'leave']) {
    const page = await get(sup, `/employees/${agent.id}/${tab}`);
    assert.equal(page.status, 200, tab);
    assert.doesNotMatch(page.text, new RegExp(`href="/employees/${agent.id}/setup"`), `${tab} tab bar has no Setup tab`);
  }

  await post(admin, '/admin/supervisor-permissions/' + sup.id, { capabilities: ['setup.view'] });
  assert.match((await get(sup, `/team/${agent.id}`)).text, new RegExp(`href="/employees/${agent.id}/setup"`));
  for (const tab of ['skills', 'leave']) assert.match((await get(sup, `/employees/${agent.id}/${tab}`)).text, new RegExp(`href="/employees/${agent.id}/setup"`), `${tab} tab bar has the Setup tab once granted`);
  await post(admin, '/admin/supervisor-permissions/' + sup.id, {});
});

test('notifications about someone\'s Setup send a Supervisor without setup.view to a page they can open', async () => {
  assert.equal(await setupLinkFor(sup.id, agent.id), `/team/${agent.id}`);
  assert.equal(await setupLinkFor(admin.id, agent.id), `/employees/${agent.id}/setup`);
  assert.equal(await setupLinkFor(agent.id, agent.id), `/employees/${agent.id}/setup`);
  await post(admin, '/admin/supervisor-permissions/' + sup.id, { capabilities: ['setup.view'] });
  assert.equal(await setupLinkFor(sup.id, agent.id), `/employees/${agent.id}/setup`);
  await post(admin, '/admin/supervisor-permissions/' + sup.id, {});
});

test('the access-denied page tells a Supervisor how to get access instead of leaving a dead end', async () => {
  const res = await get(sup, `/employees/${agent.id}/setup`);
  assert.equal(res.status, 403);
  assert.match(res.text, /ask an administrator/i);
  assert.match(res.text, /Supervisor Permissions/);
  const other = await get(agent, '/admin/training');
  assert.ok(other.status === 403 || other.status === 302);
  if (other.status === 403) assert.doesNotMatch(other.text, /Supervisor Permissions/, 'only Supervisors get the grant hint');
});
