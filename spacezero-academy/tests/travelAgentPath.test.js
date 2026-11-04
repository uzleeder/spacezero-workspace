'use strict';
// The new Travel Agent path (lib/newAgentProgram.js onTravelPath, lib/newAgentBoard.js, lib/newAgentReminders.js):
// Before day 1, the ramp, the "Ready for solo live calls" gate, an owner for every item who is a real, active person
// (the admins cover a supervisor who is away), Today, the check that every hire is accounted for, Call Practice
// repeats, the admin checks (only an admin approves, confirms a supervisor's sign-off and takes a tick back; flags), the
// agent's own My Training as before the program - and Flight Experts exactly as before. The ramp is switched off for now
// (plans.SWITCHES): these tests switch it on to keep it working, and the last ones check Month 1 only.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

mock.method(require('../lib/gemini'), 'generateStructured', async () => { throw new Error('Gemini must not be called in these tests'); });

const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const plans = require('../lib/newAgentPlan');
const np = require('../lib/newAgentProgram');
const board = require('../lib/newAgentBoard');
const reminders = require('../lib/newAgentReminders');
const cp = require('../lib/callPractice');
const app = require('../server');

const today = np.addDays(require('../lib/callPractice').dayKey(new Date()), 0);
const ago = (n) => np.addDays(today, -n);
const EVERY_DAY = '[1,2,3,4,5,6,7]'; // the programs here work every day, so the tests do not depend on the weekday

