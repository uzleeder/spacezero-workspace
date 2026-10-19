'use strict';
// Company Standards & Workflow: admin-managed handbook (standards/responsibilities/workflows/
// disclosures) with draft->publish versioning, role targeting and acknowledgement tracking.
// Gemini is never called — this module has no AI component by design (spec defers that).
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');

mock.method(require('../lib/gemini'), 'generateStructured', async () => { throw new Error('Gemini must not be called in these tests'); });

const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { hashPassword } = require('../lib/password');
const app = require('../server');

let org, admin, sup, supB, agent, agentB, flightExpert, cookies = {};
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);
const blocked = (res) => res.status !== 200 && res.status < 500;

async function makeUser(role, name, { organizationId = org.id, status = 'ACTIVE' } = {}) {
  const passwordHash = await hashPassword('Correct-Horse-9!');
  const p = await prisma.profile.create({ data: { organizationId, fullName: `ST ${name}`, username: `st_${organizationId}_${name}`, email: `st_${organizationId}_${name}@example.invalid`, role, status, passwordHash, employmentStartDate: new Date() } });
  const token = generateToken();
  await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
  cookies[p.id] = `sz_session=${token.raw}`;
  return p;
}

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Standards test' } });
  admin = await makeUser('ADMIN', 'admin');
  sup = await makeUser('SUPERVISOR', 'sup'); supB = await makeUser('SUPERVISOR', 'supB');
  agent = await makeUser('TRAVEL_AGENT', 'agent'); agentB = await makeUser('TRAVEL_AGENT', 'agentB');
  flightExpert = await makeUser('FLIGHT_EXPERT', 'fe');
  await prisma.supervisorAssignment.create({ data: { supervisorId: sup.id, agentId: agent.id, assignedById: admin.id } });
  await prisma.supervisorAssignment.create({ data: { supervisorId: supB.id, agentId: agentB.id, assignedById: admin.id } });
});
after(async () => { mock.restoreAll(); await prisma.$disconnect(); });

test('NAV: sidebar exposes Company Standards & Workflow near the bottom for every role', async () => {
  const page = await get(agent, '/dashboard');
  assert.match(page.text, /Company Standards &amp; Workflow|Company Standards & Workflow/);
});

test('ADMIN CREATE FORMS RENDER: the chooser and all 4 type-specific GET forms render without error', async () => {
  const chooser = await get(admin, '/admin/standards/new');
  assert.equal(chooser.status, 200);
  for (const type of ['standard', 'responsibility', 'workflow', 'disclosure']) {
    const form = await get(admin, `/admin/standards/new?type=${type}`);
    assert.equal(form.status, 200, `${type} create form should render`);
    assert.match(form.text, /Title/);
  }
});

test('SUPERVISOR CANNOT MANAGE: creating/editing standards is admin-only, server-side', async () => {
  const createRes = await post(sup, '/admin/standards', { contentType: 'STANDARD', title: 'Sneaky', rolesAudience: 'ALL', action: 'publish' });
  assert.ok(blocked(createRes));
  const listRes = await get(sup, '/admin/standards');
  assert.ok(blocked(listRes));
  const created = await prisma.standardsItem.findFirst({ where: { organizationId: org.id, title: 'Sneaky' } });
  assert.equal(created, null);
});

test('DRAFT INVISIBLE: a draft standard does not appear to employees, even by direct id', async () => {
  const res = await post(admin, '/admin/standards', { contentType: 'STANDARD', title: 'Draft Only Standard', rolesAudience: 'ALL', shortDescription: 'Intro', blockType: ['paragraph'], blockText: ['Hello **team**.'], action: 'draft' });
  assert.equal(res.status, 302);
  const item = await prisma.standardsItem.findFirst({ where: { organizationId: org.id, title: 'Draft Only Standard' } });
  assert.ok(item);
  assert.equal(item.currentVersionId, null);

  const browse = await get(agent, '/standards/browse/standard');
  assert.doesNotMatch(browse.text, /Draft Only Standard/);
  const direct = await get(agent, `/standards/${item.id}`);
  assert.equal(direct.status, 404);
  const adminDirect = await get(admin, `/admin/standards/${item.id}/preview`);
  assert.equal(adminDirect.status, 200);
  assert.match(adminDirect.text, /Draft Only Standard/);
});

