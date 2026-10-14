'use strict';
// Library videos must be served with HTTP Range support (206 Partial Content + Content-Length): without
// it browsers cannot seek in a video and some (Safari, iOS, Firefox) will not start it at all.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { saveUpload } = require('../lib/storage');
const app = require('../server');

const SIZE = 200000;
let org, admin, agent, item, cookies = {}, bytes;
const binary = (res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); };
const get = (p, url, headers = {}) => request(app).get(url).set('Cookie', cookies[p.id]).set(headers).buffer(true).parse(binary);

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Video range tests' } });
  async function user(role, name) {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `VR ${name}`, username: `vr_${org.id}_${name}`, email: `vr_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
    const t = generateToken();
    await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } });
    cookies[p.id] = `sz_session=${t.raw}`;
    return p;
  }
  admin = await user('ADMIN', 'admin');
  agent = await user('TRAVEL_AGENT', 'agent');
  bytes = Buffer.alloc(SIZE, 7);
  bytes.write('ftypisom', 4, 'ascii');
  const saved = await saveUpload({ buffer: bytes, mimetype: 'video/mp4' }, `library/${org.id}`);
  item = await prisma.libraryItem.create({ data: { organizationId: org.id, createdById: admin.id, title: 'Range test video', itemType: 'VIDEO', storagePath: saved.storagePath, mimeType: 'video/mp4' } });
});
after(async () => { await prisma.$disconnect(); });

test('the whole file is served inline with its length and Accept-Ranges', async () => {
  const res = await get(agent, `/library-file/${item.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'video/mp4');
  assert.equal(res.headers['accept-ranges'], 'bytes');
  assert.equal(Number(res.headers['content-length']), SIZE);
  assert.equal(res.headers['content-disposition'], 'inline');
  assert.match(res.headers['cache-control'], /no-store/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.body.length, SIZE);
});

test('a Range request gets 206 with exactly the bytes asked for (start, middle, open-ended, last bytes)', async () => {
  let res = await get(agent, `/library-file/${item.id}`, { Range: 'bytes=0-99' });
  assert.equal(res.status, 206);
  assert.equal(res.headers['content-range'], `bytes 0-99/${SIZE}`);
  assert.equal(res.body.length, 100);
  assert.deepEqual(res.body, bytes.subarray(0, 100));
  res = await get(agent, `/library-file/${item.id}`, { Range: 'bytes=150000-150999' });
  assert.equal(res.status, 206);
  assert.deepEqual(res.body, bytes.subarray(150000, 151000));
  res = await get(agent, `/library-file/${item.id}`, { Range: 'bytes=199000-' });
  assert.equal(res.headers['content-range'], `bytes 199000-${SIZE - 1}/${SIZE}`);
  assert.equal(res.body.length, 1000);
  res = await get(agent, `/library-file/${item.id}`, { Range: 'bytes=-500' });
  assert.equal(res.status, 206);
  assert.equal(res.body.length, 500);
  res = await get(agent, `/library-file/${item.id}`, { Range: `bytes=${SIZE + 10}-${SIZE + 20}` });
  assert.equal(res.status, 416);
});

test('the access rules are unchanged: download is Admin-only, other organizations and signed-out users get nothing', async () => {
  assert.equal((await get(agent, `/library-file/${item.id}?download=1`)).status, 403);
  const admin200 = await get(admin, `/library-file/${item.id}?download=1`);
  assert.equal(admin200.status, 200);
  assert.match(admin200.headers['content-disposition'], /attachment/);
  const stranger = await prisma.organization.create({ data: { name: 'Other org' } });
  const outsider = await prisma.profile.create({ data: { organizationId: stranger.id, fullName: 'Outsider', username: `vrx_${stranger.id}`, email: `vrx_${stranger.id}@example.invalid`, role: 'TRAVEL_AGENT', status: 'ACTIVE', employmentStartDate: new Date() } });
  const t = generateToken();
  await prisma.session.create({ data: { profileId: outsider.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } });
  assert.equal((await request(app).get(`/library-file/${item.id}`).set('Cookie', `sz_session=${t.raw}`)).status, 404);
  assert.notEqual((await request(app).get(`/library-file/${item.id}`)).status, 200);
});
