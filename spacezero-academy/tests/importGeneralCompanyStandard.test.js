'use strict';
// The SpaceZero General Company & Workplace Standard is imported as ordinary Standards content with
// structured Heading + Paragraph blocks: for everyone, required reading, featured, not a quick
// reference. If a Standard with that title already exists it is updated in place (never duplicated)
// and its acknowledgement setting and existing acknowledgements are left intact. It stays editable
// through the Admin form, and nothing else is changed.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { importDocuments } = require('../scripts/import-supervisor-standards.cjs');
const { DOCUMENTS } = require('../scripts/import-general-company-standard.cjs');
const { ackSummaryForProfile } = require('../lib/standards');
const { parseBlocks } = require('../lib/richContent');
const app = require('../server');

let org, admin, supervisor, agent, expert, cookies = {};
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);
const run = (options = {}) => importDocuments(DOCUMENTS, { adminId: admin.id, ...options });
const TITLE = 'SpaceZero General Company & Workplace Standard';
const items = () => prisma.standardsItem.findMany({ where: { organizationId: org.id, title: TITLE }, include: { currentVersion: true, versions: true } });

async function user(role, name) {
  const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: name, username: `gc_${org.id}_${name}`, email: `gc_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
  const token = generateToken();
  await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
  cookies[p.id] = `sz_session=${token.raw}`;
  return p;
}

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Import general standard tests' } });
  admin = await user('ADMIN', 'admin');
  supervisor = await user('SUPERVISOR', 'supervisor');
  agent = await user('TRAVEL_AGENT', 'agent');
  expert = await user('FLIGHT_EXPERT', 'expert');
});
after(async () => { await prisma.$disconnect(); });

test('an EXISTING Standard with this title is updated in place: no duplicate, acknowledgement setting and acknowledgements kept', async () => {
  // Simulate the one already on production: published, for everyone, acknowledgement required, already acknowledged by the agent.
  const existing = await prisma.standardsItem.create({ data: { organizationId: org.id, contentType: 'STANDARD', title: TITLE, category: 'Old', createdById: admin.id, quickReference: true } });
  const v1 = await prisma.standardsVersion.create({ data: { itemId: existing.id, version: 1, status: 'PUBLISHED', createdById: admin.id, publishedAt: new Date(), shortDescription: 'old text', acknowledgementRequired: true, contentJson: JSON.stringify([{ type: 'paragraph', text: 'Old wording.' }]) } });
  await prisma.standardsItem.update({ where: { id: existing.id }, data: { currentVersionId: v1.id } });
  await prisma.standardsAcknowledgement.create({ data: { itemId: existing.id, versionId: v1.id, profileId: agent.id } });
  const other = await prisma.standardsItem.create({ data: { organizationId: org.id, contentType: 'STANDARD', title: 'Unrelated standard', createdById: admin.id } });

  assert.deepEqual((await run({ dry: true })).results.map((r) => r.action), ['would-update']);
  assert.deepEqual((await run()).results.map((r) => r.action), ['updated']);

  const rows = await items();
  assert.equal(rows.length, 1, 'no second copy');
  const [item] = rows;
  assert.equal(item.id, existing.id, 'the same record');
  assert.equal(item.currentVersion.version, 2);
  assert.equal(item.currentVersion.status, 'PUBLISHED');
  assert.equal((await prisma.standardsVersion.findUnique({ where: { id: v1.id } })).status, 'ARCHIVED', 'history kept');
  assert.equal(item.currentVersion.acknowledgementRequired, true, 'the acknowledgement setting is kept');
  assert.equal(item.currentVersion.requireReacknowledgement, false);
  assert.equal((await ackSummaryForProfile(org.id, agent)).pending, 0, 'an existing acknowledgement still counts');
  assert.equal(await prisma.standardsAcknowledgement.count({ where: { itemId: existing.id } }), 1, 'nobody is acknowledged automatically');
  assert.equal((await ackSummaryForProfile(org.id, supervisor)).pending, 1, 'and nobody else is marked acknowledged');
  assert.equal(item.quickReference, false);
  assert.equal(await prisma.standardsItem.count({ where: { id: other.id } }), 1, 'unrelated content untouched');
});

test('the Standard has the required details and structure: 1 intro paragraph + 11 headings + 11 paragraphs', async () => {
  const [item] = await items();
  const v = item.currentVersion;
  assert.equal(item.category, 'General Company Standard');
  assert.equal(item.rolesJson, null, 'audience: Everyone');
  assert.equal(item.quickReference, false);
  assert.equal(v.shortDescription, 'Defines the general professional, workplace, confidentiality, service and conduct expectations for everyone working at SpaceZero.');
  assert.equal(v.requiredReading, true);
  assert.equal(v.important, true, 'featured');

  const blocks = parseBlocks(v.contentJson);
  assert.equal(blocks.length, 23);
  assert.equal(blocks[0].type, 'paragraph');
  assert.match(blocks[0].text, /^This standard defines the general professional/);
  const headings = blocks.filter((b) => b.type === 'heading');
  assert.equal(headings.length, 11);
  assert.equal(blocks.filter((b) => b.type === 'paragraph').length, 12);
  assert.deepEqual(headings.map((h) => h.text), [
    '1. Professional Conduct', '2. Attendance & Working Responsibilities', '3. Client Service & Professional Accuracy', '4. Confidentiality & Information Protection',
    '5. Company Systems, Accounts & Equipment', '6. Workplace Standards', '7. Training & Professional Development', '8. Following Approved Responsibilities & Workflows',
    '9. Reporting & Escalation', '10. Professional Representation of SpaceZero', '11. Acknowledgement',
  ]);
  blocks.forEach((b, i) => { if (i > 0) assert.equal(b.type, i % 2 === 1 ? 'heading' : 'paragraph', 'strictly Heading then Paragraph'); });
  assert.ok(blocks.every((b) => b.text.length < 700), 'no giant single block');
});

test('running it again is a no-op', async () => {
  assert.deepEqual((await run()).results.map((r) => r.action), ['unchanged']);
  const [item] = await items();
  assert.equal(item.versions.length, 2);
  assert.equal((await items()).length, 1);
});

test('everyone can read it; each section shows as a heading with its paragraph', async () => {
  const [item] = await items();
  for (const who of [admin, supervisor, agent, expert]) {
    const page = await get(who, `/standards/${item.id}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /<h3[^>]*>1\. Professional Conduct<\/h3>\s*<p[^>]*>Every employee is expected to act professionally/);
    assert.match(page.text, /<h3[^>]*>11\. Acknowledgement<\/h3>/);
    assert.match(page.text, /Featured/);
  }
  assert.match((await get(agent, '/standards/browse/standard')).text, /SpaceZero General Company &amp; Workplace Standard/);
});

test('an Admin can still edit it through the normal form (new version, history kept)', async () => {
  const [item] = await items();
  const blocks = parseBlocks(item.currentVersion.contentJson);
  blocks[1] = { ...blocks[1], text: '1. Professional Conduct (reviewed)' };
  const saved = await post(admin, `/admin/standards/${item.id}`, {
    title: item.title, category: item.category, rolesAudience: 'ALL', shortDescription: item.currentVersion.shortDescription,
    important: '1', requiredReading: '1', acknowledgementRequired: '1',
    blockType: blocks.map((b) => b.type), blockText: blocks.map((b) => b.text), blockItems: blocks.map(() => ''), action: 'publish',
  });
  assert.equal(saved.status, 302);
  const [after] = await items();
  assert.equal(after.currentVersion.version, 3);
  const edited = parseBlocks(after.currentVersion.contentJson);
  assert.equal(edited.length, 23);
  assert.equal(edited[1].text, '1. Professional Conduct (reviewed)');
  assert.equal((await items()).length, 1);
});