test('PUBLISH: publishing makes content visible, rendered with the block content', async () => {
  const create = await post(admin, '/admin/standards', {
    contentType: 'STANDARD', title: 'Client Communication', rolesAudience: 'ALL', shortDescription: 'How we talk to clients.',
    blockType: ['heading', 'paragraph', 'bullets'], blockText: ['Tone', 'Always be **polite** and clear.', ''], blockItems: ['', '', 'Be prompt\nBe accurate'],
    action: 'publish',
  });
  assert.equal(create.status, 302);
  const item = await prisma.standardsItem.findFirst({ where: { organizationId: org.id, title: 'Client Communication' } });
  assert.ok(item.currentVersionId);

  const browse = await get(agent, '/standards/browse/standard');
  assert.match(browse.text, /Client Communication/);
  const show = await get(agent, `/standards/${item.id}`);
  assert.equal(show.status, 200);
  assert.match(show.text, /Always be <strong>polite<\/strong> and clear/);
  assert.match(show.text, /Be prompt/);
});

test('ADMIN EDIT FORM RENDERS for both a draft and a published item', async () => {
  const draftItem = await prisma.standardsItem.findFirst({ where: { organizationId: org.id, title: 'Draft Only Standard' } });
  const editDraft = await get(admin, `/admin/standards/${draftItem.id}/edit`);
  assert.equal(editDraft.status, 200);

  const publishedItem = await prisma.standardsItem.findFirst({ where: { organizationId: org.id, title: 'Client Communication' } });
  const editPublished = await get(admin, `/admin/standards/${publishedItem.id}/edit`);
  assert.equal(editPublished.status, 200);
});

test('ROLE TARGETING: a role-restricted standard is invisible to other roles, server-side', async () => {
  const create = await post(admin, '/admin/standards', { contentType: 'STANDARD', title: 'Flight Expert Only Rule', rolesAudience: 'ROLES', roles: ['FLIGHT_EXPERT'], blockType: ['paragraph'], blockText: ['Only for FEs.'], action: 'publish' });
  assert.equal(create.status, 302);
  const item = await prisma.standardsItem.findFirst({ where: { organizationId: org.id, title: 'Flight Expert Only Rule' } });

  const asFE = await get(flightExpert, `/standards/${item.id}`);
  assert.equal(asFE.status, 200);
  const asAgent = await get(agent, `/standards/${item.id}`);
  assert.equal(asAgent.status, 404);
  const browseAgent = await get(agent, '/standards/browse/standard');
  assert.doesNotMatch(browseAgent.text, /Flight Expert Only Rule/);
});

test('WORKFLOW: numbered steps with optional detail render in reading mode', async () => {
  const create = await post(admin, '/admin/standards', {
    contentType: 'WORKFLOW', title: 'New Lead Workflow', rolesAudience: 'ALL', shortDescription: 'From lead to booking.',
    stepTitle: ['Lead received', 'Contact client'], stepInstruction: ['Log the lead in the CRM.', 'Call within 30 minutes.'],
    stepWarning: ['', 'Never leave a lead untouched overnight.'],
    action: 'publish',
  });
  assert.equal(create.status, 302);
  const item = await prisma.standardsItem.findFirst({ where: { organizationId: org.id, title: 'New Lead Workflow' } });
  const show = await get(agent, `/standards/${item.id}`);
  assert.equal(show.status, 200);
  assert.match(show.text, /Lead received/);
  assert.match(show.text, /Contact client/);
  assert.match(show.text, /Never leave a lead untouched overnight/);
});

test('DISCLOSURE: approved wording is shown verbatim and distinctly', async () => {
  const create = await post(admin, '/admin/standards', {
    contentType: 'DISCLOSURE', title: 'Award Booking Disclosure', rolesAudience: 'ALL',
    disclosureWhenItApplies: 'When booking an award ticket.', disclosureApprovedWording: 'This booking uses points and is subject to airline change fees.',
    action: 'publish',
  });
  assert.equal(create.status, 302);
  const item = await prisma.standardsItem.findFirst({ where: { organizationId: org.id, title: 'Award Booking Disclosure' } });
  const show = await get(agent, `/standards/${item.id}`);
  assert.match(show.text, /This booking uses points and is subject to airline change fees/);
  assert.match(show.text, /Approved wording/);
});

