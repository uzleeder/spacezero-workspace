'use strict';
// Smart Retake end to end: passing a retake passes the practice it retakes (both attempts stay in history), a
// retake opens for every kind of assignment, it always aims at something (weak skills, else the weakest, else
// the whole practice), a double tap builds ONE retake, an AI failure gives a clear way forward, and a retake is
// written from the learner's own version of the material - never from a newer draft.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const gemini = require('../lib/gemini');
const prompts = []; let aiDown = false; let delayMs = 0;
mock.method(gemini, 'generateStructured', async (input) => {
  prompts.push(input);
  if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  if (aiDown) throw new Error('Gemini unavailable');
  return { modelVersion: 'test', data: { questions: Array.from({ length: 8 }, (_, i) => ({ type: 'MCQ', prompt: `Retake question ${i + 1}`, options: ['Right', 'Wrong'], correctAnswer: 'Right', skillNames: ['Discovery'] })) } };
});
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { computeSourceHash } = require('../lib/trainingAnalysis');
const app = require('../server');

let org, admin; const cookies = {}; let n = 0;
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const idIn = (location) => location.split('/')[2];
async function person() {
  n += 1;
  const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `Retake ${n}`, username: `rf_${org.id}_${n}`, email: `rf_${org.id}_${n}@example.invalid`, role: 'TRAVEL_AGENT', status: 'ACTIVE', employmentStartDate: new Date() } });
  const t = generateToken(); await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookies[p.id] = `sz_session=${t.raw}`;
  return p;
}
/** A training with one quiz (two Discovery questions) and a learner assigned to it; `specific` assigns that one practice. */
async function setup({ specific = false, version = 1, draftVersion = version, analysis = { status: 'APPROVED' }, skills = ['Discovery'] } = {}) {
  const course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: `Retake flow ${++n}`, createdById: admin.id, status: 'PUBLISHED', passingScore: 70, publishedVersion: version, draftVersion, analysis: { create: analysis } } });
  const quiz = await prisma.assessment.create({ data: { organizationId: org.id, courseId: course.id, createdVia: 'ADMIN_MANUAL', type: 'QUIZ', title: 'Original quiz', status: 'APPROVED', level: 2, passingScore: 70, createdById: admin.id, version } });
  const questions = [];
  for (let i = 0; i < 2; i += 1) questions.push(await prisma.question.create({ data: { assessmentId: quiz.id, type: 'MCQ', prompt: `Original question ${i + 1}: confirm the fare rules`, optionsJson: JSON.stringify(['Right', 'Wrong']), correctAnswerJson: JSON.stringify('Right'), skillIdsJson: JSON.stringify(skills), displayOrder: i } }));
  const learner = await person();
  const assignment = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.id, scope: 'INDIVIDUAL', courseVersion: version, assessmentId: specific ? quiz.id : null } });
  const recipient = await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: assignment.id, profileId: learner.id } });
  return { course, quiz, questions, learner, recipient };
}
const answerAll = async (learner, assessment, value) => {
  const qs = await prisma.question.findMany({ where: { assessmentId: assessment.id } });
  return post(learner, `/assessments/${assessment.id}/submit`, Object.fromEntries(qs.map((q) => [`q_${q.id}`, value])));
};

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Retake flow tests' } });
  admin = await person();
  await require('../lib/orgSettings').setSetting(org.id, 'training.retakeWaitMinutes', 0, admin.id); // these tests fail and retry straight away
  await prisma.profile.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });
});
after(async () => { mock.restoreAll(); await prisma.$disconnect(); });

