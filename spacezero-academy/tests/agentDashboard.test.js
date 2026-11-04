'use strict';
// The Agent dashboard (lib/agentDashboard.js, views/dashboard/agent-board.ejs): the same page for every agent, new or
// not. Next = the current step of My Training with the same button; Call Practice only while a call is waiting today;
// "Also for you" only when there is something (setup left, required standards, other overdue trainings, retakes);
// "All caught up" when nothing is left.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

mock.method(require('../lib/gemini'), 'generateStructured', async () => { throw new Error('Gemini must not be called in these tests'); });
// Call Practice is driven by its own tests (callPractice.test.js); here only "is a call waiting today" matters
let callPlan = null;
mock.method(require('../lib/callPractice'), 'summaryFor', async () => callPlan);

const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { agentDashboard } = require('../lib/agentDashboard');
const { getMyTrainingList } = require('../lib/training');
const { pathOf } = require('../lib/myTraining');
const app = require('../server');

const DAY = 86400000;
let org; let admin; const people = {};
const get = (who, url) => request(app).get(url).set('Cookie', people[who].cookie);

async function course(title) {
  return prisma.trainingCourse.create({ data: { organizationId: org.id, title, status: 'PUBLISHED', publishedVersion: 1, createdById: admin.id, mandatory: true, assignPolicy: 'ALL_SUPERVISORS' } });
}
async function assign(c, profile, { dueDate = null, status = 'NOT_STARTED' } = {}) {
  const a = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: c.id, courseVersion: 1, assignedById: admin.id, scope: 'INDIVIDUAL', dueDate } });
  const r = await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: a.id, profileId: profile.id } });
  await prisma.trainingAttempt.create({ data: { recipientId: r.id, profileId: profile.id, attemptNumber: 1, status, ...(status === 'COMPLETED' ? { score: 95, completedAt: new Date() } : {}) } });
  return r;
}

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Agent dashboard tests' } });
  const mk = async (key, role) => {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `${key[0].toUpperCase()}${key.slice(1)} Tester`, username: `adg_${org.id}_${key}`, email: `adg_${org.id}_${key}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date(Date.now() - 10 * DAY) } });
    const token = generateToken();
    await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
    people[key] = { p, cookie: `sz_session=${token.raw}` };
    return p;
  };
  admin = await mk('admin', 'ADMIN');
  await mk('aziz', 'TRAVEL_AGENT'); await mk('olim', 'FLIGHT_EXPERT');
  // Aziz: one done, one overdue (next), one more overdue, one retake, one with no due date
  await assign(await course('ADG done'), people.aziz.p, { status: 'COMPLETED' });
  await assign(await course('ADG first overdue'), people.aziz.p, { dueDate: new Date(Date.now() - 5 * DAY) });
  await assign(await course('ADG second overdue'), people.aziz.p, { dueDate: new Date(Date.now() - 2 * DAY) });
  await assign(await course('ADG retake'), people.aziz.p, { status: 'RETAKE_REQUIRED' });
  await assign(await course('ADG later'), people.aziz.p);
  // Olim: everything done
  await assign(await course('ADG olim done'), people.olim.p, { status: 'COMPLETED' });
});
after(async () => { mock.restoreAll(); await prisma.$disconnect(); });

test('Next is the current step of My Training, with the same button; the rest is in "Also for you"', async () => {
  const dash = await agentDashboard(people.aziz.p);
  const path = pathOf(await getMyTrainingList(people.aziz.p.id, { progress: true }));
  assert.equal(dash.next.label, 'Next');
  assert.equal(dash.next.title, path.current.title, 'the same step as My Training');
  assert.equal(dash.next.title, 'ADG first overdue', 'the most overdue first');
  assert.equal(dash.next.action, path.action, 'and the same button');
  assert.deepEqual(dash.next.chips.map((c) => c.text), [`Training ${path.current.number} of 5`, '5 days overdue']);
  assert.deepEqual(dash.progress, { done: 1, total: 5, percent: 20 });

  const keys = dash.also.map((a) => a.key);
  assert.ok(keys.includes('overdue') && keys.includes('retakes'));
  assert.equal(dash.also.find((a) => a.key === 'overdue').label, '"ADG second overdue"');
  assert.equal(dash.also.find((a) => a.key === 'retakes').label, 'Retake "ADG retake"');
  assert.equal(dash.headline, '3 things are overdue.');
});

test('Call Practice shows only while a call is waiting today', async () => {
  callPlan = { next: { number: 3, call: { id: 'c3', durationSeconds: 70 } }, open: true, started: false };
  let dash = await agentDashboard(people.aziz.p);
  assert.deepEqual([dash.call.title, dash.call.action, dash.call.href], ['Call 3 is ready', 'Start call', '/call-practice/c3']);
  callPlan = { next: { number: 4, call: { id: 'c4', durationSeconds: 60 } }, open: false, started: false }; // today's calls are done
  dash = await agentDashboard(people.aziz.p);
  assert.equal(dash.call, null);
  callPlan = { next: null, open: false }; // every call done
  assert.equal((await agentDashboard(people.aziz.p)).call, null);
  callPlan = null; // not in Call Practice (after Month 1, or approved for solo calls)
  assert.equal((await agentDashboard(people.aziz.p)).call, null);
});

test('nothing left: "All caught up", and a finished training moves Next on the next load', async () => {
  const done = await agentDashboard(people.olim.p);
  assert.equal(done.next, null, 'no training left: the card says All caught up');
  // the headline only says it when nothing else is left either (here the default setup checklist still is)
  assert.equal(done.headline, done.also.length ? '' : 'All caught up.');
  assert.deepEqual(done.also.map((a) => a.key), ['setup']);
  const page = await get('olim', '/dashboard');
  assert.match(page.text, /All caught up/); assert.match(page.text, /Your training is done\./);

  const r = await prisma.trainingAssignmentRecipient.findFirst({ where: { profileId: people.aziz.p.id, assignment: { course: { title: 'ADG first overdue' } } } });
  await prisma.trainingAttempt.updateMany({ where: { recipientId: r.id }, data: { status: 'COMPLETED', score: 95, completedAt: new Date() } });
  const after1 = await agentDashboard(people.aziz.p);
  assert.notEqual(after1.next.title, 'ADG first overdue');
  assert.equal(after1.progress.done, 2);
});

test('the page: one Next card, the call line, the tiles, refreshed from /dashboard/live; nothing from the old dashboard', async () => {
  callPlan = { next: { number: 1, call: { id: 'c1', durationSeconds: 60 } }, open: true, started: false };
  const page = await get('aziz', '/dashboard');
  assert.equal(page.status, 200);
  assert.match(page.headers['cache-control'], /no-store/);
  assert.match(page.text, /<section class="ag-next" id="next"/, 'Skill DNA links to #next');
  assert.match(page.text, /Call 1 is ready/);
  assert.match(page.text, /Also for you/);
  assert.match(page.text, /data-live="\/dashboard\/live"/);
  assert.doesNotMatch(page.text, /My status|Required training open|Recent improvement|Achievements &amp; certificates|Recommended practice/);
  const live = await get('aziz', '/dashboard/live');
  assert.equal(live.status, 200); assert.match(live.text, /class="ag-next"/); assert.doesNotMatch(live.text, /<html/i);
  callPlan = null;
});
