'use strict';
// The light / dark button stays on the page you are on (it used to land on the dashboard because the
// site sends Referrer-Policy: no-referrer, so the server never learned the previous page).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const app = require('../server');

let cookie;
before(async () => {
  const org = await prisma.organization.create({ data: { name: 'Theme tests' } });
  const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: 'Theme User', username: `th_${org.id}`, email: `th_${org.id}@example.invalid`, role: 'TRAVEL_AGENT', status: 'ACTIVE', employmentStartDate: new Date() } });
  const token = generateToken();
  await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
  cookie = `sz_session=${token.raw}`;
});
after(async () => { await prisma.$disconnect(); });

test('the theme button carries the page it is on', async () => {
  const page = await request(app).get('/library?category=abc').set('Cookie', cookie);
  assert.match(page.text, /<form method="post" action="\/theme"[^>]*>\s*<input type="hidden" name="next" value="\/library\?category=abc" \/>/);
  const login = await request(app).get('/login');
  assert.match(login.text, /action="\/theme"[^>]*>\s*<input type="hidden" name="next" value="\/login"/);
});

test('posting the theme goes back to that page - never to the dashboard - and saves the choice', async () => {
  const res = await request(app).post('/theme').type('form').send({ theme: 'dark', next: '/library?category=abc' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/library?category=abc');
  assert.match([].concat(res.headers['set-cookie']).join(' '), /sz_theme=dark/);
  const light = await request(app).post('/theme').type('form').send({ theme: 'light', next: '/standards' });
  assert.equal(light.headers.location, '/standards');
  assert.match([].concat(light.headers['set-cookie']).join(' '), /sz_theme=light/);
});

test('only same-site pages are followed; nothing sent means the dashboard', async () => {
  for (const next of ['https://evil.example/x', '//evil.example', 'javascript:alert(1)', '']) {
    const res = await request(app).post('/theme').type('form').send({ theme: 'dark', next });
    assert.equal(res.headers.location, '/dashboard', JSON.stringify(next));
  }
  assert.equal((await request(app).post('/theme').type('form').send({ theme: 'dark' })).headers.location, '/dashboard');
});

test('the in-page script gets a quick 204 and the choice is saved; the page script switches it in place', async () => {
  const res = await request(app).post('/theme').set('X-Requested-With', 'fetch').type('form').send({ theme: 'dark' });
  assert.equal(res.status, 204);
  assert.match([].concat(res.headers['set-cookie']).join(' '), /sz_theme=dark/);
  const js = (await request(app).get('/static/js/app.js')).text;
  assert.match(js, /form\[action="\/theme"\]/);
  assert.match(js, /setAttribute\('data-theme', wanted\)/);
  const dark = await request(app).get('/library').set('Cookie', `${cookie}; sz_theme=dark`);
  assert.match(dark.text, /<html lang="en" data-theme="dark">/);
});
