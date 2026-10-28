'use strict';
// Call Practice: new agents hear a real client call and type every word (lib/callPractice.js, lib/callPracticeScore.js).
// Who gets it (the first tenure band), which call is open today (in order, N a day, never piling up), listening that
// cannot skip ahead, the draft, submitting and the score against the answer key - which a trainee never sees before
// submitting - the line on My Training, what an Admin manages and what a supervisor sees.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');

mock.method(require('../lib/gemini'), 'generateStructured', async () => { throw new Error('Gemini must not be called in these tests'); });
mock.method(require('../lib/mediaProbe'), 'probeMedia', async () => 42);

const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { STORAGE_ROOT } = require('../lib/storage');
const score = require('../lib/callPracticeScore');
const cp = require('../lib/callPractice');
const app = require('../server');

const KEY = 'Agent: Hello, thank you for calling SpaceZero. My name is Aziz, how can I help you today?\nClient: Hi Aziz, I need to change my flight to Istanbul. It is on Friday morning and my card is [REDACTED-CARD].\nAgent: Of course, let me check what we have for you.';
const GOOD = 'Agent: hello thank you for calling SpaceZero my name is Aziz how can I help you today\nClient: hi Aziz I need to change my flight to Istambul it is on Friday morning and my card is [number]\nAgent: of course let me check what we have for you';
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200, 1)]);
const DAY = 86400000;

