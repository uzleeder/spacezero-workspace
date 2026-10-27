'use strict';
// New Agent Program, step 1 (lib/newAgentPlan.js, lib/newAgentProgram.js, routes/admin/newAgentProgram.js): the plan,
// the agent's own working days, the tasks copied from the plan, what ticks itself from real data, the automatic start,
// plan edits reaching the days still ahead, the Call Practice ramp, and the Admin's page.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

mock.method(require('../lib/gemini'), 'generateStructured', async () => { throw new Error('Gemini must not be called in these tests'); });

const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const plans = require('../lib/newAgentPlan');
const np = require('../lib/newAgentProgram');
const app = require('../server');

const at = (iso) => new Date(iso);
const MON = '2026-10-19'; // day 1 of the agent's program in these tests (a Monday)
const WED = at('2026-10-21T10:00:00+05:00'); // day 3
const SAT = at('2026-10-24T10:00:00+05:00'); // day off
const NEXT_MON = at('2026-10-26T10:00:00+05:00'); // day 6
const cal = (over = {}) => np.calendarOf({ startDate: MON, startDay: 1, workDaysJson: '[1,2,3,4,5]', daysOffJson: '[]', ...over });

let org; const people = {};
const as = (who) => ({
  get: (url) => request(app).get(url).set('Cookie', people[who].cookie),
  form: (url, body) => request(app).post(url).set('Cookie', people[who].cookie).type('form').send(body),
});
const tasksOf = (programId) => prisma.agentProgramTask.findMany({ where: { programId }, orderBy: [{ day: 'asc' }, { createdAt: 'asc' }] });

