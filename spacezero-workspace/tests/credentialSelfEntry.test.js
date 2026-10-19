'use strict';
// An employee has a place to write their own logins & passwords (Credential Vault): the Setup item
// links to it, the vault page has the add form, and the entry is encrypted and bound to the owner.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { hashPassword } = require('../lib/password');
const { setSetting } = require('../lib/orgSettings');
const app = require('../server');

const PASSWORD = 'Correct-Horse-9!';
let org, admin, agent, other, cookies = {};
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Vault self entry tests' } });
  const passwordHash = await hashPassword(PASSWORD);
  async function user(role, name) {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `Vault ${name}`, username: `vs_${org.id}_${name}`, email: `vs_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', passwordHash, employmentStartDate: new Date() } });
    const t = generateToken();
    await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } });
    cookies[p.id] = `sz_session=${t.raw}`;
    return p;
  }
  admin = await user('ADMIN', 'admin');
  agent = await user('TRAVEL_AGENT', 'agent');
  other = await user('TRAVEL_AGENT', 'other');
});
after(async () => { await prisma.$disconnect(); });

test('the employee sees the Setup link, the Credentials tab and the add form, and can store, change and delete their own entries', async () => {
  const setup = await get(agent, `/employees/${agent.id}/setup`);
  assert.equal(setup.status, 200);
  assert.match(setup.text, /Add my logins &amp; passwords/);
  const page = await get(agent, `/employees/${agent.id}/credentials`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Add credential/);
  assert.match(page.text, /name="password"/);
  assert.match((await get(agent, '/profile')).text, new RegExp(`href="/employees/${agent.id}/credentials">Logins &amp; Passwords<`)); // a visible tab, not hidden in "More profile tools"
  assert.match(page.text, /class="tab-link active"[^>]*href="[^"]*\/credentials">Logins &amp; Passwords</);

  const created = await post(agent, `/employees/${agent.id}/credentials`, { system: 'gmail', username: 'me@example.invalid', password: 'my-secret-1' });
  assert.equal(created.status, 302);
  const cred = await prisma.credential.findFirst({ where: { ownerId: agent.id, systemKey: 'gmail' } });
  assert.ok(cred && cred.payloadEnc.startsWith('v1.') && !cred.payloadEnc.includes('my-secret-1'));
  assert.equal(cred.createdById, agent.id);
  assert.match((await get(agent, `/employees/${agent.id}/credentials`)).text, /Gmail/);
  assert.equal((await post(agent, `/credentials/${cred.id}/reveal`, { password: PASSWORD })).body.password, 'my-secret-1');

  assert.equal((await post(agent, `/credentials/${cred.id}/update`, { password: 'my-secret-2' })).status, 302);
  assert.equal((await post(agent, `/credentials/${cred.id}/reveal`, { password: PASSWORD })).body.password, 'my-secret-2');
  assert.equal((await post(agent, `/credentials/${cred.id}/delete`)).status, 302);
  assert.equal(await prisma.credential.count({ where: { ownerId: agent.id } }), 0);
});

test('an entry needs a system and a login or password; with owner-view off the employee can still write but not read back', async () => {
  assert.match((await post(agent, `/employees/${agent.id}/credentials`, { system: 'gmail' })).text, /Enter a login and\/or password/);
  assert.match((await post(agent, `/employees/${agent.id}/credentials`, { password: 'x' })).text, /Choose a system/);
  await setSetting(org.id, 'credentials.ownerCanView', false, admin.id);
  assert.equal((await post(agent, `/employees/${agent.id}/credentials`, { system: 'crm', username: 'agent-crm' })).status, 302);
  const cred = await prisma.credential.findFirst({ where: { ownerId: agent.id, systemKey: 'crm' } });
  assert.ok(cred);
  assert.equal((await post(agent, `/credentials/${cred.id}/reveal`, { password: PASSWORD })).status, 404);
  assert.equal((await post(admin, `/credentials/${cred.id}/reveal`, { password: PASSWORD })).body.username, 'agent-crm'); // the Admin still can
  await setSetting(org.id, 'credentials.ownerCanView', true, admin.id);
});

test('nobody can write into someone else\'s vault', async () => {
  assert.ok([403, 404].includes((await post(other, `/employees/${agent.id}/credentials`, { system: 'gmail', password: 'hacked' })).status));
  assert.ok([403, 404].includes((await get(other, `/employees/${agent.id}/credentials`)).status));
  const cred = await prisma.credential.findFirst({ where: { ownerId: agent.id, systemKey: 'crm' } });
  assert.equal((await post(other, `/credentials/${cred.id}/update`, { password: 'hacked' })).status, 404);
  assert.equal((await post(other, `/credentials/${cred.id}/delete`)).status, 404);
  assert.equal(await prisma.credential.count({ where: { ownerId: agent.id } }), 1);
});
