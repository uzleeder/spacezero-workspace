'use strict';
// Employee Setup checklist improvement: a compact bulk checklist (many checkboxes -> one Save),
// per-item audit trail, safe concurrency, and Telegram becoming optional with a personal-account path.
// Gemini is never called.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');

mock.method(require('../lib/gemini'), 'generateStructured', async () => { throw new Error('Gemini must not be called in these tests'); });

const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { hashPassword } = require('../lib/password');
const { loadSetupForProfiles } = require('../lib/employeeSetup');
const app = require('../server');

let org, admin, sup, supB, agent, agentB, cookies = {};
let pc, egf, whatsapp, telegram;
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);
const blocked = (res) => res.status !== 200 && res.status < 500;

async function makeUser(role, name, { organizationId = org.id, status = 'ACTIVE' } = {}) {
  const passwordHash = await hashPassword('Correct-Horse-9!');
  const p = await prisma.profile.create({ data: { organizationId, fullName: `SB ${name}`, username: `sb_${organizationId}_${name}`, email: `sb_${organizationId}_${name}@example.invalid`, role, status, passwordHash, employmentStartDate: new Date() } });
  const token = generateToken();
  await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
  cookies[p.id] = `sz_session=${token.raw}`;
  return p;
}

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Setup bulk' } });
  admin = await makeUser('ADMIN', 'admin');
  sup = await makeUser('SUPERVISOR', 'sup'); supB = await makeUser('SUPERVISOR', 'supB');
  await post(admin, '/admin/supervisor-permissions/' + sup.id, { capabilities: ['setup.view', 'setup.manage', 'setup.verify'] });
  agent = await makeUser('TRAVEL_AGENT', 'agent'); agentB = await makeUser('TRAVEL_AGENT', 'agentB');
  await prisma.supervisorAssignment.create({ data: { supervisorId: sup.id, agentId: agent.id, assignedById: admin.id } });
  await prisma.supervisorAssignment.create({ data: { supervisorId: supB.id, agentId: agentB.id, assignedById: admin.id } });
  // Seeds the real DEFAULT_REQUIREMENTS (pc, egf, whatsapp, telegram, ...) for this fresh org.
  await loadSetupForProfiles(org.id, [admin]);
  [pc, egf, whatsapp, telegram] = await Promise.all([
    prisma.setupRequirement.findFirst({ where: { organizationId: org.id, key: 'pc' } }),
    prisma.setupRequirement.findFirst({ where: { organizationId: org.id, key: 'egf' } }),
    prisma.setupRequirement.findFirst({ where: { organizationId: org.id, key: 'whatsapp' } }),
    prisma.setupRequirement.findFirst({ where: { organizationId: org.id, key: 'telegram' } }),
  ]);
  // pc/egf default to EMPLOYEE_CONFIRMATION (self-attestable tool access) so an admin "Verify &
  // complete" step never applies to them out of the box. This file tests that generic management-
  // verification mechanism, which any Admin can still configure on any requirement — simulate that
  // configuration explicitly rather than relying on a default that no longer models it.
  await prisma.setupRequirement.updateMany({ where: { id: { in: [pc.id, egf.id] } }, data: { verification: 'MANAGEMENT_VERIFICATION' } });
});
after(async () => { mock.restoreAll(); await prisma.$disconnect(); });

test('Admin verification is explicit, persists and removes the waiting state', async () => {
  const employee = await makeUser('TRAVEL_AGENT', 'verificationUX');
  await prisma.employeeSetupItem.create({ data: { profileId: employee.id, requirementId: pc.id, status: 'IN_PROGRESS', employeeConfirmedAt: new Date() } });
  const page = await get(admin, `/employees/${employee.id}/setup`);
  assert.match(page.text, /Verify &amp; complete/);
  const saved = await post(admin, `/employees/${employee.id}/setup/${pc.id}`, { status: 'COMPLETED', note: '' });
  assert.equal(saved.status, 302);
  const item = await prisma.employeeSetupItem.findFirst({ where: { profileId: employee.id, requirementId: pc.id } });
  assert.equal(item.status, 'COMPLETED');
  assert.equal(item.verifiedById, admin.id);
  const setup = (await loadSetupForProfiles(org.id, [employee])).get(employee.id);
  assert.equal(setup.rows.find(r => r.requirement.id === pc.id).awaitingVerification, false);
});