before(async () => {
  org = await prisma.organization.create({ data: { name: 'New Agent Program tests' } });
  await prisma.tenureBand.create({ data: { organizationId: org.id, label: 'New Agent', minMonths: 0, maxMonths: 3, displayOrder: 1 } });
  const mk = async (key, role, start, extra = {}) => {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `NAP ${key}`, username: `nap_${org.id}_${key}`, email: `nap_${org.id}_${key}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: start, ...extra } });
    const token = generateToken();
    await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
    people[key] = { p, cookie: `sz_session=${token.raw}` };
  };
  await mk('admin', 'ADMIN', at('2025-01-01T00:00:00Z'));
  await mk('supervisor', 'SUPERVISOR', at('2025-01-01T00:00:00Z'));
  await mk('agent', 'TRAVEL_AGENT', at(`${MON}T00:00:00Z`));
  await mk('older', 'FLIGHT_EXPERT', new Date(Date.now() - 30 * 86400000)); // a month in: an Admin starts it at the right day
  await mk('veteran', 'TRAVEL_AGENT', at('2025-03-01T00:00:00Z'));
  await mk('tester', 'TRAVEL_AGENT', at(`${MON}T00:00:00Z`), { testOwnerAdminId: null });
  await prisma.supervisorAssignment.create({ data: { supervisorId: people.supervisor.p.id, agentId: people.agent.p.id } });
});
after(async () => { mock.restoreAll(); await prisma.$disconnect(); });

test('working days: day N is the agent\'s Nth working day; days off and vacation do not count', () => {
  assert.deepEqual(np.positionOn(cal(), '2026-10-21'), { passed: 2, today: 3, started: true });
  assert.deepEqual(np.positionOn(cal(), '2026-10-24'), { passed: 5, today: null, started: true }, 'Saturday: not a working day');
  assert.deepEqual(np.positionOn(cal(), '2026-10-26'), { passed: 5, today: 6, started: true });
  assert.deepEqual(np.positionOn(cal(), '2026-10-18'), { passed: 0, today: null, started: false });
  assert.equal(np.positionOn(cal({ daysOffJson: '["2026-10-21"]' }), '2026-10-26').today, 5, 'a day off pushes everything one day');
  assert.equal(np.positionOn(np.calendarOf({ startDate: MON, startDay: 1, workDaysJson: '[1,2,3,4,5]' }, ['2026-10-20', '2026-10-21']), '2026-10-26').today, 4, 'approved vacation too');
  assert.equal(np.positionOn(cal({ workDaysJson: '[2,3,4,5,6]' }), '2026-10-24').today, 5, 'a Tuesday-to-Saturday shift works Saturday');
  assert.equal(np.dateOfDay(cal(), 6), '2026-10-26');
  assert.equal(np.dateOfDay(cal({ startDay: 8 }), 8), MON, 'started mid-month: the first day is that day number');
  assert.equal(np.dateOfDay(cal({ startDay: 8 }), 3), null);
  assert.equal(np.workDaysLabel([1, 2, 3, 4, 5]), 'Mon–Fri');
  assert.equal(np.workDaysLabel([2, 3, 4, 5, 6]), 'Tue–Sat');
  assert.equal(np.workDaysLabel([1, 3, 5]), 'Mon, Wed, Fri');
});

test('the ready-made plan: 4 weeks, 7 sign-offs, the 7 training videos you are making, calls ramping 2 to 5', () => {
  const steps = plans.DEFAULT_STEPS.map(([dayOffset, kind, title, minutes, system, howTo], i) => ({ id: `s${i}`, dayOffset, kind, title, minutes, system, howTo }));
  assert.deepEqual(steps.filter((s) => s.kind === 'SIGN_OFF').map((s) => s.system).sort(), ['CRM', 'Cockpit', 'Dialpad', 'EGF', 'GDS', 'Oracle', 'Ovago']);
  assert.deepEqual(steps.filter((s) => s.kind === 'TRAINING').map((s) => s.system).sort(), ['CRM', 'Cockpit', 'EGF', 'GDS', 'Gmail', 'Google Flights', 'Ovago']);
  const plan = { lengthDays: 20, dailyCheckIn: true, callsPerWeekJson: '[2,3,4,5]', steps };
  const tasks = np.tasksFromPlan(plan);
  const calls = tasks.filter((t) => t.kind === 'CALLS');
  assert.equal(calls.length, 20);
  assert.deepEqual([1, 6, 11, 16].map((d) => calls.find((t) => t.day === d).target), [2, 3, 4, 5]);
  const checkins = tasks.filter((t) => t.key.startsWith('checkin:')).map((t) => t.day);
  for (const d of [1, 5, 10, 15, 20]) assert.ok(!checkins.includes(d), `day ${d} already has a check-in or review`);
  assert.ok(checkins.includes(2) && checkins.includes(19));
  const late = np.tasksFromPlan(plan, { startDay: 8 });
  assert.ok(late.filter((t) => t.stepId).every((t) => t.day >= 8), 'started mid-month: earlier items fall due on the first day');
  assert.equal(late.find((t) => t.kind === 'SCHEDULE').day, 8);
  assert.equal(late.filter((t) => t.kind === 'CALLS').length, 13);
});

test('task states: done, waiting for a video, late, today, upcoming', () => {
  const pos = { passed: 5, today: 6, started: true };
  assert.equal(np.stateOf({ day: 1, kind: 'DEMO', doneAt: new Date() }, pos), 'DONE');
  assert.equal(np.stateOf({ day: 2, kind: 'TRAINING', courseId: null }, pos), 'WAITING');
  assert.equal(np.stateOf({ day: 4, kind: 'SIGN_OFF' }, pos), 'LATE');
  assert.equal(np.daysLate({ day: 4 }, pos), 2);
  assert.equal(np.stateOf({ day: 6, kind: 'CHECK_IN' }, pos), 'TODAY');
  assert.equal(np.stateOf({ day: 7, kind: 'DEMO' }, pos), 'UPCOMING');
  assert.equal(np.stateOf({ day: 6, kind: 'DEMO' }, { passed: 5, today: null, started: true }), 'UPCOMING', 'a day off: nothing is due today');
});

let program;
test('it starts by itself for a new agent from their first day; never for older staff, supervisors or test accounts', async () => {
  program = await np.autoStart(people.agent.p, { now: WED });
  assert.ok(program);
  assert.equal(program.startDate, MON); assert.equal(program.startDay, 1);
  const plan = await plans.findPlan(org.id);
  assert.ok(plan.program && plan.isActive && plan.createdById === people.admin.p.id, 'the ready-made plan was created');
  const tasks = await tasksOf(program.id);
  assert.equal(tasks.filter((t) => t.stepId).length, plan.steps.length);
  assert.equal(tasks.filter((t) => t.kind === 'CALLS').length, 20);
  assert.equal(await np.autoStart(people.agent.p, { now: WED }), null, 'once');
  assert.equal(await np.autoStart(people.veteran.p, { now: WED }), null);
  assert.equal(await np.autoStart(people.supervisor.p, { now: WED }), null);
  assert.equal(await np.autoStart({ ...people.tester.p, testOwnerAdminId: people.admin.p.id }, { now: WED }), null);
});

test('what ticks itself: working days set, the day\'s calls; the rest waits, and is late once its day is behind', async () => {
  let state = await np.refresh(program.id, { now: WED });
  assert.equal(state.pos.today, 3);
  const byKey = (k) => state.tasks.find((t) => t.key === k);
  const welcome = state.tasks.find((t) => t.title.startsWith('Welcome 1:1'));
  assert.equal(np.stateOf(welcome, state.pos), 'LATE');
  assert.equal(np.daysLate(welcome, state.pos), 2);
  assert.equal(np.stateOf(state.tasks.find((t) => t.title === 'Gmail training video'), state.pos), 'WAITING', 'the video is not made yet');

  await prisma.agentProgram.update({ where: { id: program.id }, data: { workDaysConfirmedAt: at('2026-10-19T09:00:00+05:00') } });
  const call = await prisma.practiceCall.create({ data: { organizationId: org.id, title: 'A call', storagePath: 'call-practice/x.mp3', mimeType: 'audio/mpeg', durationSeconds: 30, referenceText: 'Agent: hello', referenceStatus: 'READY', createdById: people.admin.p.id } });
  const call2 = await prisma.practiceCall.create({ data: { organizationId: org.id, title: 'Another call', storagePath: 'call-practice/y.mp3', mimeType: 'audio/mpeg', durationSeconds: 30, referenceText: 'Agent: hello', referenceStatus: 'READY', createdById: people.admin.p.id } });
  await prisma.practiceCallTranscript.create({ data: { profileId: people.agent.p.id, callId: call.id, submittedAt: at('2026-10-19T11:00:00+05:00'), submittedText: 'x' } });
  await prisma.practiceCallTranscript.create({ data: { profileId: people.agent.p.id, callId: call2.id, submittedAt: at('2026-10-19T15:30:00+05:00'), submittedText: 'x' } });
  state = await np.refresh(program.id, { now: WED });
  assert.equal(byKey('calls:1') && state.tasks.find((t) => t.key === 'calls:1').doneAt.toISOString(), at('2026-10-19T15:30:00+05:00').toISOString(), 'day 1: 2 of 2 calls, done at the second');
  assert.equal(state.tasks.find((t) => t.key === 'calls:2').doneAt, null);
  assert.ok(state.tasks.find((t) => t.kind === 'SCHEDULE').doneAt, 'working days set');
  assert.equal(state.summary.late > 0, true);
});

test('a training reaches My Training on its day, due that evening, and ticks when finished; a standard ticks when confirmed', async () => {
  const course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'EGF basics', createdById: people.admin.p.id, status: 'PUBLISHED', publishedVersion: 1 } });
  const plan = await plans.findPlan(org.id);
  const egf = plan.steps.find((s) => s.title === 'EGF training video');
  await prisma.developmentPathStep.update({ where: { id: egf.id }, data: { courseId: course.id } });
  let state = await np.refresh(program.id, { now: WED });
  assert.equal(await prisma.trainingAssignmentRecipient.count({ where: { profileId: people.agent.p.id } }), 0, 'not before day 6');
  assert.equal(state.tasks.find((t) => t.key === `step:${egf.id}`).courseId, course.id, 'the video attached later reaches the days still ahead');

  state = await np.refresh(program.id, { now: NEXT_MON });
  assert.equal(state.pos.today, 6);
  const recipient = await prisma.trainingAssignmentRecipient.findFirst({ where: { profileId: people.agent.p.id }, include: { assignment: true } });
  assert.ok(recipient, 'assigned on day 6');
  assert.equal(recipient.assignment.dueDate.toISOString(), at('2026-10-26T23:59:59+05:00').toISOString());
  assert.equal(await prisma.notification.count({ where: { profileId: people.agent.p.id, type: 'training.assigned' } }), 1);
  await np.refresh(program.id, { now: NEXT_MON });
  assert.equal(await prisma.trainingAssignmentRecipient.count({ where: { profileId: people.agent.p.id } }), 1, 'once');

  await prisma.trainingAttempt.create({ data: { recipientId: recipient.id, profileId: people.agent.p.id, status: 'COMPLETED', attemptNumber: 2, completedAt: at('2026-10-26T14:00:00+05:00') } });
  state = await np.refresh(program.id, { now: NEXT_MON });
  assert.equal(state.tasks.find((t) => t.key === `step:${egf.id}`).doneAt.toISOString(), at('2026-10-26T14:00:00+05:00').toISOString());

  const item = await prisma.standardsItem.create({ data: { organizationId: org.id, contentType: 'STANDARD', title: 'Refund rules', createdById: people.admin.p.id } });
  const version = await prisma.standardsVersion.create({ data: { itemId: item.id, version: 1, status: 'PUBLISHED', createdById: people.admin.p.id } });
  const read = await prisma.developmentPathStep.create({ data: { pathId: plan.id, dayOffset: 8, kind: 'READ', owner: 'AGENT', title: 'Read: Refund rules', standardId: item.id } });
  await prisma.standardsAcknowledgement.create({ data: { itemId: item.id, versionId: version.id, profileId: people.agent.p.id, acceptedAt: at('2026-10-26T09:00:00+05:00') } });
  state = await np.refresh(program.id, { now: NEXT_MON });
  assert.ok(state.tasks.find((t) => t.key === `step:${read.id}`).doneAt, 'a new item for a day ahead appears, and ticks from the confirmation');
});

test('plan edits reach only the days still ahead; today and the past stay as they were', async () => {
  const plan = await plans.findPlan(org.id);
  const welcome = plan.steps.find((s) => s.title.startsWith('Welcome 1:1'));
  const gds = plan.steps.find((s) => s.title === 'GDS basics');
  await prisma.developmentPathStep.update({ where: { id: welcome.id }, data: { title: 'Renamed welcome' } });
  await prisma.developmentPathStep.delete({ where: { id: gds.id } });
  await prisma.developmentPathStep.create({ data: { pathId: plan.id, dayOffset: 12, kind: 'DEMO', owner: 'SUPERVISOR', title: 'New demo on day 12' } });
  await prisma.developmentPathStep.create({ data: { pathId: plan.id, dayOffset: 2, kind: 'DEMO', owner: 'SUPERVISOR', title: 'New demo on day 2' } });
  const state = await np.refresh(program.id, { now: NEXT_MON });
  const titles = state.tasks.map((t) => t.title);
  assert.ok(titles.some((t) => t.startsWith('Welcome 1:1')) && !titles.includes('Renamed welcome'), 'day 1 is behind them');
  assert.ok(!titles.includes('GDS basics'), 'removed from day 9');
  assert.ok(titles.includes('New demo on day 12'));
  assert.ok(!titles.includes('New demo on day 2'), 'day 2 is behind them');
});

test('Call Practice follows the program week: 3 calls a day in week 2, the setting on a day off', async () => {
  assert.equal(await np.callsQuota(people.agent.p, NEXT_MON), 3);
  assert.equal(await np.callsQuota(people.agent.p, WED), 2);
  assert.equal(await np.callsQuota(people.agent.p, SAT), null);
  assert.equal((await require('../lib/callPractice').stateFor(people.agent.p, NEXT_MON)).plan.perDay, 3);
  assert.equal((await require('../lib/callPractice').stateFor(people.agent.p, SAT)).plan.perDay, 2, 'the organization setting');
});

test('the older onboarding paths never run the program plan', async () => {
  const before = await prisma.developmentRecommendation.count({ where: { organizationId: org.id } });
  await require('../lib/automation').runPaths(org.id, NEXT_MON);
  assert.equal(await prisma.developmentRecommendation.count({ where: { organizationId: org.id } }), before);
});

test('Admin page: who is in it, the plan by day, add / change / remove an item; Supervisors cannot open it', async () => {
  assert.match((await as('admin').get('/admin/training')).text, /href="\/admin\/new-agent-program">New Agent Program</);
  assert.doesNotMatch((await as('supervisor').get('/admin/training')).text, /new-agent-program/);
  assert.equal((await as('supervisor').get('/admin/new-agent-program')).status, 403);
  const page = await as('admin').get('/admin/new-agent-program');
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`data-nap-person="${people.agent.p.id}"`));
  assert.match(page.text, /supervisor NAP supervisor/);
  assert.match(page.text, /Week 2 · Systems hands-on/);
  assert.match(page.text, /Sign off Cockpit: a test booking on their own/);
  assert.match(page.text, /video coming/);
  assert.match(page.text, /NAP older · first day/, 'someone a month in can be started');

  const bad = await as('admin').form('/admin/new-agent-program/items', { day: '40', kind: 'DEMO', title: 'x' });
  assert.match(decodeURIComponent(bad.headers.location), /An item needs a day/);
  const added = await as('admin').form('/admin/new-agent-program/items', { day: '14', kind: 'SIGN_OFF', title: 'Sign off Gmail', system: 'Gmail', minutes: '10' });
  assert.equal(added.headers.location, '/admin/new-agent-program?added=1#day-14');
  const step = await prisma.developmentPathStep.findFirst({ where: { title: 'Sign off Gmail' } });
  assert.equal(step.owner, 'SUPERVISOR'); assert.equal(step.system, 'Gmail'); assert.equal(step.minutes, 10);
  assert.equal((await as('admin').get(`/admin/new-agent-program/items/${step.id}`)).status, 200);
  await as('admin').form(`/admin/new-agent-program/items/${step.id}`, { day: '15', kind: 'SIGN_OFF', title: 'Sign off Gmail and Google Flights', system: 'Gmail' });
  assert.equal((await prisma.developmentPathStep.findUnique({ where: { id: step.id } })).dayOffset, 15);
  await as('admin').form(`/admin/new-agent-program/items/${step.id}/delete`, {});
  assert.equal(await prisma.developmentPathStep.findUnique({ where: { id: step.id } }), null);
  const read = await as('admin').form('/admin/new-agent-program/items', { day: '3', kind: 'READ', title: 'Read something' });
  assert.match(decodeURIComponent(read.headers.location), /Choose the standard to read/);
});

test('Admin: settings, starting someone a month in at the right day, their working days, and stopping', async () => {
  assert.equal((await as('admin').form('/admin/new-agent-program/settings', { calls1: '1', calls2: '2', calls3: '3', calls4: '4', week1: 'Week one', week2: '', week3: '', week4: '', dailyCheckIn: '1', isActive: '1' })).headers.location, '/admin/new-agent-program?saved=1');
  let plan = await plans.findPlan(org.id);
  assert.deepEqual(plans.callsPerWeek(plan), [1, 2, 3, 4]);
  assert.equal(plans.weekTitles(plan)[0], 'Week one');
  assert.match(decodeURIComponent((await as('admin').form('/admin/new-agent-program/settings', { calls1: '9', calls2: '2', calls3: '3', calls4: '4' })).headers.location), /Calls a day are a number from 1 to 5/);

  assert.equal((await as('admin').form('/admin/new-agent-program/start', { profileId: people.older.p.id, startDay: '8' })).headers.location, '/admin/new-agent-program?started=1');
  const older = await prisma.agentProgram.findUnique({ where: { profileId: people.older.p.id }, include: { tasks: true } });
  assert.equal(older.startDay, 8); assert.equal(older.startedById, people.admin.p.id);
  assert.equal(older.tasks.find((t) => t.kind === 'SCHEDULE').day, 8, 'earlier items fall due on the first day');
  assert.match(decodeURIComponent((await as('admin').form('/admin/new-agent-program/start', { profileId: people.older.p.id, startDay: '8' })).headers.location), /already in the program/);

  assert.equal((await as('admin').get(`/admin/new-agent-program/agents/${people.older.p.id}/days`)).status, 200);
  assert.equal((await as('admin').form(`/admin/new-agent-program/agents/${people.older.p.id}/days`, {})).headers.location, `/admin/new-agent-program/agents/${people.older.p.id}/days?error=none`);
  assert.equal((await as('admin').form(`/admin/new-agent-program/agents/${people.older.p.id}/days`, { days: ['2', '3', '4', '5', '6'] })).headers.location, '/admin/new-agent-program?days=1');
  const set = await prisma.agentProgram.findUnique({ where: { profileId: people.older.p.id }, include: { tasks: true } });
  assert.equal(set.workDaysJson, '[2,3,4,5,6]');
  assert.ok(set.tasks.find((t) => t.kind === 'SCHEDULE').doneAt, 'setting the working days ticks the supervisor\'s first task');
  assert.match((await as('admin').get('/admin/new-agent-program')).text, /Tue–Sat/);

  await as('admin').form(`/admin/new-agent-program/agents/${people.older.p.id}/stop`, {});
  assert.equal((await prisma.agentProgram.findUnique({ where: { profileId: people.older.p.id } })).status, 'STOPPED');

  await as('admin').form('/admin/new-agent-program/settings', { calls1: '2', calls2: '3', calls3: '4', calls4: '5', dailyCheckIn: '1' }); // switched off
  plan = await plans.findPlan(org.id);
  assert.equal(plan.isActive, false);
  const fresh = await prisma.profile.create({ data: { organizationId: org.id, fullName: 'NAP fresh', username: `nap_${org.id}_fresh`, email: `nap_${org.id}_fresh@example.invalid`, role: 'TRAVEL_AGENT', status: 'INVITED', employmentStartDate: new Date() } });
  assert.equal(await np.autoStart(fresh), null, 'switched off: nothing starts by itself');
  await prisma.developmentPath.update({ where: { id: plan.id }, data: { isActive: true } });
  await require('../lib/onboarding').applyOnboarding(fresh);
  assert.ok(await prisma.agentProgram.findUnique({ where: { profileId: fresh.id } }), 'creating a new agent starts it (an invited account too)');
});

test('the automation stops the program of someone who left', async () => {
  await prisma.profile.update({ where: { id: people.agent.p.id }, data: { status: 'DISABLED' } });
  const out = await np.runPrograms(org.id, { now: NEXT_MON });
  assert.ok(out.stopped >= 1);
  assert.equal((await prisma.agentProgram.findUnique({ where: { profileId: people.agent.p.id } })).status, 'STOPPED');
});
