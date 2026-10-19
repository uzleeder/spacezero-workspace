'use strict';
// The Flight Expert Responsibilities + CRM Search & Quote Workflow are imported as ordinary Standards
// content: readable by Flight Experts (and Admins) only, editable through the existing Admin form,
// never duplicated, never auto-acknowledged, and the import changes nothing else.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { importDocuments } = require('../scripts/import-supervisor-standards.cjs');
const { DOCUMENTS } = require('../scripts/import-flight-expert-standards.cjs');
const app = require('../server');

let org, admin, supervisor, agent, expert, cookies = {};
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);
const run = (options = {}) => importDocuments(DOCUMENTS, { adminId: admin.id, ...options });
const itemOf = (title) => prisma.standardsItem.findFirst({ where: { organizationId: org.id, title }, include: { currentVersion: { include: { steps: { orderBy: { displayOrder: 'asc' } }, responsibilities: { orderBy: { displayOrder: 'asc' } } } } } });
const RESP = 'Flight Expert Responsibilities';
const FLOW = 'Flight Expert — CRM Search & Quote Workflow';

async function user(role, name) {
  const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: name, username: `fe_${org.id}_${name}`, email: `fe_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
  const token = generateToken();
  await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
  cookies[p.id] = `sz_session=${token.raw}`;
  return p;
}

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Import flight expert standards tests' } });
  admin = await user('ADMIN', 'admin');
  supervisor = await user('SUPERVISOR', 'supervisor');
  agent = await user('TRAVEL_AGENT', 'agent');
  expert = await user('FLIGHT_EXPERT', 'expert');
});
after(async () => { await prisma.$disconnect(); });

test('creates both documents: published v1, Flight Expert audience, required reading on the Responsibility, nothing else touched', async () => {
  const caps = await prisma.supervisorCapability.count({ where: { organizationId: org.id } });
  const reqs = await prisma.setupRequirement.count({ where: { organizationId: org.id } });
  assert.deepEqual((await run({ dry: true })).results.map((r) => r.action), ['would-create', 'would-create']);
  assert.equal(await prisma.standardsItem.count({ where: { organizationId: org.id } }), 0, 'a dry run writes nothing');
  assert.deepEqual((await run()).results.map((r) => r.action), ['created', 'created']);

  const resp = await itemOf(RESP);
  assert.equal(resp.contentType, 'RESPONSIBILITY');
  assert.equal(resp.rolesJson, JSON.stringify(['FLIGHT_EXPERT']));
  assert.equal(resp.currentVersion.status, 'PUBLISHED');
  assert.equal(resp.currentVersion.version, 1);
  assert.equal(resp.currentVersion.requiredReading, true);
  assert.equal(resp.currentVersion.acknowledgementRequired, false);
  const texts = resp.currentVersion.responsibilities.map((r) => r.text);
  assert.equal(texts.length, 18);
  assert.match(texts.join(' '), /Learn → Practice → Search → Analyze → Verify → Improve → Share/);
  assert.match(texts.find((t) => /Product Management communication/.test(t)), /Tom Allen/);

  const flow = await itemOf(FLOW);
  assert.equal(flow.contentType, 'WORKFLOW');
  assert.equal(flow.rolesJson, JSON.stringify(['FLIGHT_EXPERT']));
  assert.equal(flow.currentVersion.status, 'PUBLISHED');
  assert.equal(flow.currentVersion.steps.length, 20);
  assert.match(flow.currentVersion.steps[6].importantNote ?? JSON.parse(flow.currentVersion.steps[6].detailJson).importantNote, /Do not force three/);

  assert.equal(await prisma.supervisorCapability.count({ where: { organizationId: org.id } }), caps);
  assert.equal(await prisma.setupRequirement.count({ where: { organizationId: org.id } }), reqs);
  assert.equal(await prisma.standardsAcknowledgement.count({ where: { item: { organizationId: org.id } } }), 0);
});

test('running it again is a no-op: no duplicates, no new version', async () => {
  assert.deepEqual((await run()).results.map((r) => r.action), ['unchanged', 'unchanged']);
  for (const title of [RESP, FLOW]) {
    assert.equal(await prisma.standardsItem.count({ where: { organizationId: org.id, title } }), 1);
    assert.equal(await prisma.standardsVersion.count({ where: { item: { organizationId: org.id, title } } }), 1);
  }
});

test('Flight Experts and Admins can read them; Agents and Supervisors cannot see or open them', async () => {
  const resp = await itemOf(RESP);
  const flow = await itemOf(FLOW);
  const page = await get(expert, `/standards/${resp.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /<h3[^>]*>1\. GDS mastery<\/h3>\s*<p[^>]*>Continuously develop your Sabre\/GDS skill/);
  assert.match(page.text, /<h3[^>]*>Final principle<\/h3>/);
  assert.doesNotMatch(page.text, /\*\*/);
  const flowPage = await get(expert, `/standards/${flow.id}`);
  assert.equal(flowPage.status, 200);
  assert.match(flowPage.text, /Minimum three meaningful options/);
  assert.equal((await get(admin, `/standards/${resp.id}`)).status, 200);
  for (const who of [agent, supervisor]) {
    assert.equal((await get(who, `/standards/${resp.id}`)).status, 404);
    assert.equal((await get(who, `/standards/${flow.id}`)).status, 404);
  }
});