test('Admin bulk checklist includes pending confirmations and verifies only selected pending items', async () => {
  const employee = await makeUser('TRAVEL_AGENT', 'bulkVerifyUX');
  await prisma.employeeSetupItem.createMany({ data: [pc, egf].map(r => ({ profileId: employee.id, requirementId: r.id, status: 'IN_PROGRESS', employeeConfirmedAt: new Date() })) });
  const page = await get(admin, `/employees/${employee.id}/setup`);
  assert.match(page.text, new RegExp(`name="checked" value="${pc.id}"`));
  assert.match(page.text, new RegExp(`name="checked" value="${egf.id}"`));
  const saved = await post(admin, `/employees/${employee.id}/setup/bulk`, { checked: pc.id });
  assert.equal(saved.status, 302);
  const items = await prisma.employeeSetupItem.findMany({ where: { profileId: employee.id } });
  assert.equal(items.find(i => i.requirementId === pc.id).status, 'COMPLETED');
  assert.equal(items.find(i => i.requirementId === pc.id).verifiedById, admin.id);
  assert.equal(items.find(i => i.requirementId === egf.id).status, 'IN_PROGRESS');
});

test('COMPACT CHECKLIST: the setup page is compact — one form, one Save Changes button, no per-item Save', async () => {
  const page = await get(admin, `/employees/${agent.id}/setup`);
  assert.equal(page.status, 200);
  assert.match(page.text, /data-bulk-setup-form/);
  assert.match(page.text, /Save Changes/);
});

test('BULK SAVE: multiple checkbox changes persist in ONE request; checked = Completed, unchecked = Not Set Up', async () => {
  const res = await post(admin, `/employees/${agent.id}/setup/bulk`, { checked: [pc.id, egf.id] });
  assert.equal(res.status, 302);
  const items = await prisma.employeeSetupItem.findMany({ where: { profileId: agent.id, requirementId: { in: [pc.id, egf.id] } } });
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => i.status === 'COMPLETED'));
  assert.ok(items.every((i) => i.verifiedById === admin.id), 'the manager who saved is recorded as the verifier');

  // Unchecking pc (egf stays checked) in one more save moves it back to Not Set Up.
  await post(admin, `/employees/${agent.id}/setup/bulk`, { checked: [egf.id] });
  const after2 = await prisma.employeeSetupItem.findMany({ where: { profileId: agent.id, requirementId: { in: [pc.id, egf.id] } } });
  assert.equal(after2.find((i) => i.requirementId === pc.id).status, 'NOT_SET_UP');
  assert.equal(after2.find((i) => i.requirementId === egf.id).status, 'COMPLETED');
});

test('AUDIT: bulk save writes one granular audit entry per changed item, never a single vague "Setup updated"', async () => {
  await prisma.auditLog.deleteMany({ where: { organizationId: org.id, targetId: agentB.id } });
  await post(admin, `/employees/${agentB.id}/setup/bulk`, { checked: [pc.id, egf.id] });
  const entries = await prisma.auditLog.findMany({ where: { organizationId: org.id, targetId: agentB.id, action: 'setup.status_changed' } });
  assert.equal(entries.length, 2, 'one audit row per changed requirement, not one combined row');
  const byKey = new Map(entries.map((e) => [JSON.parse(e.metadataJson).requirement, JSON.parse(e.metadataJson)]));
  assert.deepEqual(byKey.get('pc'), { requirement: 'pc', from: 'NOT_SET_UP', to: 'COMPLETED', via: 'bulk' });
  assert.deepEqual(byKey.get('egf'), { requirement: 'egf', from: 'NOT_SET_UP', to: 'COMPLETED', via: 'bulk' });
  assert.ok(!(await prisma.auditLog.findFirst({ where: { organizationId: org.id, targetId: agentB.id, metadataJson: { contains: 'Setup updated' } } })));
});