let org; const people = {}; const calls = [];
const as = (who) => ({
  get: (url) => request(app).get(url).set('Cookie', people[who].cookie),
  post: (url, body) => request(app).post(url).set('Cookie', people[who].cookie).send(body),
  form: (url, body) => request(app).post(url).set('Cookie', people[who].cookie).type('form').send(body),
});
// The no-skip rule lets listening move on by (time since the last save) x 1.2, so each step moves that clock back first.
async function listen(who, callId, position, action = 'tick') {
  await prisma.practiceCallTranscript.updateMany({ where: { profileId: people[who].p.id, callId }, data: { listenActivityAt: new Date(Date.now() - 15000) } });
  return as(who).post(`/call-practice/${callId}/progress`, { position, speed: 1, action });
}
async function listenToEnd(who, callId) {
  assert.equal((await as(who).post(`/call-practice/${callId}/progress`, { position: 0, speed: 1, action: 'start' })).status, 200);
  for (const at of [15, 30, 42]) assert.equal((await listen(who, callId, at)).status, 200);
}

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Call Practice tests' } });
  await prisma.tenureBand.createMany({ data: [
    { organizationId: org.id, label: 'New Agent', minMonths: 0, maxMonths: 3, displayOrder: 1 },
    { organizationId: org.id, label: 'Experienced Agent', minMonths: 3, maxMonths: null, displayOrder: 2 },
  ] });
  const mk = async (key, role, start = new Date()) => {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `CP ${key}`, username: `cp_${org.id}_${key}`, email: `cp_${org.id}_${key}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: start } });
    const token = generateToken();
    await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
    people[key] = { p, cookie: `sz_session=${token.raw}` };
  };
  await mk('admin', 'ADMIN');
  await mk('agent', 'TRAVEL_AGENT');
  await mk('peer', 'FLIGHT_EXPERT');
  await mk('veteran', 'TRAVEL_AGENT', new Date(Date.now() - 400 * DAY));
  await mk('supervisor', 'SUPERVISOR');
  await prisma.supervisorAssignment.create({ data: { supervisorId: people.supervisor.p.id, agentId: people.agent.p.id } });
  fs.mkdirSync(path.join(STORAGE_ROOT, 'call-practice'), { recursive: true });
  for (let i = 1; i <= 3; i += 1) {
    fs.writeFileSync(path.join(STORAGE_ROOT, 'call-practice', `test-${i}.mp3`), MP3);
    calls.push(await prisma.practiceCall.create({ data: { organizationId: org.id, title: `Call title ${i}`, storagePath: `call-practice/test-${i}.mp3`, mimeType: 'audio/mpeg', durationSeconds: 42, displayOrder: i, referenceText: KEY, referenceStatus: 'READY', createdById: people.admin.p.id } }));
  }
});
after(async () => { mock.restoreAll(); await prisma.$disconnect(); });

test('scoring: word by word, ignoring labels, case, punctuation and [number] placeholders', () => {
  assert.equal(score.scoreTranscript(KEY, KEY, 60).accuracy, 100);
  const typed = score.scoreTranscript(KEY, GOOD, 60);
  assert.equal(typed.wrong, 1, 'Istambul for Istanbul');
  assert.equal(typed.missed, 0); assert.equal(typed.extra, 0);
  assert.ok(typed.accuracy > 95 && typed.accuracy < 100);
  const short = score.scoreTranscript(KEY, 'Agent: hello thank you for calling', 60);
  assert.ok(short.accuracy < 20, 'most of the call missing');
  assert.equal(score.scoreTranscript(KEY, `${GOOD} and some words nobody said`, 60).extra, 5);
  assert.equal(score.wordsPerMinute(100, 10), null, 'too little typing time to say');
  assert.equal(score.wordsPerMinute(100, 120), 50);
  const marked = score.markedAnswerKey(KEY, GOOD);
  const missed = marked.flatMap((l) => l.tokens.filter((t) => t.state === 'missed'));
  assert.deepEqual(missed.map((t) => [t.text, t.typed]), [['Istanbul.', 'istambul']]);
  assert.deepEqual(marked.map((l) => l.speaker), ['Agent', 'Client', 'Agent']);
  assert.equal(marked[1].tokens.find((t) => t.text === '[REDACTED-CARD]').state, 'skip');
});

test('who gets it: Travel Agents and Flight Experts in the first tenure band', () => {
  const bands = [{ label: 'Later', minMonths: 3, maxMonths: null }, { label: 'New Agent', minMonths: 0, maxMonths: 3 }];
  assert.deepEqual(cp.newAgentWindow(bands), { label: 'New Agent', months: 3 });
  assert.deepEqual(cp.newAgentWindow([]), { label: null, months: cp.FALLBACK_MONTHS });
  const w = cp.newAgentWindow(bands);
  const person = (role, monthsAgo, status = 'ACTIVE') => ({ role, status, employmentStartDate: new Date(Date.now() - monthsAgo * 31 * DAY) });
  assert.equal(cp.isEligible(person('TRAVEL_AGENT', 0), w), true);
  assert.equal(cp.isEligible(person('FLIGHT_EXPERT', 2), w), true);
  assert.equal(cp.isEligible(person('TRAVEL_AGENT', 4), w), false, 'past the first band');
  assert.equal(cp.isEligible(person('SUPERVISOR', 0), w), false);
  assert.equal(cp.isEligible(person('TRAVEL_AGENT', 0, 'INVITED'), w), false);
});

test('which call is open: in order, N a day, a missed day never piles up, a started call stays open', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const now = new Date('2026-10-22T09:00:00Z');
  const done = (callId, at) => ({ callId, submittedAt: at, accuracy: 90, wordsPerMinute: 30 });
  const fresh = cp.planOf({ calls: list, transcripts: [], perDay: 2, now });
  assert.equal(fresh.next.call.id, 'a'); assert.equal(fresh.open, true); assert.equal(fresh.started, false);
  const twoToday = cp.planOf({ calls: list, transcripts: [done('a', now), done('b', now)], perDay: 2, now });
  assert.equal(twoToday.next.call.id, 'c'); assert.equal(twoToday.open, false, 'the third waits for tomorrow');
  const yesterday = new Date(now.getTime() - DAY);
  assert.equal(cp.planOf({ calls: list, transcripts: [done('a', yesterday), done('b', yesterday)], perDay: 2, now }).open, true);
  assert.equal(cp.planOf({ calls: list, transcripts: [done('a', now), done('b', now), { callId: 'c', submittedAt: null }], perDay: 2, now }).open, true, 'already started');
  const all = cp.planOf({ calls: list, transcripts: list.map((c) => done(c.id, yesterday)), perDay: 2, now });
  assert.equal(all.next, null); assert.equal(all.doneCount, 3); assert.equal(all.averageAccuracy, 90);
});

test('the answer key from the AI: one line per turn, the client called Client', () => {
  assert.equal(cp.answerKeyFrom([
    { seconds: 0, speaker: 'Agent', text: 'Hello,' }, { seconds: 2, speaker: 'Agent', text: 'how can I help?' },
    { seconds: 5, speaker: 'Customer', text: 'I need a ticket.' },
  ]), 'Agent: Hello, how can I help?\nClient: I need a ticket.');
});

test('My Training: one quiet Call Practice line for new agents only', async () => {
  const mine = await as('agent').get('/training');
  assert.equal(mine.status, 200);
  assert.match(mine.text, /data-call-practice/);
  assert.match(mine.text, /Call 1 is ready · 1 min/);
  assert.match(mine.text, new RegExp(`href="/call-practice/${calls[0].id}">Open<`));
  assert.doesNotMatch(mine.text, /class="btn btn-gold[^"]*" href="\/call-practice/, 'never a second gold button');
  assert.doesNotMatch((await as('veteran').get('/training')).text, /data-call-practice/);
  assert.doesNotMatch((await as('supervisor').get('/training')).text, /data-call-practice/);
  assert.match((await as('veteran').get('/call-practice')).text, /Call Practice is for new agents/);
});

test('the workspace: only the next call opens, and the answer key is never sent to the trainee', async () => {
  assert.equal((await as('agent').get(`/call-practice/${calls[1].id}`)).headers.location, '/call-practice', 'call 2 waits for call 1');
  const page = await as('agent').get(`/call-practice/${calls[0].id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /data-cp-work/);
  assert.match(page.text, /data-cp-submit disabled/);
  assert.match(page.text, /Submit opens when you have heard the whole call/);
  assert.doesNotMatch(page.text, /change my flight to Istanbul/);
  assert.equal((await as('veteran').get(`/call-practice/${calls[0].id}`)).headers.location, '/call-practice');
});

