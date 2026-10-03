'use strict';
// Setup is something each person completes for themselves: every item they save moves their
// percentage, and nothing waits for an Admin / Supervisor to verify the default items.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { hashPassword } = require('../lib/password');
const { ensureDefaultRequirements, loadSetupForProfiles } = require('../lib/employeeSetup');
const { getSetting } = require('../lib/orgSettings');
const app = require('../server');

const SYSTEMS = ['egf', 'ovago', 'cockpit', 'gds', 'gmail', 'crm', 'dialpad'];
let org, agent, cookie;
const post = (url, body = {}) => request(app).post(url).set('Cookie', cookie).type('form').send(body);
const setup = async () => (await loadSetupForProfiles(org.id, [await prisma.profile.findUnique({ where: { id: agent.id } })])).get(agent.id);

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Self service setup tests' } });
  agent = await prisma.profile.create({ data: { organizationId: org.id, fullName: 'SS Agent', username: `ss_${org.id}`, email: `ss_${org.id}@example.invalid`, role: 'TRAVEL_AGENT', status: 'ACTIVE', passwordHash: await hashPassword('Correct-Horse-9!'), employmentStartDate: new Date() } });
  const t = generateToken();
  await prisma.session.create({ data: { profileId: agent.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } });
  cookie = `sz_session=${t.raw}`;
  await ensureDefaultRequirements(org.id);
});
after(async () => { await prisma.$disconnect(); });

test('each password saved moves the percentage, and the last one completes the item', async () => {
  const start = await setup();
  const rowStart = start.rows.find((r) => r.requirement.key === 'credential_vault');
  assert.equal(rowStart.status, 'NOT_SET_UP');
  const body = (keys) => Object.fromEntries(keys.flatMap((k) => [[`login_${k}`, `${k}@example.invalid`], [`secret_${k}`, `${k}-secret`]]));
  let last = start.percent;
  for (let i = 1; i <= SYSTEMS.length; i += 1) {
    assert.equal((await post(`/employees/${agent.id}/credentials/bulk`, body([SYSTEMS[i - 1]]))).status, 302);
    const now = await setup();
    assert.ok(now.percent > last, `percent after ${i} system(s): ${now.percent} should be above ${last}`);
    last = now.percent;
  }
  const done = await setup();
  assert.equal(done.rows.find((r) => r.requirement.key === 'credential_vault').status, 'COMPLETED');
});

test('saving WhatsApp, Telegram and the passport details each move the percentage too', async () => {
  const reqs = Object.fromEntries((await prisma.setupRequirement.findMany({ where: { organizationId: org.id } })).map((r) => [r.key, r]));
  let last = (await setup()).percent;
  for (const [url, body] of [
    [`/employees/${agent.id}/setup/${reqs.whatsapp.id}/account`, { companyNumber: '+998 90 123 45 67' }],
    [`/employees/${agent.id}/passport`, { passportFirstName: 'Ali', passportLastName: 'Valiyev', passportNumber: 'AB1234567', passportExpiresAt: '2032-01-01', dateOfBirth: '1995-04-12' }],
    [`/employees/${agent.id}/setup/self-bulk`, { mode: 'checkbox', checked: [reqs.pc.id, reqs.bookmarks.id] }],
  ]) {
    assert.equal((await post(url, body)).status, 302, url);
    const now = (await setup()).percent;
    assert.ok(now > last, `${url}: ${now} should be above ${last}`);
    last = now;
  }
});

test('the default self-attestable items complete when the employee ticks them - no Admin verification', async () => {
  const reqs = Object.fromEntries((await prisma.setupRequirement.findMany({ where: { organizationId: org.id } })).map((r) => [r.key, r]));
  const rows = (await setup()).rows;
  for (const key of ['pc', 'bookmarks']) assert.equal(rows.find((r) => r.requirement.key === key).status, 'COMPLETED', key);
  assert.equal(reqs.pc.verification, 'EMPLOYEE_CONFIRMATION');
});

test('an organization created before the change is relaxed once: default items become self-confirmed and waiting items complete', async () => {
  const old = await prisma.organization.create({ data: { name: 'Older setup org' } });
  const person = await prisma.profile.create({ data: { organizationId: old.id, fullName: 'Old Agent', username: `old_${old.id}`, email: `old_${old.id}@example.invalid`, role: 'TRAVEL_AGENT', status: 'ACTIVE', employmentStartDate: new Date() } });
  const mk = (key, extra = {}) => prisma.setupRequirement.create({ data: { organizationId: old.id, key, label: key, category: 'Equipment', kind: 'MANUAL', verification: 'MANAGEMENT_VERIFICATION', displayOrder: 1, ...extra } });
  const pc = await mk('pc');
  const custom = await mk('my_custom_item');
  await prisma.employeeSetupItem.create({ data: { profileId: person.id, requirementId: pc.id, status: 'IN_PROGRESS', employeeConfirmedAt: new Date() } });
  await prisma.employeeSetupItem.create({ data: { profileId: person.id, requirementId: custom.id, status: 'IN_PROGRESS', employeeConfirmedAt: new Date() } });
  assert.equal(await getSetting(old.id, 'setup.selfServiceRelaxed'), false);

  await ensureDefaultRequirements(old.id);
  assert.equal((await prisma.setupRequirement.findUnique({ where: { id: pc.id } })).verification, 'EMPLOYEE_CONFIRMATION');
  assert.equal((await prisma.employeeSetupItem.findFirst({ where: { requirementId: pc.id } })).status, 'COMPLETED');
  // an Admin's own custom requirement keeps its management verification, and its waiting item keeps waiting
  assert.equal((await prisma.setupRequirement.findUnique({ where: { id: custom.id } })).verification, 'MANAGEMENT_VERIFICATION');
  assert.equal((await prisma.employeeSetupItem.findFirst({ where: { requirementId: custom.id } })).status, 'IN_PROGRESS');
  assert.equal(await getSetting(old.id, 'setup.selfServiceRelaxed'), true);
});
