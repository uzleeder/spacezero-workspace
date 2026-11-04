'use strict';
// New Agent Program, step 3 (lib/newAgentReminders.js): the supervisor's 08:30 "Today with your new agents" message,
// an alert when an agent falls behind or keeps scoring low, escalation of a supervisor's item to every Admin after 2 of
// the agent's working days, a new agent without a supervisor, the Admins' morning email - each sent once - and the
// dashboard's "Needs your attention" items (the Admin's dashboard: lib/adminDashboard.js).
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

mock.method(require('../lib/gemini'), 'generateStructured', async () => { throw new Error('Gemini must not be called in these tests'); });

const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { dayKey } = require('../lib/callPractice');
const np = require('../lib/newAgentProgram');
const reminders = require('../lib/newAgentReminders');
const app = require('../server');

let org; const people = {}; const programs = {};
const today = dayKey(new Date());
const NOW = new Date(`${today}T09:00:00+05:00`);
const as = (who) => ({ get: (url) => request(app).get(url).set('Cookie', people[who].cookie) });
const notes = (who, type) => prisma.notification.findMany({ where: { profileId: people[who].p.id, ...(type ? { type } : {}) }, orderBy: { createdAt: 'asc' } });

before(async () => {
  org = await prisma.organization.create({ data: { name: 'New agent reminders tests' } });
  const mk = async (key, role, extra = {}) => {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `${key[0].toUpperCase()}${key.slice(1)} Tester`, username: `nar_${org.id}_${key}`, email: `nar_${org.id}_${key}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date(), ...extra } });
    const token = generateToken();
    await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
    people[key] = { p, cookie: `sz_session=${token.raw}` };
  };
  await mk('admin', 'ADMIN'); await mk('admin2', 'ADMIN');
  await mk('kamola', 'SUPERVISOR'); await mk('bobur', 'SUPERVISOR');
  await mk('aziz', 'TRAVEL_AGENT'); await mk('malika', 'TRAVEL_AGENT'); await mk('jasur', 'TRAVEL_AGENT'); await mk('dilnoza', 'FLIGHT_EXPERT');
  await mk('tester', 'TRAVEL_AGENT', { testOwnerAdminId: null });
  await prisma.profile.update({ where: { id: people.tester.p.id }, data: { testOwnerAdminId: people.admin.p.id } });
  await prisma.supervisorAssignment.createMany({ data: [
    { supervisorId: people.kamola.p.id, agentId: people.aziz.p.id },
    { supervisorId: people.kamola.p.id, agentId: people.malika.p.id },
    { supervisorId: people.bobur.p.id, agentId: people.jasur.p.id },
  ] });
  const start = async (key, daysAgo) => {
    const row = await np.startProgram(people[key].p, { startKey: np.addDays(today, -daysAgo), startDay: 1 });
    programs[key] = await prisma.agentProgram.update({ where: { id: row.id }, data: { workDaysJson: '[1,2,3,4,5,6,7]' } });
  };
  await start('aziz', 5);    // day 6: day 5's calls one day late, week 1 supervisor items 2+ days late
  await start('malika', 0);  // day 1: things for today
  await start('jasur', -3);  // starts in 3 days: nothing yet
  await start('dilnoza', 2); // day 3, no supervisor
  await start('tester', 5);  // an Admin's test account: never in reminders
});
after(async () => { mock.restoreAll(); await prisma.$disconnect(); });

test('08:30 is 08:30 in Tashkent; a late item says when the admin hears of it', () => {
  assert.equal(reminders.tashkentMinutes(new Date('2026-10-26T03:30:00Z')), 8 * 60 + 30);
  assert.equal(reminders.escalationNote(2), 'Your admin was told');
  assert.equal(reminders.escalationNote(1), 'Your admin is told after one more working day');
  assert.equal(reminders.escalationNote(3, { forAdmin: true }), 'Admins were told');
});

test('an agent falling behind alerts their supervisor once; supervisor items 2 days late go to every Admin once; so does no supervisor', async () => {
  const out = await reminders.runAlerts(org.id, { now: NOW });
  assert.equal(out.states.length, 4, 'the Admin\'s test account is left out');
  const behind = await notes('kamola', 'program.behind');
  assert.equal(behind.length, 1);
  assert.equal(behind[0].title, 'Aziz Tester fell behind');
  assert.match(behind[0].body, /^Not done on day 5: Call Practice: 2 calls\.$/);
  assert.equal(behind[0].link, `/new-agents/${people.aziz.p.id}`);

  const escalated = await notes('admin', 'program.escalated');
  const titles = escalated.map((n) => n.title);
  assert.ok(titles.includes('Overdue for Aziz Tester: Welcome 1:1 and introduce them to the team'), 'day 1: 5 days late');
  assert.ok(titles.includes('Overdue for Aziz Tester: Sign off Dialpad: hold, transfer, voicemail'), 'day 4: 2 days late');
  assert.ok(!titles.includes('Overdue for Aziz Tester: Week 1 review'), 'day 5: 1 day late, not yet');
  assert.ok(titles.some((t) => t.startsWith('Overdue for Dilnoza Tester')), 'an agent without a supervisor too');
  assert.match(escalated.find((n) => n.title.startsWith('Overdue for Dilnoza')).body, /^No supervisor · 2 working days late\.$/);
  assert.equal((await notes('admin2', 'program.escalated')).length, escalated.length, 'every Admin');
  assert.equal((await notes('admin', 'program.no_supervisor')).length, 1);
  assert.equal((await notes('admin', 'program.no_supervisor'))[0].title, 'Dilnoza Tester has no supervisor');
  assert.equal(escalated.filter((n) => n.title.includes('Tester Tester')).length, 0);

  const again = await reminders.runAlerts(org.id, { now: NOW });
  assert.deepEqual([again.behind, again.escalated, again.noSupervisor], [0, 0, 0], 'never twice');
});

test('low accuracy on 3 calls in a row: one alert per run of low calls, however long it gets', async () => {
  const call = await prisma.practiceCall.create({ data: { organizationId: org.id, title: 'c', storagePath: 'call-practice/c.mp3', mimeType: 'audio/mpeg', durationSeconds: 10, referenceText: 'Agent: hi', referenceStatus: 'READY', createdById: people.admin.p.id } });
  const calls = [];
  for (let i = 0; i < 5; i += 1) calls.push(await prisma.practiceCall.create({ data: { organizationId: org.id, title: `c${i}`, storagePath: `call-practice/c${i}.mp3`, mimeType: 'audio/mpeg', durationSeconds: 10, referenceText: 'Agent: hi', referenceStatus: 'READY', createdById: people.admin.p.id } }));
  const typed = (c, accuracy, minutesAgo) => prisma.practiceCallTranscript.create({ data: { profileId: people.malika.p.id, callId: c.id, submittedAt: new Date(NOW.getTime() - minutesAgo * 60000), submittedText: 'x', accuracy } });
  await typed(call, 92, 60); await typed(calls[0], 64, 50); await typed(calls[1], 58, 40);
  await reminders.runAlerts(org.id, { now: NOW });
  assert.equal((await notes('kamola', 'program.low_accuracy')).length, 0, 'two low calls are not a streak');
  await typed(calls[2], 61, 30);
  await reminders.runAlerts(org.id, { now: NOW });
  const alert = await notes('kamola', 'program.low_accuracy');
  assert.equal(alert.length, 1);
  assert.equal(alert[0].title, 'Malika Tester: low accuracy on 3 calls in a row');
  assert.match(alert[0].body, /64%, 58%, 61%/);
  await typed(calls[3], 55, 20);
  await reminders.runAlerts(org.id, { now: NOW });
  assert.equal((await notes('kamola', 'program.low_accuracy')).length, 1, 'the same run: no second alert');
});

test('for now supervisors get the morning message in the app only; Admins still get their email', async () => {
  const sent = [];
  const send = async (message) => { sent.push(message); return { id: 'x' }; };
  const yesterday = new Date(NOW.getTime() - 86400000);
  const out = await reminders.runMorning(org.id, { now: yesterday, send });
  assert.equal(out.digests, 1, 'in the app');
  assert.equal(sent.filter((m) => m.to === people.kamola.p.email).length, 0, 'no email to the supervisor');
  assert.ok(sent.some((m) => m.to === people.admin.p.email), 'the Admins\' email still goes');
});

test('the 08:30 run: each supervisor\'s "Today with your new agents" and the Admins\' email, sent once; nothing for a quiet day', async () => {
  const sent = [];
  const send = async (message, options) => { sent.push({ ...message, key: options.idempotencyKey }); return { id: 'x' }; };
  await require('../lib/orgSettings').setSetting(org.id, 'program.supervisorEmails', true, people.admin.p.id); // switched on (Manage Training -> New Agent Program)
  const out = await reminders.runMorning(org.id, { now: NOW, send });
  assert.equal(out.digests, 1, 'Kamola only: Bobur\'s agent starts in 3 days');
  assert.equal(out.adminDigests, 2);
  const digest = (await notes('kamola', 'program.digest'))[0];
  assert.equal(digest.title, 'Today with your new agents');
  assert.match(digest.body, /^\d+ overdue · \d+ for today$/);
  assert.equal((await notes('bobur', 'program.digest')).length, 0);

  const mail = sent.find((m) => m.to === people.kamola.p.email);
  assert.match(mail.subject, /^Today with your new agents · /);
  assert.match(mail.text, /^Hi Kamola,/);
  assert.match(mail.text, /OVERDUE\n- Aziz Tester · Set their working days · 5d overdue \(your admin was told\)\n[\s\S]*- Aziz Tester · Welcome 1:1 and introduce them to the team · 5d overdue \(your admin was told\)/);
  assert.match(mail.text, /Aziz Tester · Week 1 review · 1d overdue \(your admin is told after one more working day\)/);
  assert.match(mail.text, /FOR YOU TODAY \(about 1 h 25 min\)\n- Aziz Tester · EGF: search, compare fares and send a quote · 30 min\n[\s\S]*- Malika Tester · Welcome 1:1 and introduce them to the team · 30 min/);
  assert.match(mail.text, /YOUR NEW AGENTS\n- Aziz Tester: day 6\. No activity for 5 working days · Dialpad and CRM sign-offs 2d late · [^\n]*\. Next: Set their working days\./);
  assert.match(mail.text, /Open New agents: http.*\/new-agents/);
  assert.equal(mail.key, `program-digest:${people.kamola.p.id}:${today}`);

  const adminMail = sent.find((m) => m.to === people.admin.p.email);
  assert.match(adminMail.subject, /^New agents: what needs you · /);
  assert.match(adminMail.text, /Kamola Tester · Aziz Tester · Welcome 1:1 and introduce them to the team · 5d overdue/);
  assert.match(adminMail.text, /No supervisor · Dilnoza Tester · /);
  assert.match(adminMail.text, /New agents without a supervisor[^\n]*\n- Dilnoza Tester/);

  sent.length = 0;
  const again = await reminders.runMorning(org.id, { now: NOW, send });
  assert.deepEqual([again.digests, again.adminDigests, sent.length], [0, 0, 0], 'once a day');
});

test('without email set up, the morning message still arrives in the app', async () => {
  const tomorrow = new Date(NOW.getTime() + 86400000);
  const out = await reminders.runMorning(org.id, { now: tomorrow });
  assert.equal(out.emails, 0);
  assert.equal((await notes('kamola', 'program.digest')).length, 3, 'yesterday, today and tomorrow');
});

test('the board says the admin has been told; the dashboard lists new-agent items first', async () => {
  const board = await as('kamola').get('/new-agents');
  assert.match(board.text, /2 or more working days late, or Month 1 is over and they are not ready\. Your admin has been told\./);
  assert.match((await as('admin').get('/new-agents')).text, /2 or more working days late, or Month 1 is over and they are not ready\. Admins have been told\./);

  const dash = await as('kamola').get('/dashboard');
  assert.equal(dash.status, 200);
  assert.match(dash.text, /href="\/new-agents"[^>]*><span[^>]*>New-agent items overdue<\/span>/);
  assert.match(dash.text, /New-agent items for today/);
  const adminDash = await as('admin').get('/dashboard');
  // the Admin's dashboard puts an agent nobody supervises in "Urgent" (lib/adminDashboard.js)
  assert.match(adminDash.text, /Dilnoza Tester has no supervisor/); assert.match(adminDash.text, /Assign supervisor/);
  assert.doesNotMatch(dash.text, /New agents without a supervisor/, 'that one is for Admins');
});
