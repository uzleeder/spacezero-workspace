'use strict';
// The dashboard's "SpaceZero standard" card. By default its globe turns in the sidebar logo and the dashboard has no
// card; the button on that sidebar globe brings the card onto this person's dashboard, and the card's X sends it back.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const app = require('../server');

let agent, cookie;
before(async () => {
  const org = await prisma.organization.create({ data: { name: 'Hero dock tests' } });
  agent = await prisma.profile.create({ data: { organizationId: org.id, fullName: 'Dock Agent', username: `hd_${org.id}`, email: `hd_${org.id}@example.invalid`, role: 'TRAVEL_AGENT', status: 'ACTIVE', employmentStartDate: new Date() } });
  const t = generateToken();
  await prisma.session.create({ data: { profileId: agent.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } });
  cookie = `sz_session=${t.raw}`;
});
after(async () => { await prisma.$disconnect(); });

const dashboard = () => request(app).get('/dashboard').set('Cookie', cookie);
const save = (hidden) => request(app).post('/dashboard/hero').set('Cookie', cookie).set('X-Requested-With', 'fetch').type('form').send({ hidden });

test('by default the globe turns in the sidebar logo on every page, and the dashboard has no card', async () => {
  assert.equal(agent.heroShown, false);
  const page = await dashboard();
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /data-hero>/);
  assert.doesNotMatch(page.text, /hero-globe\.js/);
  assert.match(page.text, /brand-mark--globe/);
  assert.match(page.text, /class="mini-globe"/);
  assert.match(page.text, /data-hero-restore aria-label="Show the SpaceZero standard card on the dashboard"/);
  const other = await request(app).get('/profile').set('Cookie', cookie);
  assert.match(other.text, /brand-mark--globe/);
});

test('the sidebar button brings the card onto this person\'s dashboard, and its X sends it back to the sidebar', async () => {
  const shown = await save('0');
  assert.equal(shown.status, 200);
  assert.deepEqual(shown.body, { ok: true, hidden: false });
  assert.equal((await prisma.profile.findUnique({ where: { id: agent.id } })).heroShown, true);
  let page = await dashboard();
  assert.match(page.text, /<section class="workspace-hero" data-hero>/);
  assert.match(page.text, /data-hero-close/);
  assert.doesNotMatch(page.text, /brand-mark--globe/);
  assert.match(page.text, /data-hero-restore hidden/);

  const docked = await save('1');
  assert.deepEqual(docked.body, { ok: true, hidden: true });
  page = await dashboard();
  assert.doesNotMatch(page.text, /data-hero>/);
  assert.match(page.text, /brand-mark--globe/);
});

test('without the page script the form post still works, and signed-out requests are refused', async () => {
  const res = await request(app).post('/dashboard/hero').set('Cookie', cookie).type('form').send({ hidden: '1' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/dashboard');
  const anon = await request(app).post('/dashboard/hero').type('form').send({ hidden: '0' });
  assert.notEqual(anon.status, 200);
});