test('an Admin can edit both through the normal form (new version, old archived, nothing cut off)', async () => {
  const resp = await itemOf(RESP);
  const texts = resp.currentVersion.responsibilities.map((r) => r.text);
  texts[13] = texts[13].replace('Tom Allen', 'Another Expert');
  const saved = await post(admin, `/admin/standards/${resp.id}`, { title: resp.title, category: resp.category, rolesAudience: 'ROLES', roles: ['FLIGHT_EXPERT'], shortDescription: resp.currentVersion.shortDescription, requiredReading: '1', respText: texts, action: 'publish' });
  assert.equal(saved.status, 302);
  const after = await itemOf(RESP);
  assert.equal(after.currentVersion.version, 2);
  assert.equal(after.currentVersion.responsibilities.length, texts.length);
  assert.match(after.currentVersion.responsibilities[13].text, /Another Expert/);
  assert.equal((await prisma.standardsVersion.findFirst({ where: { itemId: resp.id, version: 1 } })).status, 'ARCHIVED');

  const flow = await itemOf(FLOW);
  const steps = flow.currentVersion.steps.map((s) => ({ title: s.title, instruction: s.instruction, ...JSON.parse(s.detailJson || '{}') }));
  const body = {
    title: flow.title, category: flow.category, rolesAudience: 'ROLES', roles: ['FLIGHT_EXPERT'], shortDescription: flow.currentVersion.shortDescription, action: 'publish',
    stepTitle: steps.map((s) => s.title), stepInstruction: steps.map((s) => s.instruction), stepExplanation: steps.map((s) => s.explanation || ''),
    stepChecklist: steps.map((s) => (s.checklist || []).join('\n')), stepImportantNote: steps.map((s) => s.importantNote || ''), stepWarning: steps.map((s) => s.warning || ''),
    stepDisclosureRefId: steps.map(() => ''), stepRelatedItemId: steps.map(() => ''),
  };
  assert.equal((await post(admin, `/admin/standards/${flow.id}`, body)).status, 302);
  const flowAfter = await itemOf(FLOW);
  assert.equal(flowAfter.currentVersion.version, 2);
  assert.equal(flowAfter.currentVersion.steps.length, 20);
  assert.deepEqual(JSON.parse(flowAfter.currentVersion.steps[1].detailJson).checklist, steps[1].checklist);
  assert.equal(JSON.parse(flowAfter.currentVersion.steps[12].detailJson).warning, steps[12].warning);
});