test('EXCEPTIONS UNTOUCHED: an Issue/In-Progress/Not-Required item is never silently reset by the bulk checkbox', async () => {
  const crm = await prisma.setupRequirement.findFirst({ where: { organizationId: org.id, key: 'crm' } });
  await post(admin, `/employees/${agent.id}/setup/${crm.id}`, { status: 'ISSUE', note: 'Waiting for account creation' });
  assert.equal((await prisma.employeeSetupItem.findFirst({ where: { profileId: agent.id, requirementId: crm.id } })).status, 'ISSUE');

  // A bulk save that does not mention crm at all must leave it exactly as it was.
  await post(admin, `/employees/${agent.id}/setup/bulk`, { checked: [pc.id] });
  const crmItem = await prisma.employeeSetupItem.findFirst({ where: { profileId: agent.id, requirementId: crm.id } });
  assert.equal(crmItem.status, 'ISSUE'); assert.equal(crmItem.note, 'Waiting for account creation');
});

test('COMPANY-CONTROLLED ITEMS ARE NEVER COMPLETED VIA THE PLAIN CHECKBOX, even if a client crafts the request', async () => {
  const res = await post(admin, `/employees/${agent.id}/setup/bulk`, { checked: [pc.id, whatsapp.id] });
  assert.equal(res.status, 302);
  const wa = await prisma.employeeSetupItem.findFirst({ where: { profileId: agent.id, requirementId: whatsapp.id } });
  assert.ok(!wa || wa.status !== 'COMPLETED', 'WhatsApp needs the individual editor (company number + confirmation), never the bulk checkbox');
});

test('PERMISSION: a Supervisor can bulk-manage their own Agent but never another Supervisor\'s Agent — enforced server-side', async () => {
  const own = await post(sup, `/employees/${agent.id}/setup/bulk`, { checked: [pc.id] });
  assert.equal(own.status, 302);
  const foreign = await post(sup, `/employees/${agentB.id}/setup/bulk`, { checked: [pc.id] });
  assert.ok(blocked(foreign));
});

test('PERMISSION: an employee cannot bulk-manage their own setup, and cannot reach another employee\'s setup at all', async () => {
  assert.ok(blocked(await post(agent, `/employees/${agent.id}/setup/bulk`, { checked: [pc.id] })));
  assert.equal((await post(agent, `/employees/${agentB.id}/setup/bulk`, { checked: [pc.id] })).status, 404);
});

test('PERMISSION: Supervisor cannot create or edit global setup requirements (structure stays Admin-only)', async () => {
  assert.ok(blocked(await get(sup, '/admin/setup-requirements/new')));
  assert.ok(blocked(await post(sup, '/admin/setup-requirements', { label: 'X', category: 'Other', audience: 'ALL_EMPLOYEES', required: 'required', verification: 'MANAGEMENT_VERIFICATION' })));
});

test('CONCURRENCY: a stale save is skipped, not silently overwritten', async () => {
  await prisma.employeeSetupItem.upsert({ where: { profileId_requirementId: { profileId: agent.id, requirementId: pc.id } }, update: { status: 'NOT_SET_UP' }, create: { profileId: agent.id, requirementId: pc.id, status: 'NOT_SET_UP' } });
  const loaded = await prisma.employeeSetupItem.findFirst({ where: { profileId: agent.id, requirementId: pc.id } });
  const staleTs = loaded.updatedAt.toISOString();
  // Someone else changes it in the meantime.
  await new Promise((r) => setTimeout(r, 5));
  await post(admin, `/employees/${agent.id}/setup/${pc.id}`, { status: 'COMPLETED' });
  const changedByOther = await prisma.employeeSetupItem.findFirst({ where: { profileId: agent.id, requirementId: pc.id } });
  assert.equal(changedByOther.status, 'COMPLETED');
  // A bulk save built from the STALE page (unchecking pc) must not blindly overwrite that newer change.
  const res = await post(sup, `/employees/${agent.id}/setup/bulk`, { ['ts_' + pc.id]: staleTs });
  assert.match(res.headers.location, /conflicts=1/);
  const stillCompleted = await prisma.employeeSetupItem.findFirst({ where: { profileId: agent.id, requirementId: pc.id } });
  assert.equal(stillCompleted.status, 'COMPLETED', 'the newer change from the other actor was not clobbered');
});

