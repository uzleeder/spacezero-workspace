'use strict';
// Speaking practice (AI role-play + voice response) keeps what the agent has done: closing or refreshing
// the page, a failed AI turn, a second tap on "Send"/"Finish", or a failed analysis never loses anything
// or shows a dead-end "session completed" message - the agent carries on where they left off.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const gemini = require('../lib/gemini');
let aiDown = false; let analysisDown = false; let replies = 0;
mock.method(gemini, 'generateText', async () => { if (aiDown) throw new Error('AI down'); replies += 1; return { text: `Customer reply ${replies}` }; });
mock.method(gemini, 'generateStructured', async () => {
  if (analysisDown) throw new Error('Provider unavailable');
  return { modelVersion: 'test', data: { overallScore: 82, skillScores: [{ skill: 'Discovery', score: 82 }], feedback: 'Asked good questions.', transcript: 'Which travel dates work best?' } };
});
mock.method(require('../lib/aiMedia'), 'withAiMedia', async (_path, _mime, run) => run({ text: 'test audio' }));
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const app = require('../server');

let org, admin, agent, other, cookies = {}, roleplay, voice;
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);
function wav() {
  const data = Buffer.alloc(44 + 16000); data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(16000, 40); return data;
}
const sessionOf = async (assessment, profile) => prisma.practiceSession.findFirst({ where: { assessmentId: assessment.id, profileId: profile.id }, orderBy: { createdAt: 'desc' } });
const transcriptOf = (s) => JSON.parse(s.dataJson).transcript;

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Speaking practice tests' } });
  const mk = async (role, name) => {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: name, username: `sp_${org.id}_${name}`, email: `sp_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
    const t = generateToken(); await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookies[p.id] = `sz_session=${t.raw}`;
    return p;
  };
  admin = await mk('ADMIN', 'admin'); agent = await mk('TRAVEL_AGENT', 'agent'); other = await mk('TRAVEL_AGENT', 'other');
  const course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Speaking course', createdById: admin.id, status: 'PUBLISHED', passingScore: 70 } });
  const assignment = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.id, scope: 'INDIVIDUAL' } });
  await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: assignment.id, profileId: agent.id } });
  const config = JSON.stringify({ customerPersonality: 'busy executive', scenarioBrief: 'A client wants a discount.', openingLine: 'Give me your best price.', rubricSkills: ['Discovery', 'Closing', 'Opening'] });
  const base = { organizationId: org.id, courseId: course.id, createdVia: 'ADMIN_MANUAL', status: 'APPROVED', level: 3, passingScore: 70, createdById: admin.id, configJson: config, version: 1 };
  roleplay = await prisma.assessment.create({ data: { ...base, type: 'ROLEPLAY', title: 'Role-play' } });
  voice = await prisma.assessment.create({ data: { ...base, type: 'VOICE', title: 'Voice' } });
});
after(async () => { mock.restoreAll(); await prisma.$disconnect(); });

test('role-play: a message is saved before the AI answers; if the AI is down it is kept and "Try again" answers it without retyping', async () => {
  let page = await get(agent, `/assessments/${roleplay.id}/roleplay`);
  assert.equal(page.status, 200);
  const session = await sessionOf(roleplay, agent);
  assert.ok(session);
  aiDown = true;
  const failed = await post(agent, `/assessments/${roleplay.id}/roleplay/message`, { sessionId: session.id, message: 'Hello, which dates suit you?' });
  assert.equal(failed.status, 503);
  assert.equal(failed.body.pending, true);
  assert.equal(failed.body.transcript.at(-1).text, 'Hello, which dates suit you?');
  assert.equal(transcriptOf(await sessionOf(roleplay, agent)).at(-1).role, 'agent'); // saved on the server
  // refreshing the page shows the saved message and the "Try again" notice
  page = await get(agent, `/assessments/${roleplay.id}/roleplay`);
  assert.match(page.text, /Hello, which dates suit you\?/);
  assert.match(page.text, /Welcome back/);
  assert.match(page.text, /id="rp-retry"/);
  // typing a second message before the first is answered is refused (never two unanswered messages in a row)
  const second = await post(agent, `/assessments/${roleplay.id}/roleplay/message`, { sessionId: session.id, message: 'Another message' });
  assert.equal(second.status, 409); assert.equal(second.body.pending, true);
  assert.equal(transcriptOf(await sessionOf(roleplay, agent)).filter((t) => t.role === 'agent').length, 1);
  // the AI is back: "Try again" answers the saved message
  aiDown = false;
  const retried = await post(agent, `/assessments/${roleplay.id}/roleplay/message`, { sessionId: session.id, retry: '1' });
  assert.equal(retried.status, 200);
  assert.match(retried.body.reply, /Customer reply/);
  const saved = transcriptOf(await sessionOf(roleplay, agent));
  assert.deepEqual(saved.map((t) => t.role), ['customer', 'agent', 'customer']);
  // nothing to retry now
  assert.equal((await post(agent, `/assessments/${roleplay.id}/roleplay/message`, { sessionId: session.id, retry: '1' })).status, 400);
});

test('the practice pages\' scripts are valid JavaScript', async () => {
  const vm = require('node:vm');
  const page = await get(agent, `/assessments/${roleplay.id}/roleplay`);
  const inline = [...page.text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes('rp-messages'));
  assert.ok(inline, 'the role-play page carries its script');
  assert.doesNotThrow(() => new vm.Script(inline));
  assert.doesNotThrow(() => new vm.Script(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'js', 'voice-practice.js'), 'utf8')));
});

test('role-play: a busy turn gets a friendly "one moment", the state endpoint tells where things stand, and other people cannot use the session', async () => {
  const session = await sessionOf(roleplay, agent);
  await prisma.practiceSession.update({ where: { id: session.id }, data: { busy: true } });
  const busy = await post(agent, `/assessments/${roleplay.id}/roleplay/message`, { sessionId: session.id, message: 'Hi again' });
  assert.equal(busy.status, 409); assert.equal(busy.body.busy, true); assert.match(busy.body.error, /still being answered/);
  const state = await get(agent, `/assessments/${roleplay.id}/roleplay/state?sessionId=${session.id}`);
  assert.equal(state.body.busy, true); assert.equal(state.body.completed, false); assert.equal(state.body.pending, false);
  assert.equal(state.body.transcript.length, 3);
  await prisma.practiceSession.update({ where: { id: session.id }, data: { busy: false } });
  assert.equal((await get(other, `/assessments/${roleplay.id}/roleplay/state?sessionId=${session.id}`)).status, 404);
  assert.equal((await post(other, `/assessments/${roleplay.id}/roleplay/message`, { sessionId: session.id, message: 'hijack' })).status, 404);
});

test('role-play: a turn that was never released frees itself, so a practice cannot stay stuck', async () => {
  const session = await sessionOf(roleplay, agent);
  await prisma.practiceSession.update({ where: { id: session.id }, data: { busy: true } });
  await prisma.$executeRaw`UPDATE "PracticeSession" SET "updatedAt" = ${new Date(Date.now() - 5 * 60000)} WHERE "id" = ${session.id}`;
  const ok = await post(agent, `/assessments/${roleplay.id}/roleplay/message`, { sessionId: session.id, message: 'Are you still there?' });
  assert.equal(ok.status, 200);
});

test('role-play: finishing scores it once; tapping Send or Finish again (or reopening an old page) shows the saved result, never "session completed"', async () => {
  const session = await sessionOf(roleplay, agent);
  const finished = await post(agent, `/assessments/${roleplay.id}/roleplay/finish`, { sessionId: session.id });
  assert.equal(finished.status, 200);
  assert.match(finished.text, /Passed/);
  assert.equal(await prisma.trainingAttempt.count({ where: { assessmentId: roleplay.id, profileId: agent.id } }), 1);
  // a second tap on Finish (stale page) goes to the saved result, no second attempt
  const again = await post(agent, `/assessments/${roleplay.id}/roleplay/finish`, { sessionId: session.id });
  assert.equal(again.status, 302);
  assert.equal(again.headers.location, `/assessments/${roleplay.id}/result`);
  assert.equal(await prisma.trainingAttempt.count({ where: { assessmentId: roleplay.id, profileId: agent.id } }), 1);
  // a late Send from an old page: friendly JSON pointing at the result
  const late = await post(agent, `/assessments/${roleplay.id}/roleplay/message`, { sessionId: session.id, message: 'late' });
  assert.equal(late.status, 409); assert.equal(late.body.completed, true); assert.equal(late.body.resultUrl, `/assessments/${roleplay.id}/result`);
  const result = await get(agent, `/assessments/${roleplay.id}/result`);
  assert.equal(result.status, 200);
  assert.match(result.text, /Passed/); assert.match(result.text, /Asked good questions\./); assert.match(result.text, /Discovery/);
  // opening the practice again starts a fresh conversation (a real retry), the old result is untouched
  const fresh = await get(agent, `/assessments/${roleplay.id}/roleplay`);
  assert.equal(fresh.status, 200);
  assert.notEqual((await sessionOf(roleplay, agent)).id, session.id);
});

test('voice: the recording is saved on the server at once and is still there after a refresh; the page offers it again', async () => {
  const saved = await request(app).post(`/assessments/${voice.id}/voice/draft`).set('Cookie', cookies[agent.id]).attach('recording', wav(), { filename: 'voice.wav', contentType: 'audio/wav' });
  assert.equal(saved.status, 200); assert.equal(saved.body.ok, true);
  const page = await get(agent, `/assessments/${voice.id}/take`);
  assert.equal(page.status, 200);
  assert.match(page.text, /your recording is saved/);
  assert.match(page.text, new RegExp(`src="/assessments/${voice.id}/voice/draft\\?v=`));
  assert.doesNotMatch(page.text, /type="file"[^>]*required/); // no need to upload it again
  const audio = await get(agent, `/assessments/${voice.id}/voice/draft`).buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
  assert.equal(audio.status, 200); assert.match(audio.headers['content-type'], /audio\/wav/); assert.equal(audio.body.length, wav().length);
  assert.equal((await get(other, `/assessments/${voice.id}/voice/draft`)).status, 404); // private to the learner
  const bad = await request(app).post(`/assessments/${voice.id}/voice/draft`).set('Cookie', cookies[agent.id]).attach('recording', Buffer.from('not audio at all'), { filename: 'x.wav', contentType: 'audio/wav' });
  assert.equal(bad.status, 400);
});

