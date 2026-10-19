'use strict';
// Dark is the default look for everyone on every page. Light is used only by a browser that chose it with the
// sun/moon button (a cookie), and that choice is kept.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { themeFor, DEFAULT_THEME } = require('../lib/theme');
const app = require('../server');

const theme = (res) => (/<html[^>]*data-theme="(\w+)"/.exec(res.text) || [])[1];
let agent, cookie;
before(async () => {
  const org = await prisma.organization.create({ data: { name: 'Default theme tests' } });
  agent = await prisma.profile.create({ data: { organizationId: org.id, fullName: 'Theme Agent', username: `th_${org.id}`, email: `th_${org.id}@example.invalid`, role: 'TRAVEL_AGENT', status: 'ACTIVE', employmentStartDate: new Date() } });
  const t = generateToken(); await prisma.session.create({ data: { profileId: agent.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookie = `sz_session=${t.raw}`;
});
after(async () => { await prisma.$disconnect(); });

test('the rule: dark unless light was explicitly chosen', () => {
  assert.equal(DEFAULT_THEME, 'dark');
  assert.equal(themeFor({}), 'dark');
  assert.equal(themeFor({ cookies: {} }), 'dark');
  assert.equal(themeFor({ cookies: { sz_theme: 'dark' } }), 'dark');
  assert.equal(themeFor({ cookies: { sz_theme: 'junk' } }), 'dark');
  assert.equal(themeFor({ cookies: { sz_theme: 'light' } }), 'light');
});

test('a first visit is dark: sign-in, forgot password, the app and the error pages', async () => {
  for (const url of ['/login', '/forgot-password']) assert.equal(theme(await request(app).get(url)), 'dark', url);
  assert.equal(theme(await request(app).get('/dashboard').set('Cookie', cookie)), 'dark');
  assert.equal(theme(await request(app).get('/training').set('Cookie', cookie)), 'dark');
  assert.equal(theme(await request(app).get('/no-such-page').set('Cookie', cookie)), 'dark');                           // not found
  assert.equal(theme(await request(app).get('/admin/employees').set('Cookie', cookie).set('Accept', 'text/html')), 'dark'); // access denied
});

test('someone who chose light keeps light; choosing dark again returns to dark', async () => {
  const chosen = await request(app).post('/theme').type('form').send({ theme: 'light', next: '/login' });
  const set = chosen.headers['set-cookie'].find((c) => c.startsWith('sz_theme='));
  assert.match(set, /^sz_theme=light/);
  const light = `${cookie}; sz_theme=light`;
  assert.equal(theme(await request(app).get('/dashboard').set('Cookie', light)), 'light');
  assert.equal(theme(await request(app).get('/login').set('Cookie', 'sz_theme=light')), 'light');
  assert.equal(theme(await request(app).get('/no-such-page').set('Cookie', light)), 'light');
  const back = await request(app).post('/theme').type('form').send({ theme: 'dark' });
  assert.match(back.headers['set-cookie'].find((c) => c.startsWith('sz_theme=')), /^sz_theme=dark/);
  assert.equal(theme(await request(app).get('/dashboard').set('Cookie', `${cookie}; sz_theme=dark`)), 'dark');
});

test('the toggle on a dark page offers light mode (and the reverse)', async () => {
  const dark = await request(app).get('/dashboard').set('Cookie', cookie);
  assert.match(dark.text, /name="theme" value="light"/);
  assert.match(dark.text, /Switch to light mode/);
  const light = await request(app).get('/dashboard').set('Cookie', `${cookie}; sz_theme=light`);
  assert.match(light.text, /name="theme" value="dark"/);
  assert.match(light.text, /Switch to dark mode/);
});