let org; let plan; const people = {}; const programs = {};
const as = (who) => ({
  get: (url) => request(app).get(url).set('Cookie', people[who].cookie),
  form: (url, body) => request(app).post(url).set('Cookie', people[who].cookie).type('form').send(body),
});
const mk = async (key, role, extra = {}) => {
  const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `${key[0].toUpperCase()}${key.slice(1)} Tester`, username: `tap_${org.id}_${key}`, email: `tap_${org.id}_${key}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date(`${extra.start || '2025-01-01'}T00:00:00Z`), createdById: extra.createdById || null } });
  const token = generateToken();
  await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
  people[key] = { p, cookie: `sz_session=${token.raw}` };
  return p;
};
/** Starts a program whose day 1 was `daysAgo` calendar days ago, working every day. */
const run = async (key, daysAgo, supervisor = null) => {
  if (supervisor) await prisma.supervisorAssignment.create({ data: { supervisorId: people[supervisor].p.id, agentId: people[key].p.id } });
  const row = await np.startProgram(people[key].p, { startKey: ago(daysAgo), plan });
  programs[key] = await prisma.agentProgram.update({ where: { id: row.id }, data: { workDaysJson: EVERY_DAY, workDaysConfirmedAt: new Date() } });
  return programs[key];
};
/** Ticks everything of the agent's that is due by today, as a supervisor would (calls stay as the data says). */
const tickAll = async (key, by) => {
  const state = await np.refresh(programs[key].id);
  for (const t of state.tasks) if (!t.doneAt && t.kind !== 'CALLS' && t.day <= np.horizonOf(state.pos)) await prisma.agentProgramTask.update({ where: { id: t.id }, data: { doneAt: new Date(), doneById: people[by].p.id, resultJson: t.kind === 'REVIEW' ? '{"verdict":"ON_TRACK"}' : null } });
};
const calls = [];
const typed = async (key, accuracy, wpm, n = 10) => {
  for (let i = 0; i < n; i += 1) await prisma.practiceCallTranscript.create({ data: { profileId: people[key].p.id, callId: calls[i % calls.length].id, attempt: Math.floor(i / calls.length) + 1, submittedAt: new Date(Date.now() - (n - i) * 60000), submittedText: 'x', accuracy, wordsPerMinute: wpm } });
};

before(async () => {
  plans.SWITCHES.ramp = true;
  org = await prisma.organization.create({ data: { name: 'Travel Agent path tests' } });
  await prisma.tenureBand.create({ data: { organizationId: org.id, label: 'New Agent', minMonths: 0, maxMonths: 3, displayOrder: 1 } });
  await mk('admin', 'ADMIN');
  await mk('hirer', 'ADMIN');
  for (const k of ['sara', 'kamol']) await mk(k, 'SUPERVISOR');
  plan = await plans.ensurePlan(org.id);
  for (let i = 0; i < 2; i += 1) calls.push(await prisma.practiceCall.create({ data: { organizationId: org.id, title: `Call ${i + 1}`, storagePath: `call-practice/${i}.mp3`, mimeType: 'audio/mpeg', durationSeconds: 30, referenceText: 'Agent: hello there', referenceStatus: 'READY', createdById: people.admin.p.id, displayOrder: i } }));
});
after(async () => { plans.SWITCHES.ramp = false; mock.restoreAll(); await prisma.$disconnect(); });

test('the plan: a Travel Agent also has "Before day 1" (an Admin\'s) and the ramp; a Flight Expert keeps the 4 weeks', () => {
  const fe = np.tasksFromPlan(plan, {});
  const ta = np.tasksFromPlan(plan, { travel: true, prestart: true });
  assert.equal(fe.filter((t) => t.day === plans.PRESTART_DAY).length, 0);
  assert.equal(Math.max(...fe.map((t) => t.day)), 20, 'Flight Experts: 4 weeks, nothing after');
  const pre = ta.filter((t) => t.day === plans.PRESTART_DAY);
  assert.equal(pre.length, 9);
  assert.ok(pre.every((t) => t.owner === 'ADMIN'), 'every "Before day 1" item is an Admin\'s');
  assert.deepEqual(pre.filter((t) => t.kind === 'ACCOUNT').map((t) => t.system), ['Gmail', 'Dialpad', 'CRM', 'EGF', 'Ovago', 'Cockpit', 'GDS']);
  const ramp = ta.filter((t) => t.day > 20);
  assert.equal(ramp.filter((t) => t.kind === 'CALLS').length, 40);
  assert.ok(ramp.filter((t) => t.kind === 'CALLS').every((t) => t.target === 5), '5 calls a day in the ramp');
  assert.deepEqual(ramp.filter((t) => t.kind === 'REVIEW').map((t) => [t.key, t.day]), [1, 2, 3, 4, 5, 6, 7, 8].map((w) => [`ramp-review:${w}`, 20 + w * 5]), 'a review every ramp week');
  assert.equal(ramp.filter((t) => t.kind === 'CHECK_IN').length, 0, 'no daily check-in in the ramp');
  assert.equal(np.tasksFromPlan(plan, { travel: true }).filter((t) => t.day === 0).length, 0, 'someone already working has no pre-start');
});

test('"Before day 1" is due 2 of the agent\'s working days before day 1, and late by working days', () => {
  const cal = np.calendarOf({ startDate: '2026-11-02', startDay: 1, workDaysJson: '[1,2,3,4,5]' }); // a Monday
  assert.deepEqual(np.prestartOf(cal, '2026-10-29'), { dueKey: '2026-10-29', late: 0, today: true }, 'Thursday');
  assert.equal(np.prestartOf(cal, '2026-10-30').late, 1);
  assert.equal(np.prestartOf(cal, '2026-11-02').late, 2, 'the weekend does not count');
  const pos = np.placeOf(cal, '2026-10-30');
  assert.equal(np.stateOf({ day: 0, doneAt: null, kind: 'ADMIN_TASK' }, pos), 'LATE');
  assert.equal(np.daysLate({ day: 0, doneAt: null, kind: 'ADMIN_TASK' }, pos), 1);
});

test('a Travel Agent hired ahead of day 1 gets "Before day 1"; an account ticks itself from the vault; a new start date moves it', async () => {
  const start = np.addDays(today, 6);
  const pre = await mk('pre', 'TRAVEL_AGENT', { start, createdById: people.hirer.p.id });
  await prisma.supervisorAssignment.create({ data: { supervisorId: people.sara.p.id, agentId: pre.id } });
  programs.pre = await np.autoStart(pre);
  const fe = await mk('expert', 'FLIGHT_EXPERT', { start });
  programs.expert = await np.autoStart(fe);
  const tasks = await prisma.agentProgramTask.findMany({ where: { programId: programs.pre.id, day: 0 } });
  assert.equal(tasks.length, 9);
  assert.equal(await prisma.agentProgramTask.count({ where: { programId: programs.expert.id, OR: [{ day: 0 }, { day: { gt: 20 } }] } }), 0, 'a Flight Expert: no pre-start, no ramp');

  await prisma.credential.create({ data: { organizationId: org.id, ownerId: pre.id, system: 'Dialpad', systemKey: 'dialpad', payloadEnc: 'x', createdById: people.hirer.p.id } });
  const state = await board.agentState(programs.pre.id, people.sara.p);
  const dialpad = state.tasks.find((t) => t.kind === 'ACCOUNT' && t.system === 'Dialpad');
  assert.ok(dialpad.doneAt); assert.equal(dialpad.doneById, null, 'it ticked itself');
  assert.equal(state.group, 'NOT_STARTED');
  assert.match(state.goingOn, /^Starts \w+ \d+ \w+ · 1 of 9 ready$/);
  assert.equal(board.stageText(state).text, `Pre-start · starts ${board.shortDate(start)}`);
  assert.equal(state.ownerOf(dialpad).id, people.hirer.p.id, 'an Admin\'s item: the admin who hired them');
  assert.equal(await board.completeTask(people.sara.p, programs.pre, state.tasks.find((t) => t.kind === 'ADMIN_TASK')), 'An admin ticks this.');

  await prisma.profile.update({ where: { id: pre.id }, data: { employmentStartDate: new Date(`${np.addDays(start, 7)}T00:00:00Z`) } });
  assert.equal(await np.followStartDate(await prisma.profile.findUnique({ where: { id: pre.id } })), true);
  assert.equal((await prisma.agentProgram.findUnique({ where: { id: programs.pre.id } })).startDate, np.addDays(start, 7));
});

test('every item resolves to a real, active person; the admins cover a supervisor on leave or disabled from day one', async () => {
  await mk('cover', 'TRAVEL_AGENT', { start: ago(9), createdById: people.hirer.p.id });
  await run('cover', 9, 'kamol');
  const check = async (key, expectSupervisor) => {
    const s = await board.agentState(programs[key].id, people.admin.p);
    for (const t of s.tasks) {
      const who = s.ownerOf(t);
      assert.ok(who, `${t.title} has an owner`);
      const row = await prisma.profile.findUnique({ where: { id: who.id } });
      assert.equal(row.status, 'ACTIVE', `${t.title}: ${row.fullName} is active`);
      if (t.owner === 'SUPERVISOR') assert.equal(who.id, expectSupervisor, t.title);
    }
    return s;
  };
  await check('cover', people.kamol.p.id);
  await check('pre', people.sara.p.id);

  await prisma.leaveRequest.create({ data: { organizationId: org.id, profileId: people.kamol.p.id, startDate: new Date(`${ago(1)}T00:00:00Z`), endDate: new Date(`${np.addDays(today, 3)}T00:00:00Z`), days: 5, status: 'APPROVED' } });
  const s = await check('cover', people.hirer.p.id);
  assert.equal(s.cover.text, 'Covering for Kamol (on leave)');
  assert.match((await as('admin').get('/new-agents')).text, /Travel Agent · Kamol Tester, on leave/, 'the admins see what they cover');
  const page = await as('admin').get(`/new-agents/${people.cover.p.id}`);
  assert.match(page.text, /Covering for Kamol \(on leave\)/);

  await prisma.leaveRequest.deleteMany({ where: { profileId: people.kamol.p.id } });
  await prisma.profile.update({ where: { id: people.kamol.p.id }, data: { status: 'DISABLED' } });
  const d = await check('cover', people.hirer.p.id);
  assert.equal(d.cover.reason, 'DISABLED');
  const untracked = await board.untrackedHires(org.id, [d]);
  assert.ok(untracked.some((u) => u.profile.id === people.cover.p.id && /is disabled/.test(u.reason)), 'and can\'t be tracked until a supervisor is assigned');
  await prisma.profile.update({ where: { id: people.kamol.p.id }, data: { status: 'ACTIVE' } });
});

test('the gate: "4 of 5 met"; Approve only when every criterion is met; Approve anyway is an Admin\'s, with a reason', async () => {
  await mk('ready', 'TRAVEL_AGENT', { start: ago(25), createdById: people.hirer.p.id });
  await run('ready', 25, 'sara');
  let s = await board.agentState(programs.ready.id, people.sara.p);
  assert.equal(s.summary.stage, 'RAMP'); assert.equal(s.summary.rampWeek, 2);
  assert.equal(s.readiness.met, false);
  assert.equal(await board.approve(people.admin.p, s), 'Not every criterion is met yet.');
  assert.equal(await board.approve(people.sara.p, s, { anyway: true, reason: 'Strong on calls' }), 'Only an admin approves for solo live calls.');
  assert.equal(await board.approve(people.admin.p, s, { anyway: true, reason: '' }), 'Write why they are ready anyway.');

  await tickAll('ready', 'sara');
  await typed('ready', 89, 40);
  const recent = await np.refresh(programs.ready.id);
  await prisma.agentProgramTask.updateMany({ where: { programId: programs.ready.id, kind: 'CALLS', day: { gte: np.horizonOf(recent.pos) - 2, lte: np.horizonOf(recent.pos) } }, data: { doneAt: new Date() } }); // their recent calls done
  s = await board.agentState(programs.ready.id, people.sara.p);
  assert.deepEqual(s.readiness.checks.map((c) => [c.key, c.ok]), [['signoffs', true], ['accuracy', false], ['speed', true], ['review', true], ['overdue', true]], 'missed call days never block the gate');
  assert.equal(s.readiness.metCount, 4);
  await prisma.practiceCallTranscript.updateMany({ where: { profileId: people.ready.p.id }, data: { accuracy: 93 } });
  s = await board.agentState(programs.ready.id, people.sara.p);
  assert.equal(s.readiness.met, true);
  assert.equal(s.next.text, 'Waiting for an admin to approve', 'the supervisor waits for an admin');
  assert.equal(s.next.lock, true);
  const asAdmin = await board.agentState(programs.ready.id, people.admin.p);
  assert.equal(asAdmin.group, 'NEEDS_YOU', 'it waits on an admin');
  assert.equal(asAdmin.next.text, 'Approve for solo live calls');
  assert.equal(asAdmin.next.button.href, `/new-agents/approvals#agent-${people.ready.p.id}`);
  const page = await as('sara').get(`/new-agents/${people.ready.p.id}`);
  assert.match(page.text, /Ready for solo live calls/);
  assert.match(page.text, /5 of 5 met/);
  assert.doesNotMatch(page.text, /\/approve" data-once>/, 'no Approve for the supervisor');
  assert.match(page.text, /Every check is met\. An admin approves them/);
  assert.match(decodeURIComponent((await as('sara').form(`/new-agents/${people.ready.p.id}/approve`, {})).headers.location), /Only an admin approves/);
  const queue = await as('admin').get('/new-agents/approvals');
  assert.equal(queue.status, 200);
  assert.match(queue.text, /Ready for solo live calls/);
  assert.match(queue.text, new RegExp(`id="agent-${people.ready.p.id}"`));
  assert.equal((await as('sara').get('/new-agents/approvals')).status, 403, 'an Admin\'s page only');

  assert.equal((await as('admin').form(`/new-agents/${people.ready.p.id}/approve`, { from: 'approvals' })).headers.location, `/new-agents/approvals#agent-${people.ready.p.id}`);
  const done = await prisma.agentProgram.findUnique({ where: { id: programs.ready.id } });
  assert.equal(done.status, 'COMPLETED'); assert.equal(done.approvedById, people.admin.p.id);
  const cert = await prisma.earnedCertification.findMany({ where: { profileId: people.ready.p.id }, include: { definition: true } });
  assert.equal(cert.length, 1); assert.equal(cert[0].definition.name, 'Ready for solo live calls'); assert.equal(cert[0].definition.kind, 'PROGRAM');
  await require('../lib/certifications').evaluateOrganization(org.id);
  assert.equal(await prisma.earnedCertification.count({ where: { definitionId: cert[0].definitionId } }), 1, 'the automation never issues it');
  assert.equal((await cp.stateFor(people.ready.p)).eligible, false, 'approved: Call Practice is over');
  assert.doesNotMatch((await as('ready').get('/training')).text, /data-call-practice/, 'no Call Practice button any more');
  assert.ok(await prisma.notification.findFirst({ where: { profileId: people.ready.p.id, title: 'Ready for solo live calls' } }), 'the agent is told');
});

