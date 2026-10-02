'use strict';
// Company Standards & Workflow reading experience: clearer landing / document cards, reading state and
// progress taken from the EXISTING acknowledgement records, a table of contents generated from the
// existing headings, the principle / workflow strips, and the stale-version notice - all presentation:
// role filtering, acknowledgement rules, versioning and publishing are untouched.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { extractSequence, splitHeading, buildReaderModel } = require('../lib/standardsReader');
const app = require('../server');

let org, admin, agent, supervisor, cookies = {}, requiredStd, agentResp, supResp, flow;
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);

async function user(role, name) {
  const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: name, username: `rd_${org.id}_${name}`, email: `rd_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
  const token = generateToken();
  await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
  cookies[p.id] = `sz_session=${token.raw}`;
  return p;
}
async function publish(data, version = {}) {
  const item = await prisma.standardsItem.create({ data: { organizationId: org.id, createdById: admin.id, ...data } });
  const v = await prisma.standardsVersion.create({ data: { itemId: item.id, version: 1, status: 'PUBLISHED', createdById: admin.id, publishedAt: new Date(), ...version } });
  await prisma.standardsItem.update({ where: { id: item.id }, data: { currentVersionId: v.id } });
  return { item, v };
}

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Standards reader tests' } });
  admin = await user('ADMIN', 'admin');
  agent = await user('TRAVEL_AGENT', 'agent');
  supervisor = await user('SUPERVISOR', 'supervisor');
  const blocks = [{ type: 'paragraph', text: 'Intro paragraph.' }];
  for (let i = 1; i <= 6; i += 1) blocks.push({ type: 'heading', text: `${i}. Section ${i}` }, { type: 'paragraph', text: `Body ${i}.` }, ...(i === 2 ? [{ type: 'callout_important', text: 'Keep this in mind.' }, { type: 'bullets', items: ['one', 'two'] }] : []));
  requiredStd = (await publish({ contentType: 'STANDARD', title: 'Required standard' }, { shortDescription: 'Must read.', requiredReading: true, important: true, acknowledgementRequired: true, contentJson: JSON.stringify(blocks) })).item;
  await publish({ contentType: 'STANDARD', title: 'Optional standard' }, { shortDescription: 'Nice to read.', contentJson: JSON.stringify([{ type: 'paragraph', text: 'Short.' }]) });
  const resp = (await publish({ contentType: 'RESPONSIBILITY', title: 'Agent duties', rolesJson: JSON.stringify(['TRAVEL_AGENT']) }, { shortDescription: 'Agent duties.', requiredReading: true }));
  agentResp = resp.item;
  const texts = ['**Core principle.** Listen → Understand → Analyze → Advise → Follow Up → Support → Retain.', ...[1, 2, 3, 4, 5].map((n) => `**${n}. Duty ${n}.** Do thing ${n}.`)];
  await prisma.standardsResponsibilityItem.createMany({ data: texts.map((text, i) => ({ versionId: resp.v.id, displayOrder: i, text })) });
  supResp = (await publish({ contentType: 'RESPONSIBILITY', title: 'Supervisor duties', rolesJson: JSON.stringify(['SUPERVISOR']) }, { shortDescription: 'Sup duties.' })).item;
  const wf = await publish({ contentType: 'WORKFLOW', title: 'Agent workflow', rolesJson: JSON.stringify(['TRAVEL_AGENT']) }, { shortDescription: 'How to work.' });
  flow = wf.item;
  const steps = ['Review', 'Contact', 'Discover', 'Search', 'Present'].map((t, i) => ({ versionId: wf.v.id, displayOrder: i, title: t, instruction: `Do ${t}.`, detailJson: i === 1 ? JSON.stringify({ importantNote: 'Be kind.' }) : null }));
  steps.push({ versionId: wf.v.id, displayOrder: 5, title: 'Core flow', instruction: 'Receive → Contact → Discover → Search → Present → Follow Up → Close', detailJson: null });
  await prisma.standardsStep.createMany({ data: steps });
});
after(async () => { await prisma.$disconnect(); });

test('principle and flow sequences are found in the real documents\' wording', () => {
  assert.deepEqual(extractSequence('The Travel Agent is a Travel Consultant: Listen → Understand → Analyze → Advise → Follow Up → Support → Retain.').steps, ['Listen', 'Understand', 'Analyze', 'Advise', 'Follow Up', 'Support', 'Retain']);
  assert.equal(extractSequence('The Travel Agent is a Travel Consultant: **Listen → Understand → Analyze.**').before, 'The Travel Agent is a Travel Consultant:');
  assert.deepEqual(extractSequence('Learn → Practice → Search → Analyze → Verify → Improve → Share.').steps.length, 7);
  assert.equal(extractSequence('Management leads through: **Observe → Support → Develop → Verify → Improve.**').steps[0], 'Observe');
  assert.equal(extractSequence('Only A → B here'), null, 'fewer than three parts is not a sequence');
  assert.equal(extractSequence('No arrows at all.'), null);
  assert.deepEqual(splitHeading('**1. Team leadership.** Manage the team.'), { head: '1. Team leadership', body: 'Manage the team.' });
  assert.deepEqual(splitHeading('Plain text'), { head: '', body: 'Plain text' });
});

test('the table of contents is generated from the existing headings and only shown for longer documents', () => {
  const long = buildReaderModel({ item: { contentType: 'STANDARD' }, version: {}, blocks: [1, 2, 3, 4, 5].map((n) => ({ type: 'heading', text: `H${n}` })) });
  assert.deepEqual(long.toc.map((t) => t.label), ['H1', 'H2', 'H3', 'H4', 'H5']);
  const short = buildReaderModel({ item: { contentType: 'STANDARD' }, version: {}, blocks: [{ type: 'heading', text: 'Only' }, { type: 'paragraph', text: 'x' }] });
  assert.deepEqual(short.toc, []);
});

test('landing: each area is explained, and required reading shows real progress from the acknowledgement records', async () => {
  const page = await get(agent, '/standards');
  assert.equal(page.status, 200);
  assert.match(page.text, /Company-wide expectations and professional standards that apply to your work\./);
  assert.match(page.text, /What your role is responsible for and what is expected from you\./);
  assert.match(page.text, /Step-by-step guidance for completing important work processes correctly\./);
  assert.match(page.text, /Required reading: 0 of 1 acknowledged/);
  assert.match(page.text, /Continue: Required standard/);
  assert.match(page.text, /1 to acknowledge/);
  assert.equal(await prisma.standardsAcknowledgement.count({ where: { item: { organizationId: org.id } } }), 0, 'viewing never records anything');
});

test('document list: clean cards with type, required reading, reading state and the primary action; only role-relevant documents', async () => {
  const std = (await get(agent, '/standards/browse/standard')).text;
  assert.match(std, /class="doc-card"/);
  assert.match(std, /Required reading/);
  assert.match(std, /Acknowledgement needed/);
  assert.match(std, /Must read\./);
  assert.match(std, />Read &rarr;|Read →/);
  assert.match(std, /Optional standard/);

  const resp = (await get(agent, '/standards/browse/responsibility')).text;
  assert.match(resp, /Agent duties/);
  assert.doesNotMatch(resp, /Supervisor duties/, 'role filtering is unchanged');
  assert.equal((await get(agent, `/standards/${supResp.id}`)).status, 404, 'and so is direct access');
  const supList = (await get(supervisor, '/standards/browse/workflow')).text;
  assert.doesNotMatch(supList, /Agent workflow/);
  assert.match(supList, /No workflows have been assigned to your role yet\./, 'friendly empty state');
});

test('reader: contents, headings, an important note, state badges and the acknowledgement action', async () => {
  const page = await get(agent, `/standards/${requiredStd.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /On this page/);
  assert.match(page.text, /<a href="#sec-1">1\. Section 1<\/a>/);
  assert.match(page.text, /<h3 id="sec-3">3\. Section 3<\/h3>/);
  assert.match(page.text, /class="callout-important">Keep this in mind\./);
  assert.match(page.text, /Required reading/);
  assert.match(page.text, /Featured/);
  assert.match(page.text, /Acknowledgement needed/);
  assert.match(page.text, /Confirm &amp; Accept/);

  const ack = await post(agent, `/standards/${requiredStd.id}/acknowledge`, {});
  assert.equal(ack.status, 302);
  const after = await get(agent, `/standards/${requiredStd.id}`);
  assert.match(after.text, /✓ Acknowledged/);
  assert.doesNotMatch(after.text, /Confirm &amp; Accept/);
  assert.match((await get(agent, '/standards')).text, /You have acknowledged all required reading/);
  assert.match((await get(agent, '/standards/browse/standard')).text, /✓ Acknowledged/);
  assert.equal(await prisma.standardsAcknowledgement.count({ where: { item: { organizationId: org.id }, profileId: supervisor.id } }), 0, 'nobody else was acknowledged');
});

