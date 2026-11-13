'use strict';
// Settings → Advanced, easier to follow: each page has one plain sentence and a live status line; the setup checklist
// shows who needs each item and who ticks it off in plain words, with moving and archiving in a "⋯" menu; Supervisor
// permissions are one table, and a Supervisor's page offers ready-made sets that never include the sensitive ones.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const app = require('../server');

let org, admin, sup, cookie;
const get = (url) => request(app).get(url).set('Cookie', cookie);
const post = (url, body) => request(app).post(url).set('Cookie', cookie).type('form').send(body);

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Advanced easy tests' } });
  const base = { organizationId: org.id, status: 'ACTIVE', employmentStartDate: new Date() };
  admin = await prisma.profile.create({ data: { ...base, fullName: 'Adv Admin', username: `aa_${org.id}`, email: `aa_${org.id}@example.invalid`, role: 'ADMIN' } });
  sup = await prisma.profile.create({ data: { ...base, fullName: 'Adv Supervisor', username: `as_${org.id}`, email: `as_${org.id}@example.invalid`, role: 'SUPERVISOR' } });
  await prisma.profile.create({ data: { ...base, fullName: 'Adv Supervisor Two', username: `as2_${org.id}`, email: `as2_${org.id}@example.invalid`, role: 'SUPERVISOR' } });
  const t = generateToken();
  await prisma.session.create({ data: { profileId: admin.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } });
  cookie = `sz_session=${t.raw}`;
  await get('/admin/settings'); // the first Admin visit grants this organization's Admins access to Advanced
  await prisma.supervisorCapability.create({ data: { organizationId: org.id, supervisorId: sup.id, key: 'setup.view', grantedById: admin.id } });
});
after(async () => { await prisma.$disconnect(); });

test('the Advanced home shows a plain sentence and a live status for each page', async () => {
  await get('/admin/setup-requirements'); // creates the default checklist
  const page = await get('/admin/settings?tab=advanced');
  assert.equal(page.status, 200);
  assert.match(page.text, /The checklist of tools and accounts every employee needs/);
  assert.match(page.text, /class="adv-status adv-status--ok">\d+ items?( · \d+ checked by a manager)?</);
  assert.match(page.text, /1 of 2 Supervisors can manage their team/);
  assert.match(page.text, /1 of 1 Admin can open Advanced/);
  assert.match(page.text, /Pass mark \d+%/);
});

test('the setup checklist says who needs each item and who ticks it off, in plain words', async () => {
  const created = await post('/admin/setup-requirements', { label: 'Amadeus login', category: 'System Access', audience: 'ROLES', roles: 'TRAVEL_AGENT', required: 'required', verification: 'MANAGEMENT_VERIFICATION' });
  assert.equal(created.status, 302);
  const page = await get('/admin/setup-requirements');
  assert.match(page.text, /data-howto="setup-requirements"/);
  assert.match(page.text, /<strong>Amadeus login<\/strong>\s*<span class="sr-meta">System Access · Travel Agent/);
  assert.match(page.text, /Employee ticks it, a manager confirms/);
  assert.match(page.text, /<details class="sr-menu">/);
  assert.match(page.text, /data-confirm-submit="Archive &quot;Amadeus login&quot;\?/);
  const form = await get('/admin/setup-requirements/new');
  assert.match(form.text, /1<\/span> What is it\?/);
  assert.match(form.text, /2<\/span> Who needs it\?/);
  assert.match(form.text, /data-pick-filter/);
});

test('Supervisor permissions: one table of who can do what, and ready-made sets without the sensitive ones', async () => {
  const list = await get('/admin/supervisor-permissions');
  assert.match(list.text, /class="table sp-table"/);
  assert.match(list.text, /Adv Supervisor<\/a><span class="sp-user">@as_[^ ]+ · 1 of \d+<\/span>/);
  assert.match(list.text, /Passwords 🔒/);
  const page = await get(`/admin/supervisor-permissions/${sup.id}`);
  const presets = [...page.text.matchAll(/data-sp-preset="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(presets.length >= 3);
  for (const p of presets) assert.doesNotMatch(p, /credentials\.view_team|passport\.viewNumber/);
  assert.match(page.text, /🔒 Sensitive/);
  // saving still works with the same field name
  await post(`/admin/supervisor-permissions/${sup.id}`, { capabilities: ['setup.view', 'setup.manage'] });
  const keys = (await prisma.supervisorCapability.findMany({ where: { supervisorId: sup.id } })).map((g) => g.key).sort();
  assert.deepEqual(keys, ['setup.manage', 'setup.view']);
});