test('end of the ramp: urgent, an Admin decides (extend the ramp or approve anyway)', async () => {
  await mk('over', 'TRAVEL_AGENT', { start: ago(63), createdById: people.hirer.p.id });
  await run('over', 63, 'sara');
  let s = await board.agentState(programs.over.id, people.admin.p);
  assert.equal(s.summary.rampOver, true);
  assert.equal(s.group, 'URGENT');
  assert.match(s.goingOn, /^Ramp over: an admin decides/);
  assert.equal(s.next.text, 'Decide: extend the ramp or approve anyway');
  assert.equal((await board.agentState(programs.over.id, people.sara.p)).next.text, 'An admin decides: extend the ramp or approve anyway');
  assert.equal(await board.extendRamp(people.sara.p, s), 'Only an admin can extend the ramp.');
  assert.equal(await board.extendRamp(people.admin.p, s), null);
  s = await board.agentState(programs.over.id, people.admin.p);
  assert.equal(s.summary.rampOver, false, 'one more ramp week from today');
  assert.ok(s.tasks.some((t) => t.kind === 'CALLS' && t.day > np.horizonOf(s.pos)), 'with its daily calls');
});

test('Call Practice: a Travel Agent who did every call hears the lowest-scored one again; a Flight Expert does not', async () => {
  const items = [{ id: 'a', archivedAt: null }, { id: 'b', archivedAt: null }];
  const done = [{ callId: 'a', attempt: 1, submittedAt: new Date('2026-10-01'), accuracy: 80 }, { callId: 'b', attempt: 1, submittedAt: new Date('2026-10-02'), accuracy: 60 }];
  const now = new Date('2026-10-20T10:00:00+05:00');
  assert.equal(cp.planOf({ calls: items, transcripts: done, perDay: 2, now }).next, null);
  const again = cp.planOf({ calls: items, transcripts: done, perDay: 2, now, repeat: true });
  assert.equal(again.next.call.id, 'b'); assert.equal(again.next.again.attempt, 2); assert.equal(again.open, true);
  const going = cp.planOf({ calls: items, transcripts: [...done, { callId: 'a', attempt: 2, submittedAt: null }], perDay: 2, now, repeat: true });
  assert.equal(going.next.call.id, 'a', 'one already being heard again comes first'); assert.equal(going.started, true);
  assert.equal(going.doneCount, 2);

  await typed('cover', 70, 30, 2);
  assert.ok((await cp.stateFor(people.cover.p)).plan.next.again, 'in the program: the lowest-scored call again');
  await mk('fe', 'FLIGHT_EXPERT', { start: ago(3) });
  await run('fe', 3, 'sara');
  await typed('fe', 70, 30, 2);
  assert.equal((await cp.stateFor(people.fe.p)).plan.next, null, 'a Flight Expert: as before');
});

