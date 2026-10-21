'use strict';
// When the AI fails the learner keeps their answers; every AI request is counted against the limits; the buttons a learner
// can press repeatedly (focused practice, role-play) cannot run up Gemini costs.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');

let geminiCalls = 0;
mock.method(require('../lib/gemini'), 'generateStructured', async () => { geminiCalls += 1; throw new Error('AI is down'); });
mock.method(require('../lib/gemini'), 'generateText', async () => { geminiCalls += 1; throw new Error('AI is down'); });

const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { takeAiSlot, AI_RATE_LIMIT } = require('../lib/rateLimit');
const app = require('../server');

let org, admin, agent, course, written, roleplay, targeted, cookies = {};
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);

before(async () => {
  org = await prisma.organization.create({ data: { name: 'AI limit tests' } });
  const mk = async (role, name) => {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `AL ${name}`, username: `al_${org.id}_${name}`, email: `al_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
    const t = generateToken(); await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookies[p.id] = `sz_session=${t.raw}`;
    return p;
  };
  admin = await mk('ADMIN', 'admin'); agent = await mk('TRAVEL_AGENT', 'agent');
  course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'AI limits', createdById: admin.id, status: 'PUBLISHED', publishedVersion: 1 } });
  await prisma.trainingAnalysis.create({ data: { courseId: course.id, status: 'APPROVED', criticalKnowledgeJson: '[]', practicalBehaviorsJson: '[]', commonMistakesJson: '[]', extractedSkillsJson: JSON.stringify(['Fare rules']), sourceReferencesJson: '{}' } }).catch(() => undefined);
  written = await prisma.assessment.create({ data: { organizationId: org.id, courseId: course.id, createdVia: 'ADMIN_MANUAL', type: 'QUIZ', status: 'APPROVED', title: 'Written', createdById: admin.id, version: 1 } });
  await prisma.question.create({ data: { assessmentId: written.id, type: 'SHORT_ANSWER', prompt: 'Explain the fare rule', correctAnswerJson: JSON.stringify('Advance purchase'), displayOrder: 0 } });
  await prisma.question.create({ data: { assessmentId: written.id, type: 'MCQ', prompt: 'Pick one', optionsJson: JSON.stringify(['A', 'B']), correctAnswerJson: JSON.stringify('A'), displayOrder: 1 } });
  roleplay = await prisma.assessment.create({ data: { organizationId: org.id, courseId: course.id, createdVia: 'ADMIN_MANUAL', type: 'ROLEPLAY', status: 'APPROVED', title: 'Role', createdById: admin.id, version: 1, configJson: JSON.stringify({ openingLine: 'Hello', customerPersonality: 'calm', scenarioBrief: 'x', rubricSkills: ['Tone'] }) } });
  const a = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.id, scope: 'INDIVIDUAL' } });
  const recipient = await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: a.id, profileId: agent.id } });
  await prisma.trainingAttempt.create({ data: { recipientId: recipient.id, profileId: agent.id, assessmentId: written.id, status: 'RETAKE_REQUIRED', score: 30, attemptNumber: 1, completedAt: new Date(Date.now() - 20 * 60000), skillBreakdownJson: JSON.stringify({ 'Fare rules': 30 }) } });
  targeted = await prisma.assessment.create({ data: { organizationId: org.id, courseId: course.id, createdVia: 'AI_TRAINING_ANALYSIS', type: 'QUIZ', status: 'APPROVED', title: 'Targeted', createdById: agent.id, version: 1, configJson: JSON.stringify({ targetedRetake: true, retakeOf: written.id, focusSkills: ['Fare rules'] }) } });
});
after(async () => { await prisma.$disconnect(); });

test('when the AI cannot mark written answers the quiz comes back with every answer kept and nothing is recorded', async () => {
  const res = await post(agent, `/assessments/${written.id}/submit`, Object.fromEntries((await prisma.question.findMany({ where: { assessmentId: written.id }, orderBy: { displayOrder: 'asc' } })).map((q, i) => [`q_${q.id}`, i === 0 ? 'Book early, it is cheaper' : 'B'])));
  assert.equal(res.status, 503);
  assert.match(res.text, /Nothing was lost/);
  assert.match(res.text, /Book early, it is cheaper/);                                   // the typed answer is still in the box
  assert.match(res.text, /value="B"[^>]*checked/);                                       // the chosen option is still chosen
  assert.equal(await prisma.trainingAttempt.count({ where: { profileId: agent.id, assessmentId: written.id } }), 1);   // only the earlier one
});

test('every AI request is counted: the per-person limit trips, and one company-wide ceiling covers everybody', async () => {
  for (let i = 0; i < AI_RATE_LIMIT.maxAttempts; i++) assert.equal(await takeAiSlot(admin), true);
  assert.equal(await takeAiSlot(admin), false);                                          // the 21st inside ten minutes
  assert.equal(await prisma.rateLimitAttempt.count({ where: { bucketKey: `ai:${admin.id}` } }), AI_RATE_LIMIT.maxAttempts);
  assert.equal(await takeAiSlot(agent), true);                                           // someone else is not held back by it
  const spaceZeroAi = await post(admin, '/assistant/ask', { question: 'How is the team?' });
  assert.equal(spaceZeroAi.status, 429);
});

test('"Practice these skills now" reuses the practice already prepared and is limited per day; role-play turns are limited per hour', async () => {
  const before = geminiCalls;
  const again = await post(agent, `/assessments/${written.id}/remediate`);              // one was prepared from this result: it opens, nothing is generated
  assert.equal(again.status, 302); assert.equal(again.headers.location, `/assessments/${targeted.id}/take`);
  assert.equal(geminiCalls, before);

  await prisma.assessment.update({ where: { id: targeted.id }, data: { archivedAt: new Date() } });   // nothing prepared any more: a new one needs the AI
  for (let i = 0; i < 5; i++) await prisma.rateLimitAttempt.create({ data: { bucketKey: `remediate:${agent.id}`, succeeded: true } });
  const limited = await post(agent, `/assessments/${written.id}/remediate`);
  assert.equal(limited.status, 429); assert.match(limited.text, /several focused practices today/);
  assert.equal(geminiCalls, before);

  await get(agent, `/assessments/${roleplay.id}/roleplay`);
  const session = await prisma.practiceSession.findFirst({ where: { profileId: agent.id, assessmentId: roleplay.id } });
  for (let i = 0; i < 60; i++) await prisma.rateLimitAttempt.create({ data: { bucketKey: `ai-learner:${agent.id}`, succeeded: true } });
  const message = await request(app).post(`/assessments/${roleplay.id}/roleplay/message`).set('Cookie', cookies[agent.id]).send({ sessionId: session.id, message: 'Hi, how can I help?' });
  assert.equal(message.status, 429); assert.match(message.body.error, /saved/);
  assert.equal(geminiCalls, before);                                                      // the AI was not asked
});