test('ACKNOWLEDGEMENT: employee can acknowledge; exact version and profile are recorded; audited', async () => {
  const create = await post(admin, '/admin/standards', { contentType: 'STANDARD', title: 'Confidentiality Policy', rolesAudience: 'ALL', blockType: ['paragraph'], blockText: ['Keep client data private.'], acknowledgementRequired: '1', action: 'publish' });
  assert.equal(create.status, 302);
  const item = await prisma.standardsItem.findFirst({ where: { organizationId: org.id, title: 'Confidentiality Policy' } });

  const before = await get(agent, `/standards/${item.id}`);
  assert.match(before.text, /Confirm &amp; Accept/);

  const ackRes = await post(agent, `/standards/${item.id}/acknowledge`, {});
  assert.equal(ackRes.status, 302);
  const ack = await prisma.standardsAcknowledgement.findFirst({ where: { itemId: item.id, profileId: agent.id } });
  assert.ok(ack);
  assert.equal(ack.versionId, item.currentVersionId);

  const audit = await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'standards.acknowledged', actorId: agent.id, targetId: item.id } });
  assert.ok(audit);

  const after2 = await get(agent, `/standards/${item.id}`);
  assert.doesNotMatch(after2.text, /Confirm &amp; Accept/);
});

test('CANNOT ACKNOWLEDGE FOR ANOTHER EMPLOYEE: the ack is always recorded against the caller, never a body-supplied id', async () => {
  const item = await prisma.standardsItem.findFirst({ where: { organizationId: org.id, title: 'Confidentiality Policy' } });
  await post(agentB, `/standards/${item.id}/acknowledge`, { profileId: agent.id });
  const ack = await prisma.standardsAcknowledgement.findFirst({ where: { itemId: item.id, profileId: agentB.id } });
  assert.ok(ack, 'acknowledgement recorded for the actual caller');
  assert.equal(ack.profileId, agentB.id);
});

test('VERSIONING: publishing a new version keeps the old one as history; stale ack no longer satisfies the new version', async () => {
  const item = await prisma.standardsItem.findFirst({ where: { organizationId: org.id, title: 'Confidentiality Policy' } });
  const v1Id = item.currentVersionId;

  const edit = await post(admin, `/admin/standards/${item.id}`, { contentType: 'STANDARD', title: 'Confidentiality Policy', rolesAudience: 'ALL', blockType: ['paragraph'], blockText: ['Keep client AND company data private.'], acknowledgementRequired: '1', requireReacknowledgement: '1', action: 'publish' });
  assert.equal(edit.status, 302);

  const versions = await prisma.standardsVersion.findMany({ where: { itemId: item.id }, orderBy: { version: 'asc' } });
  assert.equal(versions.length, 2);
  assert.equal(versions[0].id, v1Id);
  assert.equal(versions[0].status, 'ARCHIVED');
  assert.equal(versions[1].status, 'PUBLISHED');

  const refreshed = await prisma.standardsItem.findUnique({ where: { id: item.id } });
  assert.equal(refreshed.currentVersionId, versions[1].id);

  // agent acknowledged v1 earlier; that must still exist (never rewritten) but not satisfy v2.
  const oldAck = await prisma.standardsAcknowledgement.findFirst({ where: { versionId: v1Id, profileId: agent.id } });
  assert.ok(oldAck, 'the old acknowledgement is preserved as history');
  const show = await get(agent, `/standards/${item.id}`);
  assert.match(show.text, /Confirm &amp; Accept/, 'agent must re-acknowledge the new version');

  // agent re-acknowledges v2, so we have a clean baseline for the carry-forward test below.
  await post(agent, `/standards/${item.id}/acknowledge`, {});
});