test('every new Travel Agent is accounted for: not on the path, or nobody supervising, is "can\'t be tracked"', async () => {
  await mk('lost', 'TRAVEL_AGENT', { start: ago(10) }); // added too late to start by itself
  await mk('alone', 'TRAVEL_AGENT', { start: ago(2), createdById: people.hirer.p.id });
  await run('alone', 2);
  const states = [await board.agentState(programs.alone.id, people.admin.p)];
  const rows = await board.untrackedHires(org.id, states);
  assert.ok(rows.some((r) => r.profile.id === people.lost.p.id && r.reason === 'Not in the New Agent Program'));
  assert.ok(rows.some((r) => r.profile.id === people.alone.p.id && r.reason === 'No supervisor'));
  assert.ok(!rows.some((r) => r.profile.id === people.fe.p.id), 'Flight Experts are as before');
  assert.doesNotMatch((await as('admin').get('/new-agents')).text, /data-na-today/, 'no Today section on the board');
});

test('the admins\' 08:30 message: can\'t be tracked, decisions, who they cover, and the call library', async () => {
  const sent = [];
  const out = await reminders.runMorning(org.id, { send: async (m) => { sent.push(m); return { id: 'x' }; } });
  assert.ok(out.adminDigests >= 1);
  const note = await prisma.notification.findFirst({ where: { profileId: people.admin.p.id, type: 'program.digest' } });
  assert.match(note.body, /can't be tracked/);
  assert.match(note.body, /call library: about \d+ days? left/);
});

test('a new Travel Agent needs a supervisor; on My Training they see their path and the Call Practice button, as before', async () => {
  const res = await as('admin').form('/admin/employees/new', { fullName: 'No Sup', username: `tap.nosup.${Date.now() % 100000}`, email: `tap_${org.id}_nosup@example.invalid`, role: 'TRAVEL_AGENT', employmentStartDate: np.addDays(today, 5) });
  assert.equal(res.status, 200);
  assert.match(res.text, /every new Travel Agent needs one/);
  assert.equal(await prisma.profile.count({ where: { email: `tap_${org.id}_nosup@example.invalid` } }), 0);

  const mine = await as('cover').get('/training');
  assert.match(mine.text, /Finish each training to unlock the next/);
  assert.match(mine.text, /data-call-practice/, 'the one Call Practice button');
  assert.doesNotMatch(mine.text, /data-my-day|My month|Quick check|Ready for solo live calls/, 'nothing of the supervisor side');
  assert.equal((await as('cover').form('/training/my-day/answer/x', { answer: 'NO' })).status, 404);
});

test('admin checks: a supervisor\'s sign-off waits for an admin, who confirms or sends it back; its owner is a real, active admin', async () => {
  await mk('checked', 'TRAVEL_AGENT', { start: ago(6), createdById: people.hirer.p.id });
  await run('checked', 6, 'sara');
  const dialpad = await prisma.agentProgramTask.findFirst({ where: { programId: programs.checked.id, kind: 'SIGN_OFF', system: 'Dialpad' } });
  const url = `/new-agents/${people.checked.p.id}/tasks/${dialpad.id}`;
  assert.match(decodeURIComponent((await as('sara').form(`${url}/done`, { note: '' })).headers.location), /Write what you watched them do/);
  await as('sara').form(`${url}/done`, { note: 'Held, transferred and left a voicemail on a test call.' });
  let t = await prisma.agentProgramTask.findUnique({ where: { id: dialpad.id } });
  assert.equal(t.doneAt, null, 'it does not count yet');
  assert.equal(t.requestedById, people.sara.p.id);
  let s = await board.agentState(programs.checked.id, people.admin.p);
  assert.equal(np.stateOf(t, s.pos), 'CONFIRM');
  const owner = s.ownerOf(t);
  assert.equal(owner.id, people.hirer.p.id, 'an admin confirms it: the one who hired them');
  assert.equal((await prisma.profile.findUnique({ where: { id: owner.id } })).status, 'ACTIVE');
  assert.match(s.next.text, /^Confirm Dialpad sign-off/, 'what only an admin does comes first for an Admin');
  assert.ok(await prisma.notification.findFirst({ where: { profileId: people.hirer.p.id, type: 'program.confirm' } }), 'the admin is told');
  const sup = await board.agentState(programs.checked.id, people.sara.p);
  assert.ok(!board.supervisorTasksOf([sup]).late.some((r) => r.task.id === dialpad.id), 'no longer the supervisor\'s to do');
  assert.match(decodeURIComponent((await as('sara').form(`${url}/confirm`, {})).headers.location), /Only an admin confirms/);

  const queue = await as('admin').get('/new-agents/approvals');
  assert.match(queue.text, /Sign-offs to confirm/);
  assert.match(queue.text, /Held, transferred and left a voicemail/);
  assert.match(decodeURIComponent((await as('admin').form(`${url}/send-back`, { reason: '' })).headers.location), /Write what they should do again/);
  await as('admin').form(`${url}/send-back`, { reason: 'Do the voicemail part again, please.' });
  t = await prisma.agentProgramTask.findUnique({ where: { id: dialpad.id } });
  assert.equal(t.requestedAt, null); assert.equal(t.doneAt, null);
  assert.ok(await prisma.notification.findFirst({ where: { profileId: people.sara.p.id, type: 'program.sent_back' } }), 'the supervisor is told why');

  await as('sara').form(`${url}/done`, { note: 'Voicemail done this time, on her own.' });
  await as('admin').form(`${url}/confirm`, { from: 'approvals' });
  t = await prisma.agentProgramTask.findUnique({ where: { id: dialpad.id } });
  assert.ok(t.doneAt); assert.equal(t.doneById, people.admin.p.id); assert.equal(t.requestedById, people.sara.p.id);
  s = await board.agentState(programs.checked.id, people.admin.p);
  assert.match(s.readiness.checks[0].detail, /^1 of 6 confirmed/);
  assert.match(decodeURIComponent((await as('sara').form(`${url}/undo`, {})).headers.location), /Only an admin takes a tick back/);
  for (const x of s.tasks) assert.ok(s.ownerOf(x) && s.ownerOf(x).status === 'ACTIVE', `${x.title} has a real, active owner`);
});

test('admin checks: an earlier "it did not happen" answer, or a burst of ticks, is a flag an admin can let be', async () => {
  const s0 = await board.agentState(programs.checked.id, people.checked.p);
  const welcome = s0.tasks.find((t) => t.kind === 'CHECK_IN' && !board.isDailyCheckIn(t));
  await as('sara').form(`/new-agents/${people.checked.p.id}/tasks/${welcome.id}/done`, {});
  // agents are not asked any more; an answer saved before still counts
  await prisma.agentProgramTask.update({ where: { id: welcome.id }, data: { agentAnswer: 'NO', agentAnsweredAt: new Date() } });
  let s = await board.agentState(programs.checked.id, people.admin.p);
  const flag = s.flags.find((f) => f.task.id === welcome.id);
  assert.ok(flag && /Checked says it did not happen/.test(flag.text));
  assert.equal(s.nextMeta.kind, 'flag', 'an Admin sees it under the next step');
  assert.equal((await board.agentState(programs.checked.id, people.sara.p)).flags.length >= 1, true);
  assert.notEqual((await board.agentState(programs.checked.id, people.sara.p)).nextMeta?.kind, 'flag', 'not shown to the supervisor');
  assert.match((await as('admin').get('/new-agents/approvals')).text, /id="flags"/);
  assert.equal((await as('sara').get(`/training`)).status, 200);
  assert.match(decodeURIComponent((await as('sara').form(`/new-agents/${people.checked.p.id}/tasks/${welcome.id}/clear-flag`, {})).headers.location), /Only an admin decides/);
  await as('admin').form(`/new-agents/${people.checked.p.id}/tasks/${welcome.id}/clear-flag`, {});
  s = await board.agentState(programs.checked.id, people.admin.p);
  assert.ok(!s.flags.some((f) => f.task.id === welcome.id), 'let be: not shown again');

  // three ticks within five minutes by the supervisor
  const demos = s.tasks.filter((t) => t.kind === 'DEMO' && !t.doneAt && t.day <= s.pos.today).slice(0, 3);
  assert.equal(demos.length, 3);
  for (const d of demos) await as('sara').form(`/new-agents/${people.checked.p.id}/tasks/${d.id}/done`, {});
  s = await board.agentState(programs.checked.id, people.admin.p);
  assert.ok(demos.every((d) => s.flags.some((f) => f.task.id === d.id && /\d+ ticks within 5 minutes/.test(f.text))));
  const cards = (await board.boardFor(people.admin.p)).cards;
  assert.ok(Number(cards.find((c) => c.label === 'Flags').value) >= 3);
});

test('admin checks are for Travel Agents only: a Flight Expert\'s supervisor signs off, approves nothing, and undoes as before', async () => {
  await mk('flyer', 'FLIGHT_EXPERT', { start: ago(6), createdById: people.hirer.p.id });
  await run('flyer', 6, 'sara');
  const crm = await prisma.agentProgramTask.findFirst({ where: { programId: programs.flyer.id, kind: 'SIGN_OFF', system: 'CRM' } });
  await as('sara').form(`/new-agents/${people.flyer.p.id}/tasks/${crm.id}/done`, {});
  const t = await prisma.agentProgramTask.findUnique({ where: { id: crm.id } });
  assert.ok(t.doneAt); assert.equal(t.doneById, people.sara.p.id); assert.equal(t.requestedAt, null);
  await as('sara').form(`/new-agents/${people.flyer.p.id}/tasks/${crm.id}/undo`, {});
  assert.equal((await prisma.agentProgramTask.findUnique({ where: { id: crm.id } })).doneAt, null, 'the supervisor takes it back');
  assert.deepEqual((await board.agentState(programs.flyer.id, people.admin.p)).flags, [], 'no flags');
  assert.doesNotMatch((await as('flyer').get('/training')).text, /Quick check/);
});

test('Month 1 only (the ramp off): the ready check is at the end of Month 1, an admin approves; time up is an admin\'s decision', async () => {
  plans.SWITCHES.ramp = false;
  try {
    await mk('m1', 'TRAVEL_AGENT', { start: ago(19), createdById: people.hirer.p.id });
    await run('m1', 19, 'sara'); // day 20 today: the last day of Month 1
    await tickAll('m1', 'sara');
    await typed('m1', 93, 40);
    await prisma.agentProgramTask.updateMany({ where: { programId: programs.m1.id, kind: 'CALLS' }, data: { doneAt: new Date() } });
    let s = await board.agentState(programs.m1.id, people.admin.p);
    assert.equal(s.summary.stage, 'MONTH_1'); assert.equal(s.summary.lengths.ramp, 0);
    assert.equal(await prisma.agentProgramTask.count({ where: { programId: programs.m1.id, day: { gt: 20 } } }), 0, 'no ramp');
    assert.equal(s.readiness.met, true);
    assert.equal(s.group, 'NEEDS_YOU'); assert.equal(s.next.text, 'Approve for solo live calls');
    const cells = board.cellsOf(s, { isAdmin: true });
    assert.equal(cells.stage.label, 'Week 4'); assert.equal(cells.stage.steps.length, 4, 'the Stage column: one segment a week');
    assert.equal(board.stageText(s).path.map((x) => x.name).join(' / '), 'Before day 1 / Month 1 / Ready for solo live calls');
    assert.equal(await board.approve(people.admin.p, s, { anyway: true, reason: 'Strong already' }), 'Approve anyway is for after Month 1.');
    const page = await as('admin').get(`/new-agents/${people.m1.p.id}`);
    assert.match(page.text, /<h2 id="na-plan-title" class="na-h2">Month 1<\/h2>/);
    assert.match(page.text, /id="week-4" data-na-week="4" open/, 'this week is open');
    assert.match(page.text, /id="week-1" data-na-week="1">/, 'a finished week is folded');
    assert.match(page.text, /naw__badge--done/);
    const mine = await as('m1').get('/training');
    assert.match(mine.text, /Finish each training to unlock the next/); assert.doesNotMatch(mine.text, /data-my-month/);
    assert.equal(await board.approve(people.admin.p, s), null, 'an admin approves at the end of Month 1');
    assert.equal((await prisma.agentProgram.findUnique({ where: { id: programs.m1.id } })).status, 'COMPLETED');

    await mk('late1', 'TRAVEL_AGENT', { start: ago(22), createdById: people.hirer.p.id });
    await run('late1', 22, 'sara'); // day 23: Month 1 is over and nothing is met
    s = await board.agentState(programs.late1.id, people.admin.p);
    assert.equal(s.summary.stage, 'RAMP'); assert.equal(s.summary.stageLabel, 'Ready check'); assert.equal(s.summary.rampOver, true);
    assert.equal(s.group, 'URGENT');
    assert.match(s.goingOn, /^Month 1 over: an admin decides/);
    assert.equal(s.next.text, 'Decide: extend a week or approve anyway');
    assert.equal((await board.agentState(programs.late1.id, people.sara.p)).next.text, 'An admin decides: extend a week or approve anyway');
    assert.match((await as('admin').get(`/new-agents/${people.late1.p.id}`)).text, /Month 1 is over\. Decide: extend a week, or approve them anyway\./);
    assert.equal(await board.extendRamp(people.admin.p, s), null);
    s = await board.agentState(programs.late1.id, people.admin.p);
    assert.equal(s.summary.stageLabel, 'Extra week'); assert.equal(s.summary.rampOver, false);
    assert.ok(s.tasks.some((t) => t.key === 'ramp-review:1'), 'a review at the end of the extra week');
    assert.ok(s.tasks.some((t) => t.kind === 'CALLS' && t.day > 20), 'and Call Practice that week');
  } finally {
    plans.SWITCHES.ramp = true;
  }
});