test('the recording plays only through the link made for this person', async () => {
  const page = await as('agent').get(`/call-practice/${calls[0].id}`);
  const src = page.text.match(/src="(\/call-practice\/[^"]+\/audio\?[^"]+)"/)[1].replace(/&amp;/g, '&');
  const audio = await as('agent').get(src).set('Range', 'bytes=0-9');
  assert.equal(audio.status, 206);
  assert.equal((await as('agent').get(`/call-practice/${calls[0].id}/audio`)).status, 403);
  assert.equal((await as('peer').get(src)).status, 403, 'a link is only good for the person it was made for');
  assert.equal((await as('agent').get(src).set('Sec-Fetch-Dest', 'document')).status, 403, 'not as a page of its own');
});

test('listening cannot skip ahead; submitting waits for the end and for enough words', async () => {
  const id = calls[0].id;
  assert.equal((await as('agent').post(`/call-practice/${id}/progress`, { position: 0, speed: 1, action: 'start' })).status, 200);
  const skip = await as('agent').post(`/call-practice/${id}/progress`, { position: 40, speed: 1, action: 'tick' });
  assert.equal(skip.status, 400);
  assert.equal((await as('agent').form(`/call-practice/${id}/submit`, { text: GOOD, typingMs: 1000 })).headers.location, `/call-practice/${id}?notice=listen`);
  assert.equal((await prisma.practiceCallTranscript.findUnique({ where: { profileId_callId_attempt: { profileId: people.agent.p.id, callId: id, attempt: 1 } } })).draftText, GOOD, 'the text is kept');

  const draft = await as('agent').post(`/call-practice/${id}/draft`, { text: 'Client: my card is 4111 1111 1111 1111', typingMs: 5000 });
  assert.equal(draft.status, 200);
  const row = await prisma.practiceCallTranscript.findUnique({ where: { profileId_callId_attempt: { profileId: people.agent.p.id, callId: id, attempt: 1 } } });
  assert.match(row.draftText, /\[REDACTED-CARD\]/); assert.doesNotMatch(row.draftText, /4111/);

  for (const at of [15, 30]) assert.equal((await listen('agent', id, at)).body.listened, false);
  const end = await listen('agent', id, 42);
  assert.equal(end.body.listened, true);
  assert.equal((await as('agent').form(`/call-practice/${id}/submit`, { text: 'Agent: hello', typingMs: 0 })).headers.location, `/call-practice/${id}?notice=short`);
});