test('responsibilities show the principle strip and a contents list; workflows show the flow at a glance and numbered steps', async () => {
  const resp = (await get(agent, `/standards/${agentResp.id}`)).text;
  assert.match(resp, /class="principle-strip"/);
  assert.match(resp, /<li>Listen<\/li><li>Understand<\/li>/);
  assert.match(resp, /<h3 id="sec-2">1\. Duty 1<\/h3>/);
  assert.match(resp, /On this page/);

  const wf = (await get(agent, `/standards/${flow.id}`)).text;
  assert.match(wf, /The workflow at a glance/);
  assert.match(wf, /<li>Receive<\/li><li>Contact<\/li>/);
  assert.match(wf, /<div class="workflow-step-num">01<\/div>/);
  assert.match(wf, /<div class="workflow-step-num">06<\/div>/);
  assert.match(wf, /class="callout-important">Be kind\./);
});

test('a newer version that needs re-acknowledgement is explained plainly', async () => {
  const v2 = await prisma.standardsVersion.create({ data: { itemId: requiredStd.id, version: 2, status: 'PUBLISHED', createdById: admin.id, publishedAt: new Date(), shortDescription: 'Must read.', requiredReading: true, important: true, acknowledgementRequired: true, requireReacknowledgement: true, contentJson: JSON.stringify([{ type: 'paragraph', text: 'Changed.' }]) } });
  await prisma.standardsItem.update({ where: { id: requiredStd.id }, data: { currentVersionId: v2.id } });
  const page = await get(agent, `/standards/${requiredStd.id}`);
  assert.match(page.text, /Updated version — please review/);
  assert.match(page.text, /An updated version is available\. Please review it, then acknowledge again\./);
  assert.match(page.text, /Confirm &amp; Accept/);
  assert.match((await get(agent, '/standards/browse/standard')).text, /Updated version — please review/);
  assert.match((await get(agent, '/standards')).text, /Required reading: 0 of 1 acknowledged/);
});

test('the Admin preview uses the same reading layout, and Admin tools are unchanged', async () => {
  const preview = await get(admin, `/admin/standards/${agentResp.id}/preview`);
  assert.equal(preview.status, 200);
  assert.match(preview.text, /Preview — this is how/);
  assert.match(preview.text, /class="principle-strip"/);
  assert.match(preview.text, /On this page/);
  assert.equal((await get(admin, `/admin/standards/${agentResp.id}/edit`)).status, 200);
  assert.equal((await get(admin, '/admin/standards')).status, 200);
  assert.equal((await get(agent, `/admin/standards/${agentResp.id}/preview`)).status, 403);
});
