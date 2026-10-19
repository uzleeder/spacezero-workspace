'use strict';
// The AI writes the correct answer first ("A"). Answer choices must be stirred: when the question is
// saved, and for older quizzes when a learner opens them. Grading compares the answer text, so it is unaffected.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

// 12 questions, each written the way the AI does it: the correct answer first.
const aiQuestions = Array.from({ length: 12 }, (_, i) => ({
  type: ['MCQ', 'MULTI_SELECT', 'SCENARIO', 'ORDERING', 'TRUE_FALSE', 'SHORT_ANSWER'][i % 6],
  prompt: `Question ${i + 1}`,
  options: ['TRUE_FALSE', 'SHORT_ANSWER'].includes(['MCQ', 'MULTI_SELECT', 'SCENARIO', 'ORDERING', 'TRUE_FALSE', 'SHORT_ANSWER'][i % 6]) ? (i % 6 === 4 ? ['True', 'False'] : undefined) : [`Right ${i}`, `Wrong ${i}a`, `Wrong ${i}b`, `Wrong ${i}c`, 'All of the above'],
  correctAnswer: `Right ${i}`,
}));
mock.method(require('../lib/gemini'), 'generateStructured', async () => ({ modelVersion: 'test', data: { questions: aiQuestions } }));
const { generateQuestionAssessment } = require('../lib/practiceEngine');
const { shuffleOptions, displayOptions, shuffleChoices } = require('../lib/shuffleOptions');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const app = require('../server');

