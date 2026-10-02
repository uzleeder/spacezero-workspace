'use strict';
// The Library star: a tap must persist, report the saved state back to the page, show up under
// "My Library", and never reach another organization's or an archived item.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { hashPassword } = require('../lib/password');
const app = require('../server');

let org, otherOrg, agent, cookie, item, hiddenItem, archivedItem, foreignItem;
const post = (url, body = {}) => request(app).post(url).set('Cookie', cookie).type('form').send(body);
const get = (url) => request(app).get(url).set('Cookie', cookie);

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Favorites tests' } });
  otherOrg = await prisma.organization.create({ data: { name: 'Favorites other org' } });
  agent = await prisma.profile.create({ data: { organizationId: org.id, fullName: 'Fav Agent', username: `fav_${org.id}`, email: `fav_${org.id}@example.invalid`, role: 'TRAVEL_AGENT', status: 'ACTIVE', passwordHash: await hashPassword('Correct-Horse-9!'), employmentStartDate: new Date() } });
  const token = generateToken();
  await prisma.session.create({ data: { profileId: agent.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
  cookie = `sz_session=${token.raw}`;
  const base = { itemType: 'NOTE', createdById: agent.id };
  item = await prisma.libraryItem.create({ data: { ...base, organizationId: org.id, title: 'Fav visible item' } });
  hiddenItem = await prisma.libraryItem.create({ data: { ...base, organizationId: org.id, title: 'Admins only item', visibleRolesJson: JSON.stringify(['ADMIN']) } });
  archivedItem = await prisma.libraryItem.create({ data: { ...base, organizationId: org.id, title: 'Archived item', archivedAt: new Date() } });
  foreignItem = await prisma.libraryItem.create({ data: { ...base, organizationId: otherOrg.id, title: 'Other org item' } });
});
after(async () => { await prisma.$disconnect(); });

test('a star tap saves, reports the state, and the item appears under My Library', async () => {
  const saved = await post(`/library/${item.id}/favorite`, { favorite: '1' });
  assert.equal(saved.status, 200);
  assert.deepEqual({ ok: saved.body.ok, favorite: saved.body.favorite }, { ok: true, favorite: true });
  assert.match((await get('/library/mine')).text, /Fav visible item/);
  assert.match((await get('/library')).text, /is-active/, 'the list page renders the saved star as active');
});

test('asking for the same state twice never flips it back (double tap / retry safe)', async () => {
  await post(`/library/${item.id}/favorite`, { favorite: '1' });
  const again = await post(`/library/${item.id}/favorite`, { favorite: '1' });
  assert.equal(again.body.favorite, true);
  assert.equal(await prisma.libraryFavorite.count({ where: { profileId: agent.id, libraryItemId: item.id } }), 1);
  const off = await post(`/library/${item.id}/favorite`, { favorite: '0' });
  assert.equal(off.body.favorite, false);
  assert.equal((await post(`/library/${item.id}/favorite`, { favorite: '0' })).body.favorite, false);
  assert.doesNotMatch((await get('/library/mine')).text, /Fav visible item/);
});

test('without an explicit state the call still toggles', async () => {
  assert.equal((await post(`/library/${item.id}/favorite`)).body.favorite, true);
  assert.equal((await post(`/library/${item.id}/favorite`)).body.favorite, false);
});

test('items the viewer may not see, archived items and other organizations are refused', async () => {
  for (const blocked of [hiddenItem, archivedItem, foreignItem]) {
    const res = await post(`/library/${blocked.id}/favorite`, { favorite: '1' });
    assert.equal(res.status, 404, blocked.title);
    assert.equal(await prisma.libraryFavorite.count({ where: { profileId: agent.id, libraryItemId: blocked.id } }), 0);
  }
});