test('voice: if the analysis fails the recording is kept and "Try again" analyses the same one; success closes the practice', async () => {
  analysisDown = true;
  const failed = await request(app).post(`/assessments/${voice.id}/voice`).set('Cookie', cookies[agent.id]).field('authorized', 'yes'); // no file: uses the saved recording
  assert.equal(failed.status, 503);
  assert.match(failed.text, /Your recording is saved/); assert.match(failed.text, />Try again</);
  assert.equal(await prisma.trainingAttempt.count({ where: { assessmentId: voice.id } }), 0);
  assert.equal((await get(agent, `/assessments/${voice.id}/take`)).status, 200);
  assert.match((await get(agent, `/assessments/${voice.id}/take`)).text, /your recording is saved/);
  assert.equal((await sessionOf(voice, agent)).busy, false);
  analysisDown = false;
  const ok = await request(app).post(`/assessments/${voice.id}/voice`).set('Cookie', cookies[agent.id]).field('authorized', 'yes');
  assert.equal(ok.status, 200);
  assert.match(ok.text, /Passed/);
  const attempt = await prisma.trainingAttempt.findFirst({ where: { assessmentId: voice.id } });
  assert.equal(attempt.score, 82); assert.equal(attempt.status, 'COMPLETED');
  assert.ok((await sessionOf(voice, agent)).completedAttemptId);
  assert.equal((await get(agent, `/assessments/${voice.id}/result`)).status, 200);
  assert.match((await get(agent, `/assessments/${voice.id}/result`)).text, /Asked good questions\./);
  // starting again begins with no saved recording
  assert.doesNotMatch((await get(agent, `/assessments/${voice.id}/take`)).text, /your recording is saved/);
});

test('voice: a new upload without a saved draft is saved first, and a missing recording gets a clear message (the saved one can be discarded)', async () => {
  const none = await request(app).post(`/assessments/${voice.id}/voice`).set('Cookie', cookies[agent.id]).field('authorized', 'yes');
  assert.equal(none.status, 400); assert.match(none.text, /Record or upload your response first/);
  const consent = await request(app).post(`/assessments/${voice.id}/voice`).set('Cookie', cookies[agent.id]).attach('recording', wav(), { filename: 'v.wav', contentType: 'audio/wav' });
  assert.equal(consent.status, 400); assert.match(consent.text, /Confirm permission/);
  await request(app).post(`/assessments/${voice.id}/voice/draft`).set('Cookie', cookies[agent.id]).attach('recording', wav(), { filename: 'voice.wav', contentType: 'audio/wav' });
  assert.match((await get(agent, `/assessments/${voice.id}/take`)).text, /your recording is saved/);
  assert.equal((await post(agent, `/assessments/${voice.id}/voice/draft/discard`)).status, 302);
  assert.doesNotMatch((await get(agent, `/assessments/${voice.id}/take`)).text, /your recording is saved/);
});
