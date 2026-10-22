'use strict';
// Practice results are saved once and never lost: an AI hiccup while scoring a role-play or grading a written
// answer keeps everything the learner did, the same quiz sitting sent twice (a double tap, a refresh of the
// result page) records ONE attempt, and every correct answer saved by the AI or an Admin is one of its options.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const gemini = require('../lib/gemini');
// Each AI call takes the next queued reply: an Error is thrown, a function is called with the request, anything else is returned.
const replies = []; const calls = [];
mock.method(gemini, 'generateText', async () => ({ text: 'Customer reply' }));
mock.method(gemini, 'generateStructured', async (args) => {
  calls.push(args);
  const next = replies.shift();
  if (next instanceof Error) throw next;
  if (typeof next === 'function') return next(args);
  if (!next) throw new Error('No AI reply queued');
  return next;
});
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { generateQuestionAssessment } = require('../lib/practiceEngine');
const { readQuestionForm } = require('../lib/practiceReview');
const { openSession } = require('../lib/practiceSessions');
const app = require('../server');

let org, admin; const cookies = {}; let n = 0;
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);
const sessionIdIn = (html) => (/name="sessionId" value="([^"]+)"/.exec(html) || [])[1];
async function person(role = 'TRAVEL_AGENT') {
  n += 1;
  const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `Saving ${n}`, username: `ps_${org.id}_${n}`, email: `ps_${org.id}_${n}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
  const t = generateToken(); await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookies[p.id] = `sz_session=${t.raw}`;
  return p;
}
const course = () => prisma.trainingCourse.create({ data: { organizationId: org.id, title: `Saving course ${++n}`, createdById: admin.id, status: 'PUBLISHED', passingScore: 70, publishedVersion: 1 } });
async function practice(courseId, { type = 'QUIZ', configJson = null, questions = [] } = {}) {
  const a = await prisma.assessment.create({ data: { organizationId: org.id, courseId, createdVia: 'ADMIN_MANUAL', type, title: `${type} ${++n}`, status: 'APPROVED', level: 3, passingScore: 70, createdById: admin.id, version: 1, configJson } });
  const qs = [];
  for (const [i, q] of questions.entries()) qs.push(await prisma.question.create({ data: { assessmentId: a.id, type: q.type, prompt: `Question ${i + 1}`, optionsJson: q.options ? JSON.stringify(q.options) : null, correctAnswerJson: JSON.stringify(q.correct), skillIdsJson: JSON.stringify(q.skills || []), displayOrder: i } }));
  return { a, qs };
}
async function learnerOn(courseId) {
  const learner = await person();
  const assignment = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId, assignedById: admin.id, scope: 'INDIVIDUAL' } });
  await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: assignment.id, profileId: learner.id } });
  return learner;
}
const attemptsOf = (a) => prisma.trainingAttempt.count({ where: { assessmentId: a.id } });

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Practice saving tests' } });
  admin = await person('ADMIN');
  await prisma.skill.create({ data: { organizationId: org.id, roleKey: 'TRAVEL_AGENT', name: 'Discovery', category: 'Sales' } });
});
after(async () => { mock.restoreAll(); await prisma.$disconnect(); });

test('role-play: if scoring fails on Finish the conversation is kept with a clear message, and Finish again saves the result', async () => {
  const c = await course();
  const config = JSON.stringify({ customerPersonality: 'busy executive', scenarioBrief: 'A client wants a deal.', openingLine: 'Hi.', rubricSkills: ['Discovery'] });
  const { a } = await practice(c.id, { type: 'ROLEPLAY', configJson: config });
  const learner = await learnerOn(c.id);
  await get(learner, `/assessments/${a.id}/roleplay`);
  const session = await prisma.practiceSession.findFirst({ where: { assessmentId: a.id, profileId: learner.id } });
  await post(learner, `/assessments/${a.id}/roleplay/message`, { sessionId: session.id, message: 'Which dates suit you?' });

  replies.push(new Error('Gemini timeout'));
  const failed = await post(learner, `/assessments/${a.id}/roleplay/finish`, { sessionId: session.id });
  assert.equal(failed.status, 503);
  assert.match(failed.text, /Scoring is unavailable right now\. Your conversation is saved/);
  assert.match(failed.text, /id="rp-finish-form"/); // the conversation page itself, not the generic error page
  assert.equal(sessionIdIn(failed.text), session.id);
  assert.equal(await attemptsOf(a), 0);
  const kept = await prisma.practiceSession.findUnique({ where: { id: session.id } });
  assert.equal(kept.busy, false);
  assert.equal(kept.completedAttemptId, null);
  assert.ok(JSON.parse(kept.dataJson).transcript.some((t) => t.text === 'Which dates suit you?'));

  replies.push({ modelVersion: 'test', data: { overallScore: 84, skillScores: [{ skill: 'Discovery', score: 84 }], feedback: 'Good discovery.' } });
  const finished = await post(learner, `/assessments/${a.id}/roleplay/finish`, { sessionId: session.id });
  assert.equal(finished.status, 200);
  assert.equal(await attemptsOf(a), 1);
});

test('quiz: if a written answer cannot be graded, the quiz comes back with every answer filled in and nothing is saved', async () => {
  const c = await course();
  const { a, qs } = await practice(c.id, { questions: [{ type: 'MCQ', options: ['Right', 'Wrong'], correct: 'Right' }, { type: 'SHORT_ANSWER', correct: 'Verify the fare rules first' }] });
  const learner = await learnerOn(c.id);
  const sessionId = sessionIdIn((await get(learner, `/assessments/${a.id}/take`)).text);
  assert.ok(sessionId);
  const answers = { sessionId, [`q_${qs[0].id}`]: 'Right', [`q_${qs[1].id}`]: 'I would check the fare rules' };

  replies.push(new Error('Gemini 429'));
  const failed = await post(learner, `/assessments/${a.id}/submit`, answers);
  assert.equal(failed.status, 503);
  assert.match(failed.text, /could not be graded right now\. Nothing was lost/);
  assert.match(failed.text, /value="Right" required checked/);
  assert.match(failed.text, />I would check the fare rules<\/textarea>/);
  assert.equal(sessionIdIn(failed.text), sessionId);
  assert.equal(await attemptsOf(a), 0);

  replies.push({ modelVersion: 'test', data: { results: [{ index: 0, scorePercent: 90, feedback: 'Correct idea.' }] } });
  const graded = await post(learner, `/assessments/${a.id}/submit`, answers);
  assert.equal(graded.status, 200);
  assert.match(graded.text, /Passed/);
  assert.equal(await attemptsOf(a), 1);
});

test('quiz: the same sitting submitted twice at once, or again from a refreshed result page, records ONE attempt', async () => {
  const c = await course();
  const { a, qs } = await practice(c.id, { questions: [{ type: 'MCQ', options: ['Right', 'Wrong'], correct: 'Right', skills: ['Discovery'] }] });
  const learner = await learnerOn(c.id);
  const sessionId = sessionIdIn((await get(learner, `/assessments/${a.id}/take`)).text);
  const answers = { sessionId, [`q_${qs[0].id}`]: 'Right' };

  const [first, second] = await Promise.all([post(learner, `/assessments/${a.id}/submit`, answers), post(learner, `/assessments/${a.id}/submit`, answers)]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.match(second.text, /Attempt 1/);
  const refreshed = await post(learner, `/assessments/${a.id}/submit`, answers);
  assert.equal(refreshed.status, 200);
  assert.match(refreshed.text, /Attempt 1/);
  assert.equal(await attemptsOf(a), 1);
  assert.equal(await prisma.skillEvidence.count({ where: { assessmentId: a.id } }), 1);

  // Opening the quiz again starts a new sitting: a real retake is still a new attempt.
  const again = sessionIdIn((await get(learner, `/assessments/${a.id}/take`)).text);
  assert.notEqual(again, sessionId);
  await post(learner, `/assessments/${a.id}/submit`, { sessionId: again, [`q_${qs[0].id}`]: 'Wrong' });
  assert.equal(await attemptsOf(a), 2);
});

test('two requests opening the same practice at once share ONE sitting (a form without a sitting id sent twice)', async () => {
  const c = await course();
  const { a } = await practice(c.id, { questions: [{ type: 'MCQ', options: ['Right', 'Wrong'], correct: 'Right' }] });
  const learner = await learnerOn(c.id);
  const [first, second] = await Promise.all([openSession(learner.id, a, {}), openSession(learner.id, a, {})]);
  assert.equal(first.id, second.id);
  assert.equal(await prisma.practiceSession.count({ where: { assessmentId: a.id, profileId: learner.id } }), 1);
});

test('the Admin question editor saves several correct answers as a list, so an option with a comma stays whole', () => {
  const { data } = readQuestionForm({ type: 'MULTI_SELECT', prompt: 'Which are included?', options: 'Seat selection, meals\nLounge access\nWi-Fi', correctAnswer: 'Seat selection, meals\nLounge access' });
  assert.deepEqual(JSON.parse(data.correctAnswerJson), ['Seat selection, meals', 'Lounge access']);
});

const analysis = { extractedSkillsJson: '["Discovery"]', criticalKnowledgeJson: '[]', practicalBehaviorsJson: '[]', commonMistakesJson: '[]', sourceReferencesJson: '{}' };
const generated = (questions) => ({ modelVersion: 'test', data: { questions } });

test('AI-written answers are fitted to their options; an unanswerable question is rewritten once, else left out', async () => {
  const c = await course();
  replies.push(generated([
    { type: 'MCQ', prompt: 'First step?', options: ['Quote at once', 'Check the fare rules'], correctAnswer: 'B' },
    { type: 'MCQ', prompt: 'Who pays the penalty?', options: ['The client', 'The agency'], correctAnswer: 'Nobody' },
    { type: 'MULTI_SELECT', prompt: 'What is included?', options: ['Seat selection, meals', 'Lounge access', 'Wi-Fi'], correctAnswer: 'seat selection, meals, Lounge access' },
  ]));
  replies.push(generated([{ type: 'MCQ', prompt: 'Who pays the change penalty?', options: ['The client', 'The agency'], correctAnswer: 'The client' }]));
  const made = await generateQuestionAssessment({ course: c, analysis, actor: admin, type: 'QUIZ', questionCount: 3 });
  const saved = await prisma.question.findMany({ where: { assessmentId: made.id }, orderBy: { displayOrder: 'asc' } });
  assert.deepEqual(saved.map((q) => JSON.parse(q.correctAnswerJson)), ['Check the fare rules', 'The client', ['Seat selection, meals', 'Lounge access']]);
  assert.equal(saved[1].prompt, 'Who pays the change penalty?');
  assert.match(JSON.stringify(calls.at(-1).contents), /not one of the options/);

  replies.push(generated([
    { type: 'MCQ', prompt: 'Good one', options: ['Yes', 'No'], correctAnswer: 'Yes' },
    { type: 'MCQ', prompt: 'Broken one', options: ['Yes', 'No'], correctAnswer: 'Maybe' },
    { type: 'TRUE_FALSE', prompt: 'True or false?', correctAnswer: 'false' },
  ]));
  replies.push(generated([{ type: 'MCQ', prompt: 'Still broken', options: ['Yes', 'No'], correctAnswer: 'Perhaps' }]));
  const second = await generateQuestionAssessment({ course: c, analysis, actor: admin, type: 'QUIZ', questionCount: 3 });
  const kept = await prisma.question.findMany({ where: { assessmentId: second.id }, orderBy: { displayOrder: 'asc' } });
  assert.deepEqual(kept.map((q) => q.prompt), ['Good one', 'True or false?']);
  assert.equal(JSON.parse(kept[1].correctAnswerJson), 'False');
});

test('Admin review flags an existing question whose correct answer is not one of its options', async () => {
  const c = await course();
  const { a } = await practice(c.id, { questions: [{ type: 'MCQ', options: ['Check the fare rules', 'Quote at once'], correct: 'B' }, { type: 'MCQ', options: ['Yes', 'No'], correct: 'Yes' }] });
  const page = await get(admin, `/admin/assessments/${a.id}`);
  assert.equal(page.status, 200);
  assert.equal((page.text.match(/data-answer-problem/g) || []).length, 1);
  assert.match(page.text, /The correct answer &#34;B&#34; is not one of the options/);
});