test('RE-ACKNOWLEDGEMENT OFF: publishing a new version WITHOUT requireReacknowledgement carries the old acknowledgement forward', async () => {
  const item = await prisma.standardsItem.findFirst({ where: { organizationId: org.id, title: 'Confidentiality Policy' } });
  const v2Id = item.currentVersionId;
  assert.ok(await prisma.standardsAcknowledgement.findFirst({ where: { versionId: v2Id, profileId: agent.id } }), 'agent acknowledged v2');

  const edit = await post(admin, `/admin/standards/${item.id}`, { contentType: 'STANDARD', title: 'Confidentiality Policy', rolesAudience: 'ALL', blockType: ['paragraph'], blockText: ['Keep client AND company data private. Minor wording tweak.'], acknowledgementRequired: '1', action: 'publish' });
  assert.equal(edit.status, 302);
  const refreshed = await prisma.standardsItem.findUnique({ where: { id: item.id } });
  assert.notEqual(refreshed.currentVersionId, v2Id);

  // No new acknowledgement row was created, yet the agent's v2 acknowledgement still satisfies v3.
  const v3Ack = await prisma.standardsAcknowledgement.findFirst({ where: { versionId: refreshed.currentVersionId, profileId: agent.id } });
  assert.equal(v3Ack, null);
  const show = await get(agent, `/standards/${item.id}`);
  assert.doesNotMatch(show.text, /Confirm &amp; Accept/, 'carried-forward acknowledgement means no re-acknowledgement prompt');
  assert.match(show.text, /version 2/);

  const summary = await (require('../lib/standards').ackSummaryForProfile)(org.id, agent);
  assert.equal(summary.pending, 0);
});

test('SUPERVISOR TEAM-STATUS: a supervisor sees only their own agents, never another supervisor\'s', async () => {
  const page = await get(sup, '/standards/team-status');
  assert.equal(page.status, 200);
  assert.match(page.text, /ST agent</);
  assert.doesNotMatch(page.text, /ST agentB</);
});

test('EMPLOYEE CANNOT SEE TEAM-STATUS', async () => {
  const res = await get(agent, '/standards/team-status');
  assert.ok(blocked(res));
});

test('ADMIN ACKNOWLEDGEMENT VISIBILITY: shows who has and has not acknowledged', async () => {
  const item = await prisma.standardsItem.findFirst({ where: { organizationId: org.id, title: 'Confidentiality Policy' } });
  const page = await get(admin, `/admin/standards/${item.id}/acknowledgements`);
  assert.equal(page.status, 200);
  assert.match(page.text, /ST agent</);
  assert.match(page.text, /Not acknowledged/);
});

test('SEARCH: only returns published, role-applicable content', async () => {
  const draft = await prisma.standardsItem.findFirst({ where: { organizationId: org.id, title: 'Draft Only Standard' } });
  const results = await get(agent, '/standards/search?q=Client');
  assert.equal(results.status, 200);
  assert.match(results.text, /Client Communication/);
  assert.doesNotMatch(results.text, new RegExp(draft.title));

  const feOnly = await get(agent, '/standards/search?q=Flight+Expert+Only');
  assert.doesNotMatch(feOnly.text, /Flight Expert Only Rule/);
});

test('QUICK REFERENCE: toggling marks an item visible on the landing page strip', async () => {
  const item = await prisma.standardsItem.findFirst({ where: { organizationId: org.id, title: 'Client Communication' } });
  await post(admin, `/admin/standards/${item.id}/quick-reference`, {});
  const landing = await get(agent, '/standards');
  assert.match(landing.text, /Client Communication/);
});

test('ARCHIVE: an archived item disappears from employee view but can be restored', async () => {
  const item = await prisma.standardsItem.findFirst({ where: { organizationId: org.id, title: 'New Lead Workflow' } });
  await post(admin, `/admin/standards/${item.id}/archive`, {});
  const gone = await get(agent, `/standards/${item.id}`);
  assert.equal(gone.status, 404);
  await post(admin, `/admin/standards/${item.id}/restore`, {});
  const back = await get(agent, `/standards/${item.id}`);
  assert.equal(back.status, 200);
});

test('AUDIT: item creation and publish are logged distinctly, not one vague entry', async () => {
  const item = await prisma.standardsItem.findFirst({ where: { organizationId: org.id, title: 'Client Communication' } });
  const created = await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'standards.item_created', targetId: item.id } });
  const published = await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'standards.published', targetId: item.id } });
  assert.ok(created);
  assert.ok(published);
});
