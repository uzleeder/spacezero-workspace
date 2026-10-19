'use strict';
// Credential Vault "Save all": one form with a login + password box per required work system. Filling
// in every required system completes the Setup item "Passwords / Credential Vault" automatically.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { hashPassword } = require('../lib/password');
const { ensureDefaultRequirements, loadSetupForProfiles } = require('../lib/employeeSetup');
const app = require('../server');

const PASSWORD = 'Correct-Horse-9!';
const SYSTEMS = ['egf', 'ovago', 'cockpit', 'gds', 'gmail', 'crm', 'dialpad'];
let org, agent, other, cookies = {};
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);
const vaultRow = async (p) => (await loadSetupForProfiles(org.id, [await prisma.profile.findUnique({ where: { id: p.id } })])).get(p.id).rows.find((r) => r.requirement.key === 'credential_vault');
const fill = (keys) => Object.fromEntries(keys.flatMap((k) => [[`login_${k}`, `${k}@example.invalid`], [`secret_${k}`, `${k}-secret`]]));
const reveal = (p, cred, as = p) => post(as, `/credentials/${cred.id}/reveal`, { password: PASSWORD });

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Vault bulk tests' } });
  const passwordHash = await hashPassword(PASSWORD);
  async function user(role, name) {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `VB ${name}`, username: `vb_${org.id}_${name}`, email: `vb_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', passwordHash, employmentStartDate: new Date() } });
    const t = generateToken();
    await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } });
    cookies[p.id] = `sz_session=${t.raw}`;
    return p;
  }
  agent = await user('TRAVEL_AGENT', 'agent');
  other = await user('TRAVEL_AGENT', 'other');
  await ensureDefaultRequirements(org.id);
});
after(async () => { await prisma.$disconnect(); });

test('the vault page lists every required system with a login and password box', async () => {
  const page = await get(agent, `/employees/${agent.id}/credentials`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Required systems/);
  assert.match(page.text, /Save all/);
  for (const k of SYSTEMS) { assert.match(page.text, new RegExp(`name="login_${k}"`)); assert.match(page.text, new RegExp(`name="secret_${k}"`)); }
});

test('Save all stores only the rows that were filled in, and Setup shows what is still missing', async () => {
  assert.equal((await vaultRow(agent)).status, 'NOT_SET_UP');
  assert.match((await post(agent, `/employees/${agent.id}/credentials/bulk`, {})).text, /at least one system/);
  const res = await post(agent, `/employees/${agent.id}/credentials/bulk`, { ...fill(['egf', 'ovago', 'cockpit']), login_gds: '', secret_gds: '' });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /created=3&updated=0/);
  assert.equal(await prisma.credential.count({ where: { ownerId: agent.id } }), 3);
  const row = await vaultRow(agent);
  assert.equal(row.status, 'IN_PROGRESS');
  assert.deepEqual(row.vault, { total: 7, saved: 3, missing: ['GDS', 'Gmail', 'CRM', 'Dialpad'] });
  const page = await get(agent, `/employees/${agent.id}/setup`);
  assert.match(page.text, /Saved 3 of 7 required systems - still needed: GDS, Gmail, CRM, Dialpad/);
  const cred = await prisma.credential.findFirst({ where: { ownerId: agent.id, systemKey: 'egf' } });
  assert.ok(cred.payloadEnc.startsWith('v1.') && !cred.payloadEnc.includes('egf-secret'));
  assert.equal((await reveal(agent, cred)).body.password, 'egf-secret');
});

test('filling in the rest completes the Passwords item automatically; an update keeps blank boxes', async () => {
  const res = await post(agent, `/employees/${agent.id}/credentials/bulk`, { ...fill(['gds', 'gmail', 'crm', 'dialpad']), login_egf: '', secret_egf: 'egf-new-secret' });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /created=4&updated=1/);
  assert.equal(await prisma.credential.count({ where: { ownerId: agent.id } }), 7);
  const row = await vaultRow(agent);
  assert.equal(row.status, 'COMPLETED');
  assert.equal(row.vault.missing.length, 0);
  const egf = await prisma.credential.findFirst({ where: { ownerId: agent.id, systemKey: 'egf' } });
  const shown = (await reveal(agent, egf)).body;
  assert.equal(shown.password, 'egf-new-secret');
  assert.equal(shown.username, 'egf@example.invalid'); // the blank login kept its value
  assert.match((await get(agent, `/employees/${agent.id}/credentials?saved=1&created=4&updated=1`)).text, /Every required system is saved/);
});

test('an "Other" entry named exactly like a required system counts for that system', async () => {
  assert.equal((await post(other, `/employees/${other.id}/credentials`, { customSystem: 'gmail', username: 'me@example.invalid', password: 'x' })).status, 302);
  const cred = await prisma.credential.findFirst({ where: { ownerId: other.id } });
  assert.equal(cred.systemKey, 'gmail');
  // an entry created earlier with no key but the same name is matched too
  await prisma.credential.update({ where: { id: cred.id }, data: { systemKey: null, system: 'GMAIL' } });
  assert.equal((await vaultRow(other)).vault.saved, 1);
});

test('nobody can bulk-write into someone else\'s vault', async () => {
  const res = await post(other, `/employees/${agent.id}/credentials/bulk`, fill(['egf']));
  assert.ok([403, 404].includes(res.status));
  const egf = await prisma.credential.findFirst({ where: { ownerId: agent.id, systemKey: 'egf' } });
  assert.equal((await reveal(agent, egf)).body.password, 'egf-new-secret');
});
