'use strict';
// The Supervisor dashboard, at a glance (lib/supervisorDashboard.js, views/dashboard/supervisor-board.ejs): their own
// team as faces with a coloured ring (needs you / behind / on track / away), and their list as short tiles in Late /
// Today / This week. Only their own team is read; it is counted live, so a change elsewhere is on the next load.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

mock.method(require('../lib/gemini'), 'generateStructured', async () => { throw new Error('Gemini must not be called in these tests'); });

const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { dayKey } = require('../lib/callPractice');
const np = require('../lib/newAgentProgram');
const { supervisorDashboard } = require('../lib/supervisorDashboard');
const app = require('../server');

let org; let course; const people = {};
const today = dayKey(new Date());
const DAY = 86400000;
const get = (who, url) => request(app).get(url).set('Cookie', people[who].cookie);
const tiles = (dash, lane) => dash.lanes.find((l) => l.key === lane).tiles;
const allTiles = (dash) => dash.lanes.flatMap((l) => l.tiles);
const member = (dash, who) => dash.team.find((t) => t.person.id === people[who].p.id) || null;

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Supervisor dashboard tests' } });
  const mk = async (key, role, extra = {}) => {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `${key[0].toUpperCase()}${key.slice(1)} Tester`, username: `sdb_${org.id}_${key}`, email: `sdb_${org.id}_${key}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date(Date.now() - 3 * DAY), ...extra } });
    const token = generateToken();
    await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
    people[key] = { p, cookie: `sz_session=${token.raw}` };
  };
  await mk('admin', 'ADMIN'); await mk('kamola', 'SUPERVISOR'); await mk('bobur', 'SUPERVISOR'); await mk('lonely', 'SUPERVISOR');
  await mk('aziz', 'TRAVEL_AGENT'); await mk('malika', 'TRAVEL_AGENT'); await mk('leo', 'FLIGHT_EXPERT'); await mk('ben', 'FLIGHT_EXPERT');
  await mk('dilnoza', 'TRAVEL_AGENT');
  await prisma.supervisorAssignment.createMany({ data: [
    { supervisorId: people.kamola.p.id, agentId: people.aziz.p.id },
    { supervisorId: people.kamola.p.id, agentId: people.malika.p.id },
    { supervisorId: people.kamola.p.id, agentId: people.leo.p.id },
    { supervisorId: people.kamola.p.id, agentId: people.ben.p.id },
    { supervisorId: people.bobur.p.id, agentId: people.dilnoza.p.id },
  ] });
  const start = async (key, daysAgo) => {
    const row = await np.startProgram(people[key].p, { startKey: np.addDays(today, -daysAgo), startDay: 1 });
    await prisma.agentProgram.update({ where: { id: row.id }, data: { workDaysJson: '[1,2,3,4,5,6,7]' } });
  };
  await start('aziz', 5);    // day 6: supervisor items 2+ days late
  await start('malika', 0);  // day 1: things for today
  await start('dilnoza', 5); // another supervisor's agent: never on Kamola's dashboard
  // Ben is on approved leave today; Leo asked for a vacation and has a suggested refresher
  await prisma.leaveRequest.create({ data: { organizationId: org.id, profileId: people.ben.p.id, leaveType: 'VACATION', startDate: new Date(Date.now() - DAY), endDate: new Date(Date.now() + 2 * DAY), days: 4, status: 'APPROVED' } });
  await prisma.leaveRequest.create({ data: { organizationId: org.id, profileId: people.leo.p.id, leaveType: 'VACATION', startDate: new Date(Date.now() + 10 * DAY), endDate: new Date(Date.now() + 12 * DAY), days: 3, status: 'PENDING' } });
  course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'SDB fare rules', createdById: people.admin.p.id, status: 'PUBLISHED' } });
  await prisma.developmentRecommendation.create({ data: { organizationId: org.id, profileId: people.leo.p.id, kind: 'REINFORCEMENT', source: 'RETENTION', sourceKey: `sdb:${org.id}`, courseId: course.id, title: 'Refresh fare rules', reason: 'Fare rules slipped since the training' } });
});
after(async () => { mock.restoreAll(); await prisma.$disconnect(); });

test('only their own team: one face each, who needs them first, someone on leave is away', async () => {
  const dash = await supervisorDashboard(people.kamola.p);
  const ids = dash.team.map((t) => t.person.id);
  for (const k of ['aziz', 'malika', 'leo', 'ben']) assert.ok(ids.includes(people[k].p.id), `${k} is on the team`);
  assert.ok(!ids.includes(people.dilnoza.p.id), 'another supervisor\'s agent is not');
  assert.ok(!JSON.stringify(allTiles(dash)).includes('Dilnoza'), 'and none of their items');

  const aziz = member(dash, 'aziz');
  assert.equal(aziz.status, 'need'); assert.match(aziz.tag, / late$|Days not set/);
  assert.equal(dash.team[0].status, 'need', 'who needs you comes first');
  assert.equal(member(dash, 'ben').status, 'away'); assert.equal(member(dash, 'ben').tag, 'Away');
  assert.match(member(dash, 'malika').tag, /^Day 1$|late$/);
  assert.ok(dash.tally.find((x) => x.key === 'need').n >= 1);
});

test('the list: late new-agent items, today\'s check-ins, and this week\'s vacation and refresher', async () => {
  const dash = await supervisorDashboard(people.kamola.p);
  const late = tiles(dash, 'late');
  const azizLate = late.find((t) => t.faces.some((f) => f.name === 'Aziz Tester'));
  assert.ok(azizLate, 'Aziz\'s late items are in Late');
  assert.match(azizLate.chip, /^\d+ days? late$/);
  assert.match(azizLate.href, new RegExp(`^/new-agents/${people.aziz.p.id}`));
  assert.ok(late.length <= 3, 'late items are grouped per person, not one tile each');

  const todayTiles = tiles(dash, 'today');
  assert.ok(todayTiles.some((t) => t.faces.some((f) => f.name === 'Malika Tester')), 'Malika\'s day 1 items are for today');
  assert.match(dash.lanes[1].hint, /^About /);

  const week = tiles(dash, 'week');
  const leave = week.find((t) => t.key.startsWith('leave:'));
  assert.equal(leave.label, 'Vacation'); assert.equal(leave.chip, 'Recommend'); assert.equal(leave.faces[0].name, 'Leo Tester');
  const refresher = week.find((t) => t.key.startsWith('rec:'));
  assert.equal(refresher.label, 'Refresher'); assert.equal(refresher.href, '/team-skills');

  for (const t of allTiles(dash)) assert.ok(t.label && t.chip && t.href.startsWith('/'), `${t.key}: words, a chip and a link`);
  assert.match(dash.headline, /^\d+ late, \d+ today\.$/);
});

test('always up to date: a recommended vacation and an assigned refresher leave the list on the next load', async () => {
  await prisma.leaveRequest.updateMany({ where: { profileId: people.leo.p.id, status: 'PENDING' }, data: { recommendation: 'RECOMMEND_APPROVE' } });
  await prisma.developmentRecommendation.updateMany({ where: { profileId: people.leo.p.id }, data: { status: 'ASSIGNED' } });
  const dash = await supervisorDashboard(people.kamola.p);
  assert.equal(tiles(dash, 'week').filter((t) => t.key.startsWith('leave:') || t.key.startsWith('rec:')).length, 0);
  await prisma.leaveRequest.updateMany({ where: { profileId: people.leo.p.id, status: 'PENDING' }, data: { recommendation: 'NONE' } });
  await prisma.developmentRecommendation.updateMany({ where: { profileId: people.leo.p.id }, data: { status: 'OPEN' } });
});

test('the page: faces and three columns, refreshed from /dashboard/live; an empty team says so', async () => {
  const page = await get('kamola', '/dashboard');
  assert.equal(page.status, 200);
  assert.match(page.headers['cache-control'], /no-store/);
  for (const text of ['Your team', 'Late', 'Today', 'This week', 'Updated just now', 'Aziz', 'Malika']) assert.ok(page.text.includes(text), text);
  assert.match(page.text, /data-live="\/dashboard\/live"/);
  assert.match(page.text, new RegExp(`sd-person--away" href="/team/${people.ben.p.id}"`));
  assert.doesNotMatch(page.text, /Needs your attention|Attention required|Agents on my team|Dilnoza/);

  const live = await get('kamola', '/dashboard/live');
  assert.equal(live.status, 200);
  assert.match(live.text, /Your team/); assert.doesNotMatch(live.text, /<html/i);

  const empty = await get('lonely', '/dashboard');
  assert.match(empty.text, /Nobody is assigned to you yet/); assert.match(empty.text, /Nothing for you today/);
});
