'use strict';
// Every ready-made Company Standards & Workflow document can be added from Settings -> Standards, where
// it becomes its own ordinary, editable item. Adding never overwrites an existing document unless the
// Admin presses Replace for that one document, never duplicates, and never acknowledges anything.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { READY } = require('../lib/readyStandards');
const app = require('../server');

let org, admin, supervisor, agent, cookies = {};
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);
const items = () => prisma.standardsItem.findMany({ where: { organizationId: org.id }, include: { currentVersion: true, versions: true } });

async function user(role, name) {
  const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: name, username: `rs_${org.id}_${name}`, email: `rs_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
  const token = generateToken();
  await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
  cookies[p.id] = `sz_session=${token.raw}`;
  return p;
}

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Ready-made documents tests' } });
  admin = await user('ADMIN', 'admin');
  supervisor = await user('SUPERVISOR', 'supervisor');
  agent = await user('TRAVEL_AGENT', 'agent');
  // The General Standard already exists (as on production) but with different wording and an acknowledgement setting.
  const general = READY.find((r) => r.key === 'general-company-standard').doc;
  const item = await prisma.standardsItem.create({ data: { organizationId: org.id, contentType: 'STANDARD', title: general.title, createdById: admin.id } });
  const v = await prisma.standardsVersion.create({ data: { itemId: item.id, version: 1, status: 'PUBLISHED', createdById: admin.id, publishedAt: new Date(), acknowledgementRequired: true, contentJson: JSON.stringify([{ type: 'paragraph', text: 'My own wording.' }]) } });
  await prisma.standardsItem.update({ where: { id: item.id }, data: { currentVersionId: v.id } });
});
after(async () => { await prisma.$disconnect(); });

test('the manage page lists all nine ready-made documents with their state', async () => {
  assert.equal(READY.length, 9);
  const page = await get(admin, '/admin/standards');
  assert.equal(page.status, 200);
  assert.match(page.text, /Ready-made documents/);
  for (const { doc } of READY) assert.ok(page.text.includes(doc.title.replace(/&/g, '&amp;')), doc.title);
  assert.match(page.text, /Add all 8 missing documents/);
  assert.match(page.text, /Added — edited/, 'the existing General Standard shows as already there but different');
});

test('Add all adds only the missing ones: each becomes its own item, and the existing document is left exactly as it was', async () => {
  const before = (await items()).find((i) => i.title.startsWith('SpaceZero General'));
  const res = await post(admin, '/admin/standards/ready');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /added=8&replaced=0&kept=1/);
  const all = await items();
  assert.equal(all.length, 9);
  for (const { doc } of READY) assert.equal(all.filter((i) => i.title === doc.title).length, 1, `${doc.title} exists once`);
  const general = all.find((i) => i.title.startsWith('SpaceZero General'));
  assert.equal(general.versions.length, 1, 'not touched');
  assert.equal(general.currentVersion.contentJson, before.currentVersion.contentJson);
  assert.equal(general.currentVersion.acknowledgementRequired, true);
  assert.equal(await prisma.standardsAcknowledgement.count({ where: { item: { organizationId: org.id } } }), 0);

  // Each one appears separately in the admin list with its own edit link, and opens in the editor.
  const list = await get(admin, '/admin/standards?filter=all');
  for (const item of all) assert.ok(list.text.includes(`/admin/standards/${item.id}/edit`));
  for (const item of all) assert.equal((await get(admin, `/admin/standards/${item.id}/edit`)).status, 200);
});

test('running Add all again changes nothing', async () => {
  const res = await post(admin, '/admin/standards/ready');
  assert.match(res.headers.location, /added=0&replaced=0/);
  assert.equal((await items()).length, 9);
  const page = await get(admin, '/admin/standards');
  assert.doesNotMatch(page.text, /Add all \d+ missing/);
});

test('Replace is per document and explicit; the earlier version is kept in the history', async () => {
  const general = READY.find((r) => r.key === 'general-company-standard');
  const keep = await post(admin, '/admin/standards/ready', { key: general.key });
  assert.match(keep.headers.location, /added=0&replaced=0&kept=1/, 'without Replace an edited document is never overwritten');
  const replaced = await post(admin, '/admin/standards/ready', { key: general.key, replace: '1' });
  assert.match(replaced.headers.location, /replaced=1/);
  const item = (await items()).find((i) => i.title === general.doc.title);
  assert.equal(item.versions.length, 2);
  assert.equal(item.currentVersion.version, 2);
  assert.equal(item.versions.find((v) => v.version === 1).status, 'ARCHIVED');
  assert.equal(item.currentVersion.acknowledgementRequired, true, 'its acknowledgement setting is kept');
  assert.equal((await post(admin, '/admin/standards/ready', { key: 'no-such-document' })).status, 404);
});

test('only an Admin can add them', async () => {
  for (const who of [supervisor, agent]) {
    const res = await post(who, '/admin/standards/ready');
    assert.ok([302, 403, 404].includes(res.status));
    assert.doesNotMatch(res.headers.location || '', /admin\/standards\?saved/);
  }
});
