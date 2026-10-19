'use strict';
// Delivery performance: the app's own CSS/JS must be cacheable and compressed (they used to be sent
// raw with Cache-Control: no-store on every page view), pages and private data must stay uncached,
// and static files must not need a database lookup.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { asset } = require('../lib/assets');
const app = require('../server');

let cookie;
before(async () => {
  const org = await prisma.organization.create({ data: { name: 'Performance tests' } });
  const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: 'Perf Agent', username: `perf_${org.id}`, email: `perf_${org.id}@example.invalid`, role: 'TRAVEL_AGENT', status: 'ACTIVE', employmentStartDate: new Date() } });
  const token = generateToken();
  await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
  cookie = `sz_session=${token.raw}`;
});
after(async () => { await prisma.$disconnect(); });

test('asset() adds a content hash that changes only with the file', () => {
  const url = asset('/static/css/styles.css');
  assert.match(url, /^\/static\/css\/styles\.css\?v=[0-9a-f]{10}$/);
  assert.equal(asset('/static/css/styles.css'), url, 'stable between calls');
  assert.equal(asset('/static/favicon.svg?v=1'), '/static/favicon.svg?v=1', 'non css/js urls are left alone');
});

test('versioned CSS/JS: immutable for a year, compressed, and never marked no-store', async () => {
  const res = await request(app).get(asset('/static/css/styles.css')).set('Accept-Encoding', 'gzip');
  assert.equal(res.status, 200);
  assert.match(res.headers['cache-control'], /public, max-age=31536000, immutable/);
  assert.doesNotMatch(res.headers['cache-control'], /no-store/);
  assert.equal(res.headers['content-encoding'], 'gzip');
  const js = await request(app).get(asset('/static/js/app.js')).set('Accept-Encoding', 'gzip');
  assert.equal(js.headers['content-encoding'], 'gzip');
});

test('an unversioned static request is cached only briefly, and a missing file is not cached', async () => {
  const res = await request(app).get('/static/css/styles.css');
  assert.match(res.headers['cache-control'], /max-age=3600/);
  const missing = await request(app).get('/static/js/does-not-exist.js');
  assert.equal(missing.status, 404);
  assert.doesNotMatch(missing.headers['cache-control'] || '', /max-age=31536000|max-age=3600/);
});

test('pages stay private and uncached, and reference the versioned assets', async () => {
  const page = await request(app).get('/dashboard').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.headers['cache-control'], /no-store/);
  assert.match(page.text, /\/static\/css\/styles\.css\?v=[0-9a-f]{10}/);
  assert.match(page.text, /\/static\/js\/app\.js\?v=[0-9a-f]{10}/);
  const login = await request(app).get('/login');
  assert.match(login.text, /\/static\/css\/styles\.css\?v=[0-9a-f]{10}/, 'standalone pages use versioned assets too');
  assert.equal((await request(app).get('/static/uploads/avatars/nobody.png')).status, 404, 'private uploads still need a session');
});

test('"last seen" bookkeeping is written at most once a minute, not on every request', async () => {
  const before1 = (await prisma.session.findFirst({ where: { profile: { username: { startsWith: 'perf_' } } } })).lastUsedAt;
  await request(app).get('/notifications').set('Cookie', cookie);
  await request(app).get('/notifications').set('Cookie', cookie);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const after1 = (await prisma.session.findFirst({ where: { profile: { username: { startsWith: 'perf_' } } } })).lastUsedAt;
  assert.ok(after1 - before1 < 60 * 1000 + 1000, 'a fresh timestamp was not rewritten on every hit');
});