test('passing the smart retake passes the original practice: the training can be submitted, both attempts kept', async () => {
  const { quiz, learner, recipient } = await setup();
  await answerAll(learner, quiz, 'Wrong');
  const response = await post(learner, `/assessments/${quiz.id}/remediate`);
  assert.equal(response.status, 302);
  const retake = await prisma.assessment.findUnique({ where: { id: idIn(response.headers.location) } });
  assert.equal(JSON.parse(retake.configJson).retakeOf, quiz.id);
  const result = await answerAll(learner, retake, 'Right');
  assert.equal(result.status, 200);
  assert.match(result.text, /Passed/); // one main button: back to the training, which is finished now
  assert.match(result.text, new RegExp(`href="/training-course/${quiz.courseId}" data-result-next>Continue<`));

  const complete = await post(learner, `/training/${recipient.id}/complete`);
  assert.equal(complete.status, 302);
  assert.equal(complete.headers.location, '/training');
  const attempts = await prisma.trainingAttempt.findMany({ where: { recipientId: recipient.id }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(attempts.map((t) => [t.assessmentId, t.status]), [[quiz.id, 'RETAKE_REQUIRED'], [retake.id, 'COMPLETED'], [null, 'COMPLETED']]);
});

test('a retake made before retakes recorded their practice still counts for the practice the learner had just failed', async () => {
  const { quiz, learner, recipient } = await setup();
  await answerAll(learner, quiz, 'Wrong');
  const older = await prisma.assessment.create({ data: { organizationId: org.id, courseId: quiz.courseId, createdVia: 'AI_TRAINING_ANALYSIS', type: 'QUIZ', title: 'Older retake', status: 'APPROVED', level: 3, passingScore: 70, createdById: learner.id, configJson: JSON.stringify({ targetedRetake: true, focusSkills: ['Discovery'] }) } });
  await prisma.question.create({ data: { assessmentId: older.id, type: 'MCQ', prompt: 'Older retake question', optionsJson: JSON.stringify(['Right', 'Wrong']), correctAnswerJson: JSON.stringify('Right'), skillIdsJson: '[]' } });
  assert.equal((await answerAll(learner, older, 'Right')).status, 200);
  const complete = await post(learner, `/training/${recipient.id}/complete`);
  assert.equal(complete.status, 302);
  assert.equal(await prisma.trainingAttempt.count({ where: { recipientId: recipient.id, assessmentId: null, status: 'COMPLETED' } }), 1);
});

test('a retake opens for a training assigned for one specific practice', async () => {
  const { quiz, learner } = await setup({ specific: true });
  await answerAll(learner, quiz, 'Wrong');
  const response = await post(learner, `/assessments/${quiz.id}/remediate`);
  assert.equal(response.status, 302);
  assert.equal((await get(learner, response.headers.location)).status, 200);
});

test('when the overall score fails but every skill passes, the retake aims at the weakest skills', async () => {
  const { quiz, learner, recipient } = await setup();
  await prisma.trainingAttempt.create({ data: { recipientId: recipient.id, profileId: learner.id, assessmentId: quiz.id, status: 'RETAKE_REQUIRED', score: 64, attemptNumber: 1, completedAt: new Date(), skillBreakdownJson: JSON.stringify({ Discovery: 80, Closing: 72, Listening: 91 }) } });
  const response = await post(learner, `/assessments/${quiz.id}/remediate`);
  assert.equal(response.status, 302);
  const retake = await prisma.assessment.findUnique({ where: { id: idIn(response.headers.location) } });
  assert.deepEqual(JSON.parse(retake.configJson).focusSkills, ['Closing', 'Discovery']);
});

test('a double tap builds ONE retake, and pressing Retake again opens the same one', async () => {
  const { quiz, learner } = await setup();
  await answerAll(learner, quiz, 'Wrong');
  const before = prompts.length;
  delayMs = 80;
  const [a, b] = await Promise.all([post(learner, `/assessments/${quiz.id}/remediate`), post(learner, `/assessments/${quiz.id}/remediate`)]);
  delayMs = 0;
  assert.deepEqual([a.status, b.status].sort(), [302, 409]);
  assert.match((a.status === 409 ? a : b).text, /already being prepared/);
  assert.equal(prompts.length, before + 1);
  const again = await post(learner, `/assessments/${quiz.id}/remediate`);
  assert.equal(again.headers.location, (a.status === 302 ? a : b).headers.location);
  assert.equal(prompts.length, before + 1);
  assert.equal(await prisma.assessment.count({ where: { courseId: quiz.courseId } }), 2);
});

test('if no new set can be prepared, the only way on is the original quiz as it is', async () => {
  const { quiz, learner } = await setup();
  await answerAll(learner, quiz, 'Wrong');
  aiDown = true;
  const response = await post(learner, `/assessments/${quiz.id}/remediate`);
  aiDown = false;
  assert.equal(response.status, 503);
  assert.match(response.text, /A new set of questions could not be prepared right now\./); assert.match(response.text, /Nothing was lost/);
  assert.match(response.text, new RegExp(`href="/assessments/${quiz.id}/take" data-result-next>Take the quiz as it is<`));
  assert.equal((response.text.match(/class="btn /g) || []).length, 1);                      // one way on
  assert.equal(await prisma.assessment.count({ where: { courseId: quiz.courseId } }), 1);
});

test('a retake is written from the learner\'s own version: a newer draft\'s analysis is never used, and the retake carries that version', async () => {
  // The learner has version 1; AI Practice has since analysed the material of a version 2 draft.
  const { quiz, learner } = await setup({ version: 1, draftVersion: 2, analysis: { status: 'APPROVED', sourceHash: 'hash-of-the-version-2-draft', criticalKnowledgeJson: JSON.stringify(['DRAFT-ONLY RULE']) } });
  await answerAll(learner, quiz, 'Wrong');
  const response = await post(learner, `/assessments/${quiz.id}/remediate`);
  assert.equal(response.status, 302);
  const sent = JSON.stringify(prompts.at(-1).contents);
  assert.doesNotMatch(sent, /DRAFT-ONLY RULE/);
  assert.match(sent, /Original question 1: confirm the fare rules/);
  const retake = await prisma.assessment.findUnique({ where: { id: idIn(response.headers.location) } });
  assert.equal(retake.version, 1);
  assert.equal((await get(learner, response.headers.location)).status, 200);
});

test('while the analysis still describes the learner\'s material, the retake is written from it', async () => {
  const { course, quiz, learner } = await setup({ analysis: { status: 'APPROVED', criticalKnowledgeJson: JSON.stringify(['RULE FROM THE ANALYSIS']) } });
  await prisma.trainingAnalysis.update({ where: { courseId: course.id }, data: { sourceHash: computeSourceHash([]) } });
  await answerAll(learner, quiz, 'Wrong');
  await post(learner, `/assessments/${quiz.id}/remediate`);
  assert.match(JSON.stringify(prompts.at(-1).contents), /RULE FROM THE ANALYSIS/);
});
