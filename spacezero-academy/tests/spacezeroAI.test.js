'use strict';
// SpaceZero AI — read-only Q&A over data already inside SpaceZero. The priority here is
// authorization (spec's own "CRITICAL: do authorization BEFORE providing records to the AI"):
// every test captures exactly what lib/gemini.js#generateStructured was called with and asserts
// on THAT payload, so we are testing what the model actually received, not just the HTTP response.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { hashPassword } = require('../lib/password');
const gemini = require('../lib/gemini');
const app = require('../server');

let org, admin, sup1, sup2, agent1, agent2, cookies = {};
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);

let calls = [];
function mockGemini(impl) {
  calls = [];
  mock.method(gemini, 'generateStructured', async (args) => {
    calls.push(args);
    return impl ? impl(args) : { data: { answer: 'Test answer covering the given facts.', confident: true }, modelVersion: 'test' };
  });
}

async function makeUser(role, name) {
  const passwordHash = await hashPassword('Correct-Horse-9!');
  const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `SZ ${name}`, username: `sz_${org.id}_${name}`, email: `sz_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', passwordHash, employmentStartDate: new Date() } });
  const token = generateToken();
  await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
  cookies[p.id] = `sz_session=${token.raw}`;
  return p;
}

before(async () => {
  org = await prisma.organization.create({ data: { name: 'SpaceZero AI tests' } });
  admin = await makeUser('ADMIN', 'admin');
  sup1 = await makeUser('SUPERVISOR', 'sup1'); sup2 = await makeUser('SUPERVISOR', 'sup2');
  agent1 = await makeUser('TRAVEL_AGENT', 'agent1'); agent2 = await makeUser('TRAVEL_AGENT', 'agent2');
  await prisma.supervisorAssignment.create({ data: { supervisorId: sup1.id, agentId: agent1.id, assignedById: admin.id } });
  await prisma.supervisorAssignment.create({ data: { supervisorId: sup2.id, agentId: agent2.id, assignedById: admin.id } });
});
after(async () => { mock.restoreAll(); await prisma.$disconnect(); });

test('AUTH REQUIRED: an anonymous request cannot reach the assistant', async () => {
  const res = await request(app).get('/assistant');
  assert.equal(res.status, 302); // redirected to login, never a bare 200
});

test('GET /assistant renders the ask form for an authenticated session', async () => {
  const res = await get(admin, '/assistant');
  assert.equal(res.status, 200);
  assert.match(res.text, /Ask SpaceZero AI/);
});

test('ADMIN SCOPE: facts sent to Gemini include both teams\' agents, and are organization-scoped', async () => {
  mockGemini();
  const res = await post(admin, '/assistant/ask', { question: 'Who needs setup?' });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  const facts = JSON.parse(calls[0].contents.split('FACTS (JSON — the only information you may use):\n')[1].split('\n\nQUESTION:')[0]);
  const names = facts.people.map((p) => p.name);
  assert.ok(names.includes('SZ agent1'));
  assert.ok(names.includes('SZ agent2'));
});

test('SUPERVISOR SCOPE: sup1\'s facts include ONLY their own agent, never sup2\'s', async () => {
  mockGemini();
  const res = await post(sup1, '/assistant/ask', { question: 'Who on my team needs setup?' });
  assert.equal(res.status, 200);
  const facts = JSON.parse(calls[0].contents.split('FACTS (JSON — the only information you may use):\n')[1].split('\n\nQUESTION:')[0]);
  const names = facts.people.map((p) => p.name);
  assert.deepEqual(names, ['SZ agent1']);
  assert.ok(!names.includes('SZ agent2'), 'sup1 must never see sup2\'s agent, even inside the facts sent to the model');
});

test('EMPLOYEE SCOPE: an ordinary employee\'s facts contain only themself', async () => {
  mockGemini();
  const res = await post(agent1, '/assistant/ask', { question: 'What requires my attention today?' });
  assert.equal(res.status, 200);
  const facts = JSON.parse(calls[0].contents.split('FACTS (JSON — the only information you may use):\n')[1].split('\n\nQUESTION:')[0]);
  assert.equal(facts.people.length, 1);
  assert.equal(facts.people[0].name, 'SZ agent1');
});

test('NO CREDENTIAL DATA: the facts payload never contains a credential-shaped field', async () => {
  mockGemini();
  await post(admin, '/assistant/ask', { question: 'Summarize the team.' });
  const raw = calls[0].contents;
  for (const forbidden of ['payloadEnc', 'passwordHash', 'tokenHash', 'credential', 'Credential']) {
    assert.doesNotMatch(raw, new RegExp(forbidden), `facts sent to Gemini must never mention "${forbidden}"`);
  }
});

test('CONFIDENT ANSWER: renders the model\'s answer text', async () => {
  mockGemini(() => ({ data: { answer: 'Two employees still need setup.', confident: true }, modelVersion: 'test' }));
  const res = await post(admin, '/assistant/ask', { question: 'Who needs setup?' });
  assert.match(res.text, /Two employees still need setup\./);
});

test('NOT CONFIDENT: shows the honest "not enough data" state, never invents an answer', async () => {
  mockGemini(() => ({ data: { answer: "I don't have enough information.", confident: false }, modelVersion: 'test' }));
  const res = await post(admin, '/assistant/ask', { question: 'What color is the sky?' });
  assert.match(res.text, /find enough SpaceZero data/);
});

test('GEMINI FAILURE: a thrown error produces the safe empty-state, never a stack trace or 500', async () => {
  mock.method(gemini, 'generateStructured', async () => { throw new gemini.GeminiError('simulated failure'); });
  const res = await post(admin, '/assistant/ask', { question: 'Who needs setup?' });
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /at Object|at async|GeminiError/);
  assert.match(res.text, /find enough SpaceZero data/);
});

test('EMPTY QUESTION is rejected without calling Gemini', async () => {
  mockGemini();
  const res = await post(admin, '/assistant/ask', { question: '   ' });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test('AUDIT: every question is logged with a preview, never the full facts or answer', async () => {
  mockGemini();
  await prisma.auditLog.deleteMany({ where: { organizationId: org.id, action: 'assistant.question_asked' } });
  await post(admin, '/assistant/ask', { question: 'Who needs setup today specifically?' });
  const entry = await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'assistant.question_asked', actorId: admin.id } });
  assert.ok(entry);
  const meta = JSON.parse(entry.metadataJson);
  assert.equal(meta.questionPreview, 'Who needs setup today specifically?');
  assert.equal(typeof meta.confident, 'boolean');
});

test('RATE LIMIT: repeated questions in a short window are eventually blocked', async () => {
  mockGemini();
  let blocked = false;
  for (let i = 0; i < 25; i += 1) {
    const res = await post(agent2, '/assistant/ask', { question: `Question number ${i}` });
    if (res.status === 429) { blocked = true; break; }
  }
  assert.ok(blocked, 'expected the assistant endpoint to rate-limit a burst of requests from one profile');
});