test('TELEGRAM: optional by default, and being unset does not block 100% Fully Set Up', async () => {
  assert.equal(telegram.required, false);
  assert.equal(telegram.allowPersonalAccount, true);
  const org2 = await prisma.organization.create({ data: { name: 'Setup bulk telegram-only' } });
  const solo = await makeUser('TRAVEL_AGENT', 'solo', { organizationId: org2.id });
  const setups = await loadSetupForProfiles(org2.id, [solo]);
  const t = await prisma.setupRequirement.findFirst({ where: { organizationId: org2.id, key: 'telegram' } });
  const row = setups.get(solo.id).rows.find((r) => r.requirement.id === t.id);
  assert.equal(row.counts, false, 'optional Telegram never counts toward the required total');
});

test('TELEGRAM: supports a Company Number OR a Personal Number used for work, and either completes it', async () => {
  const company = await post(admin, `/employees/${agentB.id}/setup/${telegram.id}`, { status: 'COMPLETED', accountType: 'COMPANY', companyControlConfirmed: '1', companyNumber: '+998901112233' });
  assert.equal(company.status, 302);
  let item = await prisma.employeeSetupItem.findFirst({ where: { profileId: agentB.id, requirementId: telegram.id } });
  assert.equal(item.status, 'COMPLETED'); assert.equal(item.companyControlConfirmed, true);

  const personal = await post(admin, `/employees/${agentB.id}/setup/${telegram.id}`, { status: 'COMPLETED', accountType: 'PERSONAL_WORK' });
  assert.equal(personal.status, 302);
  item = await prisma.employeeSetupItem.findFirst({ where: { profileId: agentB.id, requirementId: telegram.id } });
  assert.equal(item.status, 'COMPLETED', 'a personal number used for work is a valid, complete alternative to company ownership');
  assert.equal(item.accountType, 'PERSONAL_WORK');
  assert.equal(item.companyControlConfirmed, false, 'no company-ownership claim was made');
});

test('TELEGRAM: without either a confirmed company number or a personal-account choice, it does not count as Completed', async () => {
  const res = await post(admin, `/employees/${agentB.id}/setup/${whatsapp.id}`, { status: 'COMPLETED', companyNumber: '+998907654321' });
  assert.notEqual(res.status, 302); // WhatsApp has no allowPersonalAccount escape hatch — still strictly company-only
  const item = await prisma.employeeSetupItem.findFirst({ where: { profileId: agentB.id, requirementId: whatsapp.id } });
  assert.ok(!item || item.status !== 'COMPLETED');
});

test('ADMIN CAN TOGGLE "allow a personal account" WHEN CREATING OR EDITING A REQUIREMENT', async () => {
  const created = await post(admin, '/admin/setup-requirements', {
    label: 'Signal', category: 'Communication', audience: 'ALL_EMPLOYEES', required: 'optional',
    verification: 'MANAGEMENT_VERIFICATION', companyControlled: '1', allowPersonalAccount: '1',
  });
  assert.equal(created.status, 302);
  const signal = await prisma.setupRequirement.findFirst({ where: { organizationId: org.id, key: 'signal' } });
  assert.ok(signal); assert.equal(signal.allowPersonalAccount, true);
});