test('submitting scores the transcript; the result marks what was missed; a second submit changes nothing', async () => {
  const id = calls[0].id;
  await prisma.practiceCallTranscript.updateMany({ where: { profileId: people.agent.p.id, callId: id }, data: { typingSeconds: 0, draftSavedAt: new Date(Date.now() - 120000) } });
  const sent = await as('agent').form(`/call-practice/${id}/submit`, { text: GOOD, typingMs: 90000 });
  assert.equal(sent.headers.location, `/call-practice/${id}`);
  const row = await prisma.practiceCallTranscript.findUnique({ where: { profileId_callId_attempt: { profileId: people.agent.p.id, callId: id, attempt: 1 } } });
  assert.ok(row.submittedAt); assert.ok(row.accuracy > 95 && row.accuracy < 100);
  assert.equal(Math.round(row.typingSeconds), 90); assert.ok(row.wordsPerMinute > 0);

  const result = await as('agent').get(`/call-practice/${id}`);
  assert.equal(result.status, 200);
  assert.match(result.text, /data-cp-result/);
  assert.match(result.text, new RegExp(`${Math.round(row.accuracy)}%`));
  assert.match(result.text, /<mark class="cp-miss">Istanbul\.<\/mark> <s class="cp-typed" title="Typed">istambul<\/s>/);
  assert.match(result.text, new RegExp(`href="/call-practice/${calls[1].id}" data-main-action>Next call<`));

  await as('agent').form(`/call-practice/${id}/submit`, { text: 'Agent: something else entirely, typed a second time over the first one', typingMs: 0 });
  assert.equal((await prisma.practiceCallTranscript.findUnique({ where: { id: row.id } })).submittedText, GOOD);
});

