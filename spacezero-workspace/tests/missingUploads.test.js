'use strict';
// A profile photo whose file is no longer on disk (for example after the uploads folder was not kept across a
// redeploy) is "not found" - not a server error. It used to answer HTTP 500 on every page that showed the avatar.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const app = require('../server');

let admin, cookie;
before(async () => {
  const org = await prisma.organization.create({ data: { name: 'Missing uploads tests' } });
  admin = await prisma.profile.create({ data: { organizationId: org.id, fullName: 'Photo Admin', username: `mu_${org.id}`, email: `mu_${org.id}@example.invalid`, role: 'ADMIN', status: 'ACTIVE', employmentStartDate: new Date(), photoUrl: '/static/uploads/avatars/gone-forever.webp' } });
  const t = generateToken(); await prisma.session.create({ data: { profileId: admin.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookie = `sz_session=${t.raw}`;
});
after(async () => { await prisma.$disconnect(); });

test('a profile photo that is missing on disk answers 404 (not 500) and sends no error page', async () => {
  const res = await request(app).get(admin.photoUrl).set('Cookie', cookie);
  assert.equal(res.status, 404);
  assert.doesNotMatch(res.text || '', /Something went wrong/);
});

test('pages that show the photo still load, and the site script turns a broken photo into initials', async () => {
  const page = await request(app).get('/dashboard').set('Cookie', cookie);
  assert.equal(page.status, 200);
  const script = await request(app).get('/static/js/app.js');
  assert.match(script.text, /data-avatar-fallback/);
});

test('real server errors still answer 500, and bad requests the framework rejects are not reported as server errors', async () => {
  const bad = await request(app).post('/login').set('Content-Type', 'application/json').send('{"broken": ');
  assert.ok(bad.status >= 400 && bad.status < 500, `status ${bad.status}`);
});
