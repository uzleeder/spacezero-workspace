'use strict';
// The Supervisor Responsibilities + Daily Workflow are imported as ordinary Standards content: they
// must be readable by Supervisors only (Admins always), editable through the existing Admin form
// (which creates a new version without anything being cut off), never duplicated on a second run,
// never auto-acknowledged, and the import must not touch permissions or any other content.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { importSupervisorStandards, DOCUMENTS, LIMITS } = require('../scripts/import-supervisor-standards.cjs');
const app = require('../server');

let org, admin, supervisor, agent, expert, cookies = {}, other;
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);
const itemOf = (title) => prisma.standardsItem.findFirst({ where: { organizationId: org.id, title }, include: { currentVersion: { include: { steps: { orderBy: { displayOrder: 'asc' } }, responsibilities: { orderBy: { displayOrder: 'asc' } } } } } });

async function user(role, name) {
  const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: name, username: `ss_${org.id}_${name}`, email: `ss_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
  const token = generateToken();
  await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
  cookies[p.id] = `sz_session=${token.raw}`;
  return p;
}

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Import standards tests' } });
  admin = await user('ADMIN', 'admin');
  supervisor = await user('SUPERVISOR', 'supervisor');
  agent = await user('TRAVEL_AGENT', 'agent');
  expert = await user('FLIGHT_EXPERT', 'expert');
  // An unrelated, already-published standard that the import must leave completely alone.
  other = await prisma.standardsItem.create({ data: { organizationId: org.id, contentType: 'STANDARD', title: 'Unrelated standard', createdById: admin.id } });
  const v = await prisma.standardsVersion.create({ data: { itemId: other.id, version: 1, status: 'PUBLISHED', createdById: admin.id, shortDescription: 'keep me', publishedAt: new Date() } });
  await prisma.standardsItem.update({ where: { id: other.id }, data: { currentVersionId: v.id } });
});
after(async () => { await prisma.$disconnect(); });

test('every stored item fits the Admin form limits (nothing is cut off when an Admin saves)', () => {
  for (const d of DOCUMENTS) {
    assert.ok(d.shortDescription.length <= LIMITS.shortDescription);
    for (const t of d.items || []) assert.ok(t.length <= LIMITS.responsibility, t.slice(0, 40));
    for (const s of d.steps || []) { assert.ok(s.instruction.length <= LIMITS.stepInstruction); assert.ok((s.checklist || []).length <= LIMITS.maxChecklist); }
  }
});

test('a dry run writes nothing', async () => {
  const dry = await importSupervisorStandards({ adminId: admin.id, dry: true });
  assert.deepEqual(dry.results.map((r) => r.action), ['would-create', 'would-create']);
  assert.equal(await prisma.standardsItem.count({ where: { organizationId: org.id, title: { in: DOCUMENTS.map((d) => d.title) } } }), 0);
});

test('the import creates the Responsibility and the Workflow: published v1, Supervisor audience, required reading on the Responsibility', async () => {
  const capsBefore = await prisma.supervisorCapability.count({ where: { organizationId: org.id } });
  const reqsBefore = await prisma.setupRequirement.count({ where: { organizationId: org.id } });
  const run = await importSupervisorStandards({ adminId: admin.id });
  assert.deepEqual(run.results.map((r) => r.action), ['created', 'created']);

  const resp = await itemOf('Supervisor Responsibilities');
  assert.equal(resp.contentType, 'RESPONSIBILITY');
  assert.equal(resp.rolesJson, JSON.stringify(['SUPERVISOR']));
  assert.equal(resp.currentVersion.status, 'PUBLISHED');
  assert.equal(resp.currentVersion.version, 1);
  assert.equal(resp.currentVersion.requiredReading, true);
  assert.equal(resp.currentVersion.acknowledgementRequired, false, 'no acknowledgement is imposed on anyone');
  assert.ok(resp.currentVersion.responsibilities.length >= 20);
  assert.match(resp.currentVersion.responsibilities.map((r) => r.text).join(' '), /at least ONE meaningful team training per week/);

  const flow = await itemOf('Supervisor — Daily Team Management & Development Workflow');
  assert.equal(flow.contentType, 'WORKFLOW');
  assert.equal(flow.rolesJson, JSON.stringify(['SUPERVISOR']));
  assert.equal(flow.currentVersion.status, 'PUBLISHED');
  assert.equal(flow.currentVersion.steps.length, 19);
  assert.match(flow.currentVersion.steps[flow.currentVersion.steps.length - 1].instruction, /Monitor → Diagnose → Support → Develop → Verify → Handover \/ Escalate/);

  // Nothing else moved: no permission, setup rule, acknowledgement or other content changed.
  assert.equal(await prisma.supervisorCapability.count({ where: { organizationId: org.id } }), capsBefore);
  assert.equal(await prisma.setupRequirement.count({ where: { organizationId: org.id } }), reqsBefore);
  assert.equal(await prisma.standardsAcknowledgement.count({ where: { item: { organizationId: org.id } } }), 0);
  const untouched = await prisma.standardsItem.findUnique({ where: { id: other.id }, include: { versions: true } });
  assert.equal(untouched.versions.length, 1);
  assert.equal(untouched.versions[0].shortDescription, 'keep me');
});

test('a second run is a no-op: no duplicate item, no new version', async () => {
  const again = await importSupervisorStandards({ adminId: admin.id });
  assert.deepEqual(again.results.map((r) => r.action), ['unchanged', 'unchanged']);
  for (const d of DOCUMENTS) {
    assert.equal(await prisma.standardsItem.count({ where: { organizationId: org.id, title: d.title } }), 1);
    assert.equal(await prisma.standardsVersion.count({ where: { item: { organizationId: org.id, title: d.title } } }), 1);
  }
});

test('Supervisors (and Admins) can read both; Agents and Flight Experts cannot see or open them', async () => {
  const resp = await itemOf('Supervisor Responsibilities');
  const flow = await itemOf('Supervisor — Daily Team Management & Development Workflow');
  const supPage = await get(supervisor, `/standards/${resp.id}`);
  assert.equal(supPage.status, 200);
  assert.match(supPage.text, /Supervisor Responsibilities/);
  assert.match(supPage.text, /Observe/);
  assert.equal((await get(supervisor, `/standards/${flow.id}`)).status, 200);
  assert.equal((await get(admin, `/standards/${resp.id}`)).status, 200);

  // Same look as a Standard: numbered headings with a paragraph beneath each, not a numbered list.
  assert.match(supPage.text, /<h3[^>]*>1\. Team leadership<\/h3>\s*<p[^>]*>Manage the assigned team day to day/);
  assert.match(supPage.text, /<h3[^>]*>16\. Weekend Supervisor availability<\/h3>/);
  assert.match(supPage.text, /<h3[^>]*>Final principle<\/h3>\s*<p[^>]*>Observe/);
  assert.doesNotMatch(supPage.text, /\*\*/, 'no raw ** markers are shown to readers');
  assert.doesNotMatch(supPage.text, /<ol style="padding-left:20px;line-height:2">/, 'no flat numbered list any more');
  for (const who of [agent, expert]) {
    assert.equal((await get(who, `/standards/${resp.id}`)).status, 404);
    assert.equal((await get(who, `/standards/${flow.id}`)).status, 404);
    assert.doesNotMatch((await get(who, '/standards')).text, /Supervisor Responsibilities|Daily Team Management/);
  }
});

test('an Admin can edit it through the normal form: a new version is created, the old one archived, nothing truncated', async () => {
  const resp = await itemOf('Supervisor Responsibilities');
  const edit = await get(admin, `/admin/standards/${resp.id}/edit`);
  assert.equal(edit.status, 200);
  assert.match(edit.text, /verify before advising/i);
  // Re-post exactly what the form would submit, with one sentence changed.
  const texts = resp.currentVersion.responsibilities.map((r) => r.text);
  texts[1] = texts[1] + ' (edited by an Admin)';
  const saved = await post(admin, `/admin/standards/${resp.id}`, { title: resp.title, category: resp.category, rolesAudience: 'ROLES', roles: ['SUPERVISOR'], shortDescription: resp.currentVersion.shortDescription, requiredReading: '1', respText: texts, action: 'publish' });
  assert.equal(saved.status, 302);
  const after = await itemOf('Supervisor Responsibilities');
  assert.equal(after.currentVersion.version, 2);
  assert.equal(after.currentVersion.status, 'PUBLISHED');
  assert.equal(after.currentVersion.responsibilities.length, texts.length, 'no item was dropped or cut');
  assert.equal(after.currentVersion.responsibilities[1].text, texts[1]);
  assert.equal(after.currentVersion.responsibilities[3].text, resp.currentVersion.responsibilities[3].text, 'long items survive the form unchanged');
  const v1 = await prisma.standardsVersion.findFirst({ where: { itemId: resp.id, version: 1 } });
  assert.equal(v1.status, 'ARCHIVED');

  // Re-running the import afterwards would put the original wording back as a NEW version (history kept),
  // never overwrite in place — that is the documented "update" behaviour.
  const refreshed = await importSupervisorStandards({ adminId: admin.id });
  assert.equal(refreshed.results[0].action, 'updated');
  assert.equal((await itemOf('Supervisor Responsibilities')).currentVersion.version, 3);
});

test('the Workflow is editable through the form too (steps, checklists and notes round-trip)', async () => {
  const flow = await itemOf('Supervisor — Daily Team Management & Development Workflow');
  const edit = await get(admin, `/admin/standards/${flow.id}/edit`);
  assert.equal(edit.status, 200);
  assert.match(edit.text, /Review team status/);
  const steps = flow.currentVersion.steps.map((s) => ({ title: s.title, instruction: s.instruction, ...JSON.parse(s.detailJson || '{}') }));
  const body = {
    title: flow.title, category: flow.category, rolesAudience: 'ROLES', roles: ['SUPERVISOR'], shortDescription: flow.currentVersion.shortDescription, action: 'publish',
    stepTitle: steps.map((s) => s.title), stepInstruction: steps.map((s) => s.instruction), stepExplanation: steps.map((s) => s.explanation || ''),
    stepChecklist: steps.map((s) => (s.checklist || []).join('\n')), stepImportantNote: steps.map((s) => s.importantNote || ''), stepWarning: steps.map((s) => s.warning || ''),
    stepDisclosureRefId: steps.map(() => ''), stepRelatedItemId: steps.map(() => ''),
  };
  assert.equal((await post(admin, `/admin/standards/${flow.id}`, body)).status, 302);
  const after = await itemOf('Supervisor — Daily Team Management & Development Workflow');
  assert.equal(after.currentVersion.version, 2);
  assert.equal(after.currentVersion.steps.length, 19);
  assert.deepEqual(JSON.parse(after.currentVersion.steps[0].detailJson).checklist, steps[0].checklist);
  assert.equal(JSON.parse(after.currentVersion.steps[17].detailJson).importantNote, steps[17].importantNote);
});