test('two calls a day: the third opens tomorrow, without piling up', async () => {
  const second = calls[1].id;
  await listenToEnd('agent', second);
  await as('agent').form(`/call-practice/${second}/submit`, { text: GOOD, typingMs: 60000 });
  assert.equal((await as('agent').get(`/call-practice/${calls[2].id}`)).headers.location, '/call-practice');
  assert.match((await as('agent').get('/call-practice')).text, /Today's calls are done[\s\S]*Call 3 opens tomorrow/);
  assert.match((await as('agent').get('/training')).text, /Today's calls are done · the next one opens tomorrow/);
  await prisma.practiceCallTranscript.updateMany({ where: { profileId: people.agent.p.id }, data: { submittedAt: new Date(Date.now() - DAY) } });
  assert.equal((await as('agent').get(`/call-practice/${calls[2].id}`)).status, 200, 'a new day');
  const overview = await as('agent').get('/call-practice');
  assert.match(overview.text, /data-cp-stats/); assert.match(overview.text, /2<span class="cp-kpi-of"> of 3/);
});

test('a supervisor sees the results on the employee\'s Training tab; nobody else does', async () => {
  const tab = await as('supervisor').get(`/employees/${people.agent.p.id}/training`);
  assert.equal(tab.status, 200);
  assert.match(tab.text, /data-cp-report/); assert.match(tab.text, /2 of 3 calls/);
  const review = await as('supervisor').get(`/employees/${people.agent.p.id}/call-practice/${calls[0].id}`);
  assert.equal(review.status, 200);
  assert.match(review.text, /change my flight to/);
  assert.doesNotMatch(review.text, /data-main-action/, 'read-only');
  assert.equal((await as('peer').get(`/employees/${people.agent.p.id}/call-practice/${calls[0].id}`)).status, 404);
  assert.equal((await as('supervisor').get(`/employees/${people.agent.p.id}/call-practice/${calls[2].id}`)).status, 404, 'not done yet');
});

test('Admin: the Call Practice tab, uploads, order, settings; Supervisors cannot manage it', async () => {
  assert.match((await as('admin').get('/admin/training')).text, /href="\/admin\/call-practice">Call Practice</);
  assert.doesNotMatch((await as('supervisor').get('/admin/training')).text, /\/admin\/call-practice/);
  assert.equal((await as('supervisor').get('/admin/call-practice')).status, 403);
  const page = await as('admin').get('/admin/call-practice');
  assert.equal(page.status, 200);
  assert.match(page.text, /during their first <strong>3 months<\/strong> \(the New Agent tenure band in Settings\)/);
  assert.match(page.text, /<strong>2<\/strong> people are in Call Practice now/);
  assert.equal((page.text.match(/data-cp-call>/g) || []).length, 3);

  const up = await request(app).post('/admin/call-practice/upload').set('Cookie', people.admin.cookie)
    .attach('files', MP3, { filename: 'Flight_change_upset client.mp3', contentType: 'audio/mpeg' })
    .attach('files', Buffer.from('not a recording at all'), { filename: 'notes.mp3', contentType: 'audio/mpeg' });
  assert.equal(up.headers.location, '/admin/call-practice?added=1&skipped=1');
  const added = await prisma.practiceCall.findFirst({ where: { organizationId: org.id, title: 'Flight change upset client' } });
  assert.equal(added.referenceStatus, 'PENDING'); assert.equal(added.displayOrder, 4); assert.equal(added.durationSeconds, 42);
  assert.ok(fs.existsSync(path.join(STORAGE_ROOT, added.storagePath)));
  assert.equal((await as('agent').get(`/call-practice/${added.id}`)).status, 404, 'not offered before its answer key is ready');

  await as('admin').form(`/admin/call-practice/${added.id}/move`, { direction: 'up' });
  const order = await prisma.practiceCall.findMany({ where: { organizationId: org.id, archivedAt: null }, orderBy: { displayOrder: 'asc' }, select: { id: true } });
  assert.equal(order[2].id, added.id);

  assert.equal((await as('admin').form('/admin/call-practice/settings', { callsPerDay: '3' })).headers.location, '/admin/call-practice?saved=1');
  assert.equal(await require('../lib/orgSettings').getSetting(org.id, 'callPractice.callsPerDay'), 3);
  assert.equal((await as('admin').form('/admin/call-practice/settings', { callsPerDay: '9' })).status, 400);
});

test('the answer key: made by the AI in the background, corrected by an Admin, and everyone is scored again', async () => {
  const added = await prisma.practiceCall.findFirst({ where: { organizationId: org.id, title: 'Flight change upset client' } });
  const transcribe = mock.method(require('../lib/callIntelligence'), 'transcribe', async () => [{ seconds: 0, speaker: 'Agent', text: 'Good morning, this is SpaceZero, how may I help you today with your booking?' }, { seconds: 4, speaker: 'Customer', text: 'I want to cancel.' }]);
  await prisma.practiceCall.update({ where: { id: added.id }, data: { referenceStatus: 'PROCESSING' } });
  await cp.makeAnswerKey(added.id);
  let row = await prisma.practiceCall.findUnique({ where: { id: added.id } });
  assert.equal(row.referenceStatus, 'READY');
  assert.equal(row.referenceText, 'Agent: Good morning, this is SpaceZero, how may I help you today with your booking?\nClient: I want to cancel.');

  transcribe.mock.mockImplementation(async () => { throw new Error('AI down'); });
  await prisma.practiceCall.update({ where: { id: added.id }, data: { referenceStatus: 'PROCESSING' } });
  await cp.makeAnswerKey(added.id);
  row = await prisma.practiceCall.findUnique({ where: { id: added.id } });
  assert.equal(row.referenceStatus, 'FAILED'); assert.ok(row.referenceError);
  assert.equal(row.referenceText.startsWith('Agent: Good morning'), true, 'a failed retry keeps the last answer key');
  transcribe.mock.restore();

  const before = await prisma.practiceCallTranscript.findUnique({ where: { profileId_callId_attempt: { profileId: people.agent.p.id, callId: calls[0].id, attempt: 1 } } });
  const saved = await as('admin').form(`/admin/call-practice/${calls[0].id}`, { title: 'Call title 1', note: 'Flight change', referenceText: KEY.replace('Istanbul', 'Istambul') });
  assert.equal(saved.headers.location, `/admin/call-practice/${calls[0].id}?saved=1`);
  const afterRow = await prisma.practiceCallTranscript.findUnique({ where: { id: before.id } });
  assert.equal(afterRow.accuracy, 100, 'scored again against the corrected answer key');
  assert.equal((await as('admin').form(`/admin/call-practice/${calls[0].id}`, { title: 'Call title 1', referenceText: 'too short' })).headers.location, `/admin/call-practice/${calls[0].id}?error=key`);
});

test('removing a call: deleted when nobody did it, only taken out of the list when someone did', async () => {
  const added = await prisma.practiceCall.findFirst({ where: { organizationId: org.id, title: 'Flight change upset client' } });
  assert.equal((await as('admin').form(`/admin/call-practice/${added.id}/remove`, {})).headers.location, '/admin/call-practice?removed=deleted');
  assert.equal(await prisma.practiceCall.findUnique({ where: { id: added.id } }), null);
  assert.equal(fs.existsSync(path.join(STORAGE_ROOT, added.storagePath)), false);

  assert.equal((await as('admin').form(`/admin/call-practice/${calls[0].id}/remove`, {})).headers.location, '/admin/call-practice?removed=archived');
  assert.ok((await prisma.practiceCall.findUnique({ where: { id: calls[0].id } })).archivedAt);
  assert.equal((await as('agent').get(`/call-practice/${calls[0].id}`)).status, 200, 'the trainee keeps their result');
  assert.doesNotMatch((await as('admin').get('/admin/call-practice')).text, new RegExp(`call-${calls[0].id}`));
});
