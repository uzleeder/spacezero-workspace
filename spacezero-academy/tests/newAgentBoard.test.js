'use strict';
// New Agent Program, step 2 (lib/newAgentBoard.js, routes/newAgents.js): the supervisor's New agents board - their
// overdue and today list across agents, one card per agent with ONE status in words - and the agent's page, with
// every supervisor action: done, sign-off, review (extend a week), undo, working days, days off, notes. A Supervisor
// sees only their own agents; an Admin sees everyone; an agent sees neither.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

mock.method(require('../lib/gemini'), 'generateStructured', async () => { throw new Error('Gemini must not be called in these tests'); });

const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { dayKey } = require('../lib/callPractice');
const np = require('../lib/newAgentProgram');
const board = require('../lib/newAgentBoard');
const app = require('../server');

let org; const people = {}; const programs = {};
const today = dayKey(new Date());
const as = (who) => ({
  get: (url) => request(app).get(url).set('Cookie', people[who].cookie),
  form: (url, body) => request(app).post(url).set('Cookie', people[who].cookie).type('form').send(body),
});
const taskOf = (who, pred) => prisma.agentProgramTask.findFirst({ where: { programId: programs[who].id, ...pred } });

before(async () => {
  org = await prisma.organization.create({ data: { name: 'New agents board tests' } });
  const mk = async (key, role, extra = {}) => {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `${key[0].toUpperCase()}${key.slice(1)} Tester`, username: `nab_${org.id}_${key}`, email: `nab_${org.id}_${key}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date(), ...extra } });
    const token = generateToken();
    await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
    people[key] = { p, cookie: `sz_session=${token.raw}` };
  };
  await mk('admin', 'ADMIN');
  await mk('kamola', 'SUPERVISOR');
  await mk('bobur', 'SUPERVISOR');
  await mk('aziz', 'TRAVEL_AGENT');   // day 6, nothing of week 1 done: urgent
  await mk('malika', 'TRAVEL_AGENT'); // day 1: on track
  await mk('jasur', 'FLIGHT_EXPERT'); // another supervisor's agent
  await mk('dilnoza', 'TRAVEL_AGENT'); // no supervisor
  await prisma.supervisorAssignment.createMany({ data: [
    { supervisorId: people.kamola.p.id, agentId: people.aziz.p.id },
    { supervisorId: people.kamola.p.id, agentId: people.malika.p.id },
    { supervisorId: people.bobur.p.id, agentId: people.jasur.p.id },
  ] });
  // every day a working day, so "today" is always a program day whatever day the tests run
  const start = async (key, daysAgo) => {
    const row = await np.startProgram(people[key].p, { startKey: np.addDays(today, -daysAgo), startDay: 1 });
    programs[key] = await prisma.agentProgram.update({ where: { id: row.id }, data: { workDaysJson: '[1,2,3,4,5,6,7]' } });
  };
  await start('aziz', 5); await start('malika', 0); await start('jasur', 5); await start('dilnoza', 2);
});
after(async () => { mock.restoreAll(); await prisma.$disconnect(); });

test('one group per agent: urgent, needs you, behind, not started, on track, finished', () => {
  let n = 0;
  const sup = (day, extra = {}) => ({ key: `step:${(n += 1)}`, day, kind: 'DEMO', owner: 'SUPERVISOR', doneAt: null, title: 'A demo', ...extra });
  const mine = (day, extra = {}) => ({ key: `calls:${day}:${(n += 1)}`, day, kind: 'CALLS', owner: 'AGENT', doneAt: null, title: 'Calls', target: 2, ...extra });
  const base = { profile: { status: 'ACTIVE', fullName: 'Kevin Walsh' }, summary: { finished: false } };
  const at6 = { passed: 5, today: 6, started: true };
  assert.equal(board.groupOf({ ...base, tasks: [], pos: { passed: 0, today: null, started: false } }), 'NOT_STARTED');
  assert.equal(board.groupOf({ ...base, tasks: [sup(4)], pos: at6 }), 'URGENT', '2 working days late');
  assert.equal(board.groupOf({ ...base, tasks: [mine(5), mine(5), mine(5)], pos: at6 }), 'URGENT', '3 late items');
  assert.equal(board.groupOf({ ...base, tasks: [sup(5)], pos: at6 }), 'NEEDS_YOU', 'a supervisor item a day late');
  assert.equal(board.groupOf({ ...base, tasks: [sup(6, { kind: 'SIGN_OFF', system: 'EGF' })], pos: at6 }), 'NEEDS_YOU', 'a sign-off today');
  assert.equal(board.groupOf({ ...base, tasks: [mine(5)], pos: at6 }), 'BEHIND', 'their own work a day late');
  assert.equal(board.groupOf({ ...base, tasks: [sup(6, { key: 'checkin:6', kind: 'CHECK_IN' })], pos: at6 }), 'ON_TRACK', 'the daily check-in alone does not count');
  assert.equal(board.groupOf({ ...base, profile: { status: 'INVITED' }, tasks: [], pos: at6 }), 'NOT_STARTED', 'not signed in yet');
  assert.equal(board.groupOf({ ...base, summary: { finished: true }, tasks: [], pos: { passed: 20, today: 21, started: true } }), 'FINISHED');
  assert.equal(board.groupMeaning('URGENT', false), '2 or more working days late. Your admin has been told.');
  assert.equal(board.groupMeaning('URGENT', true), '2 or more working days late. Admins have been told.');
});

test('everything going on in one line, and the one next step with its button', () => {
  const t = (key, day, kind, owner, extra = {}) => ({ key, day, kind, owner, doneAt: null, title: kind, ...extra });
  const cal = np.calendarOf({ startDate: '2026-10-19', startDay: 1, workDaysJson: '[1,2,3,4,5]' });
  const profile = { status: 'ACTIVE', fullName: 'Kevin Walsh' };
  const pos = { passed: 5, today: 6, started: true };
  const late = [
    t('step:a', 4, 'SIGN_OFF', 'SUPERVISOR', { system: 'Dialpad', title: 'Sign off Dialpad: hold, transfer' }),
    t('step:b', 4, 'SIGN_OFF', 'SUPERVISOR', { system: 'CRM', title: 'Sign off CRM' }),
    t('step:c', 5, 'REVIEW', 'SUPERVISOR', { title: 'Week 1 review' }),
    t('calls:4', 4, 'CALLS', 'AGENT', { target: 2 }),
  ];
  const today = [t('checkin:6', 6, 'CHECK_IN', 'SUPERVISOR', { title: 'Daily check-in' }), t('step:d', 6, 'DEMO', 'SUPERVISOR', { system: 'EGF', title: 'EGF: search and quote' })];
  const ctx = { tasks: [...late, ...today], pos, cal, profile, report: { averageAccuracy: 86.6 } };
  assert.equal(board.goingOnOf(ctx), 'Dialpad and CRM sign-offs 2d late · Week 1 review 1d late · calls short on 1 day · calls 87%');
  assert.deepEqual(board.nextStepOf(ctx), { task: late[0], text: 'Sign off Dialpad', action: 'Sign off', link: false });
  assert.equal(board.maxLateOf(ctx.tasks, pos), 2);
  const calm = { ...ctx, tasks: today };
  assert.equal(board.goingOnOf(calm), 'Today: EGF demo · calls 87%');
  assert.equal(board.nextStepOf(calm).text, 'EGF: search and quote', 'something specific before the daily check-in');
  assert.equal(board.nextStepOf({ ...ctx, tasks: [late[3]] }).text, 'Remind Kevin about calls', 'nothing waiting on the supervisor');
  assert.equal(board.nextStepOf({ ...ctx, tasks: [late[2]] }).action, 'Write review');
  assert.equal(board.goingOnOf({ ...ctx, tasks: [], pos: { passed: 0, today: null, started: false } }), 'Starts Mon 19 Oct');
});

test('the supervisor\'s list: overdue first, then today; only what a supervisor does or confirms', () => {
  const agent = (name, tasks, pos) => ({ profile: { fullName: name }, tasks, pos });
  const list = board.supervisorTasksOf([
    agent('B', [{ id: 1, day: 6, owner: 'SUPERVISOR', kind: 'DEMO', minutes: 30 }, { id: 2, day: 6, owner: 'AGENT', kind: 'TRAINING', courseId: 'c' }, { id: 3, day: 6, owner: 'AGENT', kind: 'AGENT_TASK', minutes: 10 }], { passed: 5, today: 6 }),
    agent('A', [{ id: 4, day: 2, owner: 'SUPERVISOR', kind: 'SIGN_OFF' }, { id: 5, day: 4, owner: 'SUPERVISOR', kind: 'CHECK_IN' }, { id: 6, day: 1, owner: 'SUPERVISOR', kind: 'DEMO', doneAt: new Date() }], { passed: 5, today: 6 }),
  ]);
  assert.deepEqual(list.late.map((r) => r.task.id), [4, 5], 'most overdue first');
  assert.deepEqual(list.today.map((r) => r.task.id), [1, 3], 'the agent\'s own task to confirm, not their training');
  assert.equal(list.minutes, 40);
  assert.equal(board.duration(130), '2 h 10 min');
});

test('a Supervisor\'s board: one line per agent in their group, everything going on, the next step; chips by group', async () => {
  const page = await as('kamola').get('/new-agents');
  assert.equal(page.status, 200);
  assert.match(page.text, /class="tab-link active" href="\/new-agents"/);
  assert.doesNotMatch(page.text, new RegExp(`data-na-agent="${people.jasur.p.id}"`));
  assert.doesNotMatch(page.text, new RegExp(`data-na-agent="${people.dilnoza.p.id}"`));
  const groupOfRow = (html, id) => { const at = html.indexOf(`data-na-agent="${id}"`); assert.ok(at > 0, 'the agent has a line'); return [...html.slice(0, at).matchAll(/data-na-group="(\w+)"/g)].pop()[1]; };
  assert.equal(groupOfRow(page.text, people.aziz.p.id), 'URGENT');
  assert.equal(groupOfRow(page.text, people.malika.p.id), 'NEEDS_YOU', 'day 1: things wait on the supervisor today');
  const line = (id) => page.text.slice(page.text.indexOf(`data-na-agent="${id}"`)).split('data-na-agent=')[1];
  assert.match(line(people.aziz.p.id), /Dialpad and CRM sign-offs 2d late · Set their working days 5d late · /);
  assert.match(line(people.aziz.p.id), /calls short on 5 days/);
  assert.match(line(people.aziz.p.id), /class="na-line__late">5d</);
  assert.match(line(people.aziz.p.id), new RegExp(`href="/new-agents/${people.aziz.p.id}#working-days">Set working days<`));
  assert.match(line(people.aziz.p.id), /Travel Agent · hired \d+ \w+ · day 6 of 20/);
  assert.match(page.text, /All <span class="na-fchip__n">2<\/span>/);
  assert.match(page.text, /na-fchip na-fchip--urgent" href="\/new-agents\?group=URGENT"><span class="na-dot" aria-hidden="true"><\/span>Urgent <span class="na-fchip__n">1</);
  assert.match(page.text, /na-fchip na-fchip--done is-empty" aria-disabled="true">/);
  assert.match(page.text, /2 or more working days late\. Your admin has been told\./);
  assert.doesNotMatch(page.text, /What you need to do/, 'no separate task lists any more');
  const urgent = await as('kamola').get('/new-agents?group=URGENT');
  assert.match(urgent.text, new RegExp(`data-na-agent="${people.aziz.p.id}"`));
  assert.doesNotMatch(urgent.text, new RegExp(`data-na-agent="${people.malika.p.id}"`));
  assert.equal((await as('bobur').get(`/new-agents/${people.aziz.p.id}`)).status, 404, 'another supervisor\'s agent');
  const agentPage = await as('kamola').get(`/new-agents/${people.aziz.p.id}`);
  assert.equal(agentPage.status, 200);
  assert.match(agentPage.text, /<dt>What's going on<\/dt><dd>Dialpad and CRM sign-offs 2d late/);
  assert.match(agentPage.text, /<dt>Next step<\/dt><dd>Set their working days<\/dd>/);
  assert.equal((await as('aziz').get('/new-agents')).status, 403);
  assert.equal((await as('aziz').get(`/new-agents/${people.aziz.p.id}`)).status, 403);
});

test('an Admin sees everyone, is told who has no supervisor, and can narrow it to one supervisor', async () => {
  const page = await as('admin').get('/new-agents');
  for (const k of ['aziz', 'malika', 'jasur', 'dilnoza']) assert.match(page.text, new RegExp(`data-na-agent="${people[k].p.id}"`));
  assert.match(page.text, /1 new agent has no supervisor/);
  assert.match(page.text, /2 or more working days late\. Admins have been told\./);
  assert.match(page.text, /Travel Agent · hired \d+ \w+ · day 6 of 20 · Kamola Tester/, 'an Admin sees whose agent it is');
  const one = await as('admin').get(`/new-agents?supervisor=${people.bobur.p.id}`);
  assert.match(one.text, new RegExp(`data-na-agent="${people.jasur.p.id}"`));
  assert.doesNotMatch(one.text, new RegExp(`data-na-agent="${people.aziz.p.id}"`));
  const none = await as('admin').get('/new-agents?supervisor=none');
  assert.match(none.text, new RegExp(`data-na-agent="${people.dilnoza.p.id}"`));
});

test('ticking from the board: done once, by that supervisor; items that tick themselves cannot be ticked by hand', async () => {
  const welcome = await taskOf('malika', { title: { startsWith: 'Welcome 1:1' } });
  const done = await as('kamola').form(`/new-agents/${people.malika.p.id}/tasks/${welcome.id}/done`, { from: 'board' });
  assert.equal(done.headers.location, `/new-agents#agent-${people.malika.p.id}`, 'back to the agent\'s line');
  const row = await prisma.agentProgramTask.findUnique({ where: { id: welcome.id } });
  assert.ok(row.doneAt); assert.equal(row.doneById, people.kamola.p.id);
  await as('kamola').form(`/new-agents/${people.malika.p.id}/tasks/${welcome.id}/done`, { from: 'board' });
  assert.equal((await prisma.agentProgramTask.findUnique({ where: { id: welcome.id } })).doneAt.getTime(), row.doneAt.getTime(), 'a second tap changes nothing');
  const schedule = await taskOf('malika', { kind: 'SCHEDULE' });
  const refused = await as('kamola').form(`/new-agents/${people.malika.p.id}/tasks/${schedule.id}/done`, {});
  assert.match(decodeURIComponent(refused.headers.location), /ticks itself/);
  assert.equal((await as('bobur').form(`/new-agents/${people.malika.p.id}/tasks/${welcome.id}/undo`, {})).status, 404);
});

test('a sign-off with what was watched; a review needs a verdict and a line, and "Extend a week" adds 5 days; undo takes it back', async () => {
  const signOff = await taskOf('aziz', { kind: 'SIGN_OFF', system: 'Dialpad' });
  await as('kamola').form(`/new-agents/${people.aziz.p.id}/tasks/${signOff.id}/done`, { note: 'Transfers confidently' });
  const page = await as('kamola').get(`/new-agents/${people.aziz.p.id}`);
  assert.match(page.text, /Dialpad<\/span><span class="na-meta">\d+ \w+, by you/);
  assert.match(page.text, /Transfers confidently/);

  const review = await taskOf('aziz', { kind: 'REVIEW', title: 'Week 1 review' });
  assert.match(decodeURIComponent((await as('kamola').form(`/new-agents/${people.aziz.p.id}/tasks/${review.id}/done`, { note: 'Fine' })).headers.location), /Choose how the week went/);
  assert.match(decodeURIComponent((await as('kamola').form(`/new-agents/${people.aziz.p.id}/tasks/${review.id}/done`, { verdict: 'BEHIND' })).headers.location), /Write a line/);
  await as('kamola').form(`/new-agents/${people.aziz.p.id}/tasks/${review.id}/done`, { verdict: 'EXTEND', note: 'Needs more time on the systems' });
  assert.equal((await prisma.agentProgram.findUnique({ where: { id: programs.aziz.id } })).extraDays, 5);
  const longer = await as('kamola').get(`/new-agents/${people.aziz.p.id}`);
  assert.match(longer.text, /data-na-week="5"/, 'an extra week appears');
  assert.match(longer.text, /Week 1 review · Extend a week/);

  await as('kamola').form(`/new-agents/${people.aziz.p.id}/tasks/${review.id}/undo`, {});
  assert.equal((await prisma.agentProgram.findUnique({ where: { id: programs.aziz.id } })).extraDays, 0);
  assert.equal((await prisma.agentProgramTask.findUnique({ where: { id: review.id } })).doneAt, null);
  const auto = await taskOf('aziz', { kind: 'CALLS', day: 1 });
  assert.match(decodeURIComponent((await as('kamola').form(`/new-agents/${people.aziz.p.id}/tasks/${auto.id}/undo`, {})).headers.location), /Only an item somebody ticked/);
});

test('working days and days off, set by the supervisor: setting them ticks their first item; a day off is not a working day', async () => {
  assert.match(decodeURIComponent((await as('kamola').form(`/new-agents/${people.malika.p.id}/working-days`, {})).headers.location), /at least one working day/);
  await as('kamola').form(`/new-agents/${people.malika.p.id}/working-days`, { days: ['1', '2', '3', '4', '5', '6', '7'] });
  await as('kamola').get('/new-agents');
  assert.ok((await taskOf('malika', { kind: 'SCHEDULE' })).doneAt, 'the "Set their working days" item ticked itself');

  await as('kamola').form(`/new-agents/${people.aziz.p.id}/days-off`, { date: today });
  let page = await as('kamola').get(`/new-agents/${people.aziz.p.id}`);
  assert.match(page.text, /na-daysoff__list">\s*<li>/);
  assert.match((await as('kamola').get('/new-agents')).text, /Travel Agent · hired \d+ \w+ · day off today/);
  await as('kamola').form(`/new-agents/${people.aziz.p.id}/days-off`, { date: today, remove: '1' });
  page = await as('kamola').get(`/new-agents/${people.aziz.p.id}`);
  assert.match(page.text, /Day 6 · today/);
  assert.match(decodeURIComponent((await as('kamola').form(`/new-agents/${people.aziz.p.id}/days-off`, { date: '2020-01-01' })).headers.location), /inside the program/);
});

test('notes, extending a week by hand, and the "First month" tab on the employee record', async () => {
  await as('kamola').form(`/new-agents/${people.aziz.p.id}/notes`, { body: 'Booked extra EGF time for Monday.' });
  assert.equal(await prisma.coachingNote.count({ where: { profileId: people.aziz.p.id, authorId: people.kamola.p.id } }), 1);
  assert.match((await as('kamola').get(`/new-agents/${people.aziz.p.id}`)).text, /Booked extra EGF time for Monday\./);
  await as('kamola').form(`/new-agents/${people.aziz.p.id}/extend`, {});
  assert.equal((await prisma.agentProgram.findUnique({ where: { id: programs.aziz.id } })).extraDays, 5);

  assert.match((await as('kamola').get(`/employees/${people.aziz.p.id}/training`)).text, new RegExp(`href="/new-agents/${people.aziz.p.id}">First month<`));
  assert.doesNotMatch((await as('aziz').get(`/employees/${people.aziz.p.id}/training`)).text, /First month/, 'not for the agent');
  assert.match((await as('kamola').get(`/team/${people.aziz.p.id}`)).text, /First month/);
});

test('a stopped program is shown as it was, with nothing to tick', async () => {
  await prisma.agentProgram.update({ where: { id: programs.jasur.id }, data: { status: 'STOPPED', stoppedAt: new Date() } });
  const page = await as('bobur').get(`/new-agents/${people.jasur.p.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /This program was stopped/);
  assert.doesNotMatch(page.text, /\/tasks\/[^/]+\/done/);
  assert.doesNotMatch((await as('bobur').get('/new-agents')).text, new RegExp(`data-na-agent="${people.jasur.p.id}"`));
  const t = await taskOf('jasur', { kind: 'DEMO' });
  assert.equal((await as('bobur').form(`/new-agents/${people.jasur.p.id}/tasks/${t.id}/done`, {})).status, 404);
});