let org, admin, agent, course, assignmentRecipient, cookie;
before(async () => {
  org = await prisma.organization.create({ data: { name: 'Shuffle tests' } });
  const mk = async (role, name) => prisma.profile.create({ data: { organizationId: org.id, fullName: name, username: `sh_${org.id}_${name}`, email: `sh_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
  admin = await mk('ADMIN', 'admin'); agent = await mk('TRAVEL_AGENT', 'agent');
  const t = generateToken(); await prisma.session.create({ data: { profileId: agent.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookie = `sz_session=${t.raw}`;
  course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Shuffle course', createdById: admin.id, status: 'PUBLISHED', passingScore: 70 } });
  const assignment = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.id, scope: 'INDIVIDUAL' } });
  assignmentRecipient = await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: assignment.id, profileId: agent.id } });
});
after(async () => { mock.restoreAll(); await prisma.$disconnect(); });

test('shuffleOptions keeps the same choices, always changes the AI order, and leaves "All of the above" last', () => {
  const options = ['Right', 'B', 'C', 'D', 'All of the above'];
  for (let i = 0; i < 200; i += 1) {
    const out = shuffleOptions('MCQ', options);
    assert.deepEqual([...out].sort(), [...options].sort());
    assert.equal(out[out.length - 1], 'All of the above');
    assert.notDeepEqual(out, options);
  }
  assert.deepEqual(shuffleOptions('TRUE_FALSE', ['True', 'False']), ['True', 'False']); // fixed order
  assert.deepEqual(shuffleOptions('MCQ', ['Only one']), ['Only one']);
  assert.equal(shuffleOptions('MCQ', undefined), undefined);
  // the correct answer lands in every position over many draws (it is not stuck on top)
  const seen = new Set();
  for (let i = 0; i < 300; i += 1) seen.add(shuffleOptions('MCQ', ['Right', 'B', 'C', 'D']).indexOf('Right'));
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3]);
});

test('workflow-simulation choices are stirred too, with their scores and next steps attached', () => {
  const choices = [{ label: 'Best action', score: 100, nextId: 'b' }, { label: 'Okay', score: 50, nextId: 'c' }, { label: 'Bad', score: 0, nextId: null }];
  for (let i = 0; i < 50; i += 1) {
    const out = shuffleChoices(choices);
    assert.equal(out.length, 3);
    assert.deepEqual(out.map((c) => [c.label, c.score, c.nextId]).sort(), choices.map((c) => [c.label, c.score, c.nextId]).sort());
    assert.notDeepEqual(out.map((c) => c.label), choices.map((c) => c.label));
  }
});

test('a learner sees the same stirred order for a question on every visit, and it differs from the AI order', () => {
  const q = { id: 'cmq123', type: 'MCQ', prompt: 'P' };
  const options = ['Right', 'B', 'C', 'D'];
  const first = displayOptions(q, options);
  for (let i = 0; i < 5; i += 1) assert.deepEqual(displayOptions(q, options), first);
  assert.notDeepEqual(first, options);
  const positions = new Set(Array.from({ length: 80 }, (_, i) => displayOptions({ id: `q${i}`, type: 'MCQ' }, options).indexOf('Right')));
  assert.ok(positions.size >= 3, 'different questions put the right answer in different places');
});

test('generated questions are saved with stirred choices (the correct answer is no longer always first)', async () => {
  const analysis = { extractedSkillsJson: '[]', criticalKnowledgeJson: '[]', practicalBehaviorsJson: '[]', commonMistakesJson: '[]', sourceReferencesJson: '{}' };
  const assessment = await generateQuestionAssessment({ course, analysis, actor: admin, type: 'QUIZ', questionCount: 12 });
  const rows = await prisma.question.findMany({ where: { assessmentId: assessment.id }, orderBy: { displayOrder: 'asc' } });
  assert.equal(rows.length, 12);
  let firstCount = 0; let withOptions = 0;
  rows.forEach((row, i) => {
    const original = aiQuestions[i].options;
    if (!original) { assert.equal(row.optionsJson, null); return; }
    const saved = JSON.parse(row.optionsJson);
    assert.deepEqual([...saved].sort(), [...original].sort());                     // same choices
    assert.equal(JSON.parse(row.correctAnswerJson), aiQuestions[i].correctAnswer);   // same answer
    if (row.type === 'TRUE_FALSE') { assert.deepEqual(saved, original); return; }
    withOptions += 1;
    assert.notDeepEqual(saved, original);
    if (saved[0] === aiQuestions[i].correctAnswer) firstCount += 1;
  });
  assert.ok(withOptions >= 8);
  assert.ok(firstCount < withOptions, 'not every correct answer is still on top');
});

test('an older quiz saved in the AI order is shown stirred, and answers are still graded by their text', async () => {
  const assessment = await prisma.assessment.create({ data: { organizationId: org.id, courseId: course.id, createdVia: 'AI_TRAINING_ANALYSIS', type: 'QUIZ', status: 'APPROVED', title: 'Old quiz', level: 3, passingScore: 70, createdById: admin.id, version: 1 } });
  const questions = [];
  for (let i = 0; i < 6; i += 1) questions.push(await prisma.question.create({ data: { assessmentId: assessment.id, type: 'MCQ', prompt: `Old question ${i}`, optionsJson: JSON.stringify([`Right ${i}`, `X${i}`, `Y${i}`, `Z${i}`]), correctAnswerJson: JSON.stringify(`Right ${i}`), displayOrder: i } }));
  const page = await request(app).get(`/assessments/${assessment.id}/take`).set('Cookie', cookie);
  assert.equal(page.status, 200);
  const seen = (html, i) => [...html.matchAll(new RegExp(`name="q_${questions[i].id}" value="([^"]+)"`, 'g'))].map((m) => m[1]);
  let onTop = 0;
  for (let i = 0; i < 6; i += 1) {
    const order = seen(page.text, i);
    assert.deepEqual([...order].sort(), [`Right ${i}`, `X${i}`, `Y${i}`, `Z${i}`].sort());
    if (order[0] === `Right ${i}`) onTop += 1;
  }
  assert.ok(onTop < 6, 'the correct answers are not all on top');
  const again = await request(app).get(`/assessments/${assessment.id}/take`).set('Cookie', cookie);
  for (let i = 0; i < 6; i += 1) assert.deepEqual(seen(again.text, i), seen(page.text, i)); // a refresh shows the same order
  const body = Object.fromEntries(questions.map((q, i) => [`q_${q.id}`, `Right ${i}`]));
  const result = await request(app).post(`/assessments/${assessment.id}/submit`).set('Cookie', cookie).type('form').send(body);
  assert.equal(result.status, 200);
  assert.match(result.text, /100%/);
  assert.ok(assignmentRecipient.id);
});
