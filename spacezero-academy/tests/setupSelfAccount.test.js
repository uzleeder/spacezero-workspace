'use strict';
// Saving WhatsApp / Telegram (entered by the employee) and Passport Details completes those Setup
// items automatically - no extra verification step.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { ensureDefaultRequirements, loadSetupForProfiles } = require('../lib/employeeSetup');
const app = require('../server');

let org, admin, agent, other, cookies = {}, req = {};
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);
const fresh = (p) => prisma.profile.findUnique({ where: { id: p.id } }); // setup is computed from the stored profile
const rowOf = async (p, key) => (await loadSetupForProfiles(org.id, [await fresh(p)])).get(p.id).rows.find((r) => r.requirement.key === key);

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Self account tests' } });
  async function user(role, name) {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `SA ${name}`, username: `sa_${org.id}_${name}`, email: `sa_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
    const t = generateToken();
    await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } });
    cookies[p.id] = `sz_session=${t.raw}`;
    return p;
  }
  admin = await user('ADMIN', 'admin');
  agent = await user('TRAVEL_AGENT', 'agent');
  other = await user('TRAVEL_AGENT', 'other');
  await ensureDefaultRequirements(org.id);
  for (const r of await prisma.setupRequirement.findMany({ where: { organizationId: org.id } })) req[r.key] = r;
});
after(async () => { await prisma.$disconnect(); });

test('the employee Setup page has a number box for WhatsApp and Telegram', async () => {
  const page = await get(agent, `/employees/${agent.id}/setup`);
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`action="/employees/${agent.id}/setup/${req.whatsapp.id}/account"`));
  assert.match(page.text, new RegExp(`action="/employees/${agent.id}/setup/${req.telegram.id}/account"`));
});

test('saving a WhatsApp number completes it on the spot; Telegram too (a personal number used for work)', async () => {
  assert.equal((await rowOf(agent, 'whatsapp')).status, 'NOT_SET_UP');
  const before = (await loadSetupForProfiles(org.id, [agent])).get(agent.id);
  assert.equal((await post(agent, `/employees/${agent.id}/setup/${req.whatsapp.id}/account`, { companyNumber: '+998 90 123 45 67' })).status, 302);
  const wa = await rowOf(agent, 'whatsapp');
  assert.equal(wa.status, 'COMPLETED');
  assert.equal(wa.item.companyNumber, '+998 90 123 45 67');
  assert.equal(wa.awaitingCompanyControl, false);
  assert.equal((await post(agent, `/employees/${agent.id}/setup/${req.telegram.id}/account`, { companyNumber: '@my_work_tg' })).status, 302);
  const tg = await rowOf(agent, 'telegram');
  assert.equal(tg.status, 'COMPLETED');
  assert.equal(tg.item.accountType, 'PERSONAL_WORK');
  const after = (await loadSetupForProfiles(org.id, [agent])).get(agent.id);
  assert.ok(after.completed > before.completed);
  const page = await get(agent, `/employees/${agent.id}/setup`);
  assert.match(page.text, /\+998 90 123 45 67/);
  assert.ok(await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'setup.employee_saved_account', actorId: agent.id } }));
  // saving again updates the number and stays completed
  await post(agent, `/employees/${agent.id}/setup/${req.whatsapp.id}/account`, { companyNumber: '+998 90 000 00 00' });
  const again = await rowOf(agent, 'whatsapp');
  assert.equal(again.status, 'COMPLETED'); assert.equal(again.item.companyNumber, '+998 90 000 00 00');
});

test('bad input is rejected, nobody saves for someone else, and a management-verified item is not overwritten', async () => {
  assert.match((await post(agent, `/employees/${agent.id}/setup/${req.whatsapp.id}/account`, { companyNumber: '' })).text, /Enter your WhatsApp number/);
  assert.match((await post(agent, `/employees/${agent.id}/setup/${req.whatsapp.id}/account`, { companyNumber: '<script>' })).text, /without extra characters/);
  assert.equal((await post(other, `/employees/${agent.id}/setup/${req.whatsapp.id}/account`, { companyNumber: '+1 555 000 1111' })).status, 403);
  assert.equal((await post(admin, `/employees/${agent.id}/setup/${req.whatsapp.id}/account`, { companyNumber: '+1 555 000 1111' })).status, 403); // an Admin uses the normal editor
  assert.equal((await rowOf(agent, 'whatsapp')).item.companyNumber, '+998 90 000 00 00');
  // not a company-controlled item
  assert.equal((await post(agent, `/employees/${agent.id}/setup/${req.pc.id}/account`, { companyNumber: '+998 90 111 22 33' })).status, 403);
  // management verifies WhatsApp: the employee can no longer change it
  assert.equal((await post(admin, `/employees/${agent.id}/setup/${req.whatsapp.id}`, { status: 'COMPLETED', companyControlConfirmed: '1', companyNumber: '+998 71 200 30 40' })).status, 302);
  const res = await post(agent, `/employees/${agent.id}/setup/${req.whatsapp.id}/account`, { companyNumber: '+998 90 999 99 99' });
  assert.match(res.text, /already verified by management/);
  assert.equal((await rowOf(agent, 'whatsapp')).item.companyNumber, '+998 71 200 30 40');
});

test('an Admin who sets WhatsApp back to "In progress" is not overridden by the employee\'s earlier save', async () => {
  await post(admin, `/employees/${other.id}/setup/${req.whatsapp.id}`, { status: 'IN_PROGRESS', note: 'checking' });
  assert.equal((await rowOf(other, 'whatsapp')).status, 'IN_PROGRESS');
});

test('saving Passport Details completes the Passport Setup item automatically', async () => {
  assert.equal((await rowOf(agent, 'passport_details')).status, 'NOT_SET_UP');
  const saved = await post(agent, `/employees/${agent.id}/passport`, { passportFirstName: 'Ali', passportLastName: 'Valiyev', passportNumber: 'AB1234567', passportExpiresAt: '2032-01-01', dateOfBirth: '1995-04-12' });
  assert.equal(saved.status, 302);
  assert.equal((await rowOf(agent, 'passport_details')).status, 'COMPLETED');
});
