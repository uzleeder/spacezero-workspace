'use strict';
// The Admin dashboard, three lanes (lib/adminDashboard.js, views/dashboard/admin-board.ejs): what needs the admin in
// Urgent / Decision needed / Up next, the red "Something broke" bar, 4 health rings and who is
// falling behind. It is counted live from the same sources as the pages it links to, so a change anywhere shows on
// the next load, and GET /dashboard/live gives the board alone for the page to refresh itself.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

mock.method(require('../lib/gemini'), 'generateStructured', async () => { throw new Error('Gemini must not be called in these tests'); });

const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { dayKey } = require('../lib/callPractice');
const np = require('../lib/newAgentProgram');
const { adminDashboard } = require('../lib/adminDashboard');
const app = require('../server');

let org; let quiet; const people = {};
const today = dayKey(new Date());
const DAY = 86400000;
const get = (who, url) => request(app).get(url).set('Cookie', people[who].cookie);
const lane = (dash, key) => dash.lanes.find((l) => l.key === key).cards;
const cardOf = (dash, key) => dash.lanes.flatMap((l) => l.cards).find((c) => c.key === key) || null;

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Admin dashboard tests' } });
  quiet = await prisma.organization.create({ data: { name: 'Admin dashboard tests, nothing to do' } });
  const mk = async (key, role, extra = {}, orgId = org.id) => {
    const p = await prisma.profile.create({ data: { organizationId: orgId, fullName: `${key[0].toUpperCase()}${key.slice(1)} Tester`, username: `adb_${orgId}_${key}`, email: `adb_${orgId}_${key}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date(Date.now() - 3 * DAY), ...extra } });
    const token = generateToken();
    await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
    people[key] = { p, cookie: `sz_session=${token.raw}` };
  };
  await mk('admin', 'ADMIN'); await mk('kamola', 'SUPERVISOR');
  await mk('aziz', 'TRAVEL_AGENT'); await mk('dilnoza', 'FLIGHT_EXPERT'); await mk('nodir', 'TRAVEL_AGENT', { status: 'INVITED' });
  await mk('calm', 'ADMIN', {}, quiet.id);
  await prisma.supervisorAssignment.create({ data: { supervisorId: people.kamola.p.id, agentId: people.aziz.p.id } });
  const start = async (key, daysAgo) => {
    const row = await np.startProgram(people[key].p, { startKey: np.addDays(today, -daysAgo), startDay: 1 });
    await prisma.agentProgram.update({ where: { id: row.id }, data: { workDaysJson: '[1,2,3,4,5,6,7]' } });
  };
  await start('aziz', 5);    // day 6: supervisor items 2+ days late, his own calls a day late
  await start('dilnoza', 2); // day 3, nobody supervises her
  await prisma.leaveRequest.create({ data: { organizationId: org.id, profileId: people.aziz.p.id, leaveType: 'VACATION', startDate: new Date(Date.now() + 10 * DAY), endDate: new Date(Date.now() + 11 * DAY), days: 2, status: 'PENDING', createdAt: new Date(Date.now() - 3 * DAY) } });
});
after(async () => { mock.restoreAll(); await prisma.$disconnect(); });

test('each lane holds its own kind of item, every card has a verb and a link, and the headline counts what needs fixing', async () => {
  const dash = await adminDashboard(people.admin.p);
  const fix = lane(dash, 'fix');
  const unowned = cardOf(dash, `unowned:${people.dilnoza.p.id}`);
  assert.ok(fix.includes(unowned), 'an agent nobody supervises is in Urgent');
  assert.equal(unowned.title, 'Dilnoza Tester has no supervisor');
  assert.equal(unowned.action, 'Assign supervisor');
  assert.equal(unowned.href, `/admin/employees/${people.dilnoza.p.id}`);
  const hire = cardOf(dash, `unowned:${people.nodir.p.id}`);
  assert.equal(hire.title, 'Nodir Tester is not in the New Agent Program', 'a new Travel Agent hired but not on the path');
  assert.equal(hire.action, 'Start it');
  const late = cardOf(dash, 'late');
  assert.ok(fix.includes(late), 'supervisor items 2+ days late are in Urgent');
  assert.match(late.title, /^\d+ supervisor items? 2\+ days late$/);
  assert.match(late.meta, /Aziz Tester/);

  const wait = lane(dash, 'wait');
  const leave = cardOf(dash, 'leave');
  assert.ok(wait.includes(leave));
  assert.equal(leave.title, '1 vacation request');
  assert.equal(leave.meta, 'The oldest has waited 3 days');
  assert.equal(leave.href, '/leave?status=PENDING');
  assert.ok(wait.includes(cardOf(dash, 'activation')), 'an invited employee who has not activated');
  assert.equal(cardOf(dash, 'activation').title, '1 person not activated yet');

  for (const c of dash.lanes.flatMap((l) => l.cards)) {
    assert.ok(c.title && c.action && c.href.startsWith('/'), `${c.key} says what to do and links to where`);
    assert.ok(c.faces.length <= 3);
  }
  assert.equal(dash.headline, `${fix.length} things need fixing.`);
  assert.equal(dash.total, dash.lanes.reduce((n, l) => n + l.cards.length, 0));
});

test('the 4 rings and the people falling behind', async () => {
  const dash = await adminDashboard(people.admin.p);
  assert.deepEqual(dash.rings.map((r) => r.label), ['Training on time', 'New agents on track', 'Call Practice accuracy', 'Standards acknowledged']);
  const agents = dash.rings.find((r) => r.key === 'newAgents');
  assert.match(agents.value, /^\d\/2$/, 'both running programs are counted');
  const accuracy = dash.rings.find((r) => r.key === 'accuracy');
  assert.equal(accuracy.status, 'none'); assert.equal(accuracy.note, 'No calls this week');
  for (const r of dash.rings) assert.ok(['ok', 'low', 'none'].includes(r.status) && r.href.startsWith('/'));
  const aziz = dash.behind.rows.find((b) => b.person.id === people.aziz.p.id);
  assert.ok(aziz, 'a new agent whose own work is late is falling behind');
  assert.match(aziz.tag, /^\d+ days? behind$/);
  assert.ok(dash.behind.rows.length <= 5 && dash.behind.total >= dash.behind.rows.length);
});

test('it is always up to date: a change elsewhere is on the next load, with nothing stored', async () => {
  const key = `unowned:${people.dilnoza.p.id}`;
  assert.ok(cardOf(await adminDashboard(people.admin.p), key));
  const a = await prisma.supervisorAssignment.create({ data: { supervisorId: people.kamola.p.id, agentId: people.dilnoza.p.id } });
  assert.equal(cardOf(await adminDashboard(people.admin.p), key), null, 'once there is a supervisor the card is gone');
  await prisma.supervisorAssignment.delete({ where: { id: a.id } });
  await prisma.leaveRequest.updateMany({ where: { organizationId: org.id }, data: { status: 'APPROVED' } });
  assert.equal(cardOf(await adminDashboard(people.admin.p), 'leave'), null, 'a decided vacation request leaves the lane');
  await prisma.leaveRequest.updateMany({ where: { organizationId: org.id }, data: { status: 'PENDING' } });
});

test('the page shows the lanes and refreshes itself from /dashboard/live, which gives an Admin this board and nobody else', async () => {
  const page = await get('admin', '/dashboard');
  assert.equal(page.status, 200);
  assert.match(page.headers['cache-control'], /no-store/);
  for (const text of ['Urgent', 'Decision needed', 'Up next', 'Academy health', 'Falling behind', 'Dilnoza Tester has no supervisor', 'Updated just now']) assert.ok(page.text.includes(text), text);
  assert.match(page.text, /data-live="\/dashboard\/live"/);
  assert.match(page.text, /dashboard-live\.js/);
  assert.doesNotMatch(page.text, /Total employees|Quick actions|A world of knowledge/);

  const live = await get('admin', '/dashboard/live');
  assert.equal(live.status, 200);
  assert.match(live.headers['cache-control'], /no-store/);
  assert.match(live.text, /Dilnoza Tester has no supervisor/);
  assert.doesNotMatch(live.text, /<html|<nav/i, 'the board alone, without the page around it');
  const supLive = await get('kamola', '/dashboard/live');
  assert.equal(supLive.status, 200, 'a supervisor gets their own board there (lib/supervisorDashboard.js)');
  assert.match(supLive.text, /Your team/); assert.doesNotMatch(supLive.text, /Dilnoza Tester has no supervisor|Decision needed/, 'never the admin board');
  assert.equal((await get('aziz', '/dashboard/live')).status, 403);
  assert.equal((await request(app).get('/dashboard/live')).status, 302, 'signed out: to the sign-in page');
});

test('nothing to do: "All clear", and supervisors and agents keep their own dashboards', async () => {
  const dash = await adminDashboard(people.calm.p);
  assert.equal(dash.total, 0); assert.equal(dash.headline, 'All clear today.');
  assert.deepEqual(dash.broken, []);
  const page = await get('calm', '/dashboard');
  assert.match(page.text, /All clear today\./); assert.match(page.text, /Nothing is waiting for you/);
  assert.doesNotMatch(page.text, /dash-lanes/);
  assert.match((await get('kamola', '/dashboard')).text, /Your team/, 'the supervisor has their own dashboard (lib/supervisorDashboard.js)');
  assert.match((await get('aziz', '/dashboard')).text, /Needs your attention/);
});
