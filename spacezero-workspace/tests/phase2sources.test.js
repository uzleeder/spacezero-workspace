'use strict';
// Source references end to end (which page/slide/timestamp a fact or question comes from) and the
// AI source check on generated practice. Gemini is mocked with schema-shaped answers.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key-not-used';
let mode = 'ok';
const seen = [];
mock.method(require('../lib/gemini'), 'generateStructured', async (input) => {
  const props = Object.keys(input.responseSchema.properties || {});
  seen.push(props);
  if (props.includes('criticalKnowledge')) {
    return { modelVersion: 'test-model', data: { criticalKnowledge: ['A Business fare must be repriced after a segment change.'], practicalBehaviors: ['Verify the cabin on every segment.'], commonMistakes: ['Selling before checking baggage.'], sourceMap: [
      { fact: 'Reprice after any segment change', sourceTitle: 'Sabre workflow PDF', location: 'page 4' },
      { fact: 'Verify the cabin on every segment', sourceTitle: 'sabre WORKFLOW pdf', location: 'slide 9' },
      { fact: 'An invented fact', sourceTitle: 'A source that is not part of this training', location: 'page 1' },
    ] } };
  }
  if (props.includes('classifications')) return { modelVersion: 'test-model', data: { classifications: ['TECHNICAL', 'PROCESS_SOP'], objectives: ['Reprice correctly'], extractedSkills: ['Sabre Availability'], difficulty: 'MEDIUM', recommendedMethods: ['TECHNICAL', 'PROCESS_SIM'], recommendedIntensity: 4 } };
  if (props.includes('supportedBySource')) return { modelVersion: 'test-model', data: { supportedBySource: true, notes: [] } };
  if (props.includes('coverageGaps')) {
    if (mode === 'validation-down') throw new Error('Provider unavailable');
    return { modelVersion: 'test-model', data: { items: [
      { ref: 'Q1', supportedBySource: true, testsApplication: true, note: 'Matches page 4.' },
      { ref: 'Q2', supportedBySource: false, testsApplication: true, note: 'The 24-hour rule is not in the material.' },
      { ref: 'Q3', supportedBySource: true, testsApplication: false, note: 'Pure definition.' },
    ], coverageGaps: ['Ticketing time limits'] } };
  }
  if (props.includes('questions')) return { modelVersion: 'test-model', data: { questions: [
    { type: 'MCQ', prompt: 'A client changes the second segment. What must you do next?', options: ['Reprice', 'Ticket now'], correctAnswer: 'Reprice', explanation: 'Fares change with segments.', skillNames: ['Sabre Availability'], sourceTitle: 'Sabre workflow PDF', sourceLocation: 'page 4' },
    { type: 'MCQ', prompt: 'Which cabin do you verify?', options: ['Every segment', 'The first'], correctAnswer: 'Every segment', skillNames: [] },
    { type: 'TRUE_FALSE', prompt: 'A 24-hour hold is always free.', options: ['True', 'False'], correctAnswer: 'False', skillNames: [] },
  ] } };
  throw new Error('unexpected Gemini call: ' + props.join(','));
});

const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { enqueueAnalysis, runPipeline } = require('../lib/trainingAnalysis');
const app = require('../server');

let org, admin, sup, course, cookies = {};
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Source ref tests' } });
  async function user(role, name) {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `SR ${name}`, username: `sr_${org.id}_${name}`, email: `sr_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
    const token = generateToken();
    await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
    cookies[p.id] = `sz_session=${token.raw}`;
    return p;
  }
  admin = await user('ADMIN', 'admin'); sup = await user('SUPERVISOR', 'sup');
  await prisma.skill.create({ data: { organizationId: org.id, name: 'Sabre Availability', category: 'Technical', roleKey: 'FLIGHT_EXPERT' } });
  course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Sabre repricing', createdById: admin.id, modules: { create: [{ title: 'Sabre workflow PDF', contentType: 'NOTE', description: 'Reprice after any segment change. Verify the cabin on every segment.' }] } } });
});
after(async () => { mock.restoreAll(); await prisma.$disconnect(); });

test('extraction keeps a source map (page / slide / timestamp) and drops references to sources that are not part of the training', async () => {
  const analysis = await enqueueAnalysis(course.id);
  await runPipeline(analysis.id);
  const row = await prisma.trainingAnalysis.findUnique({ where: { courseId: course.id } });
  assert.equal(row.status, 'READY_FOR_REVIEW');
  const refs = JSON.parse(row.sourceReferencesJson);
  assert.equal(refs.facts.length, 2);                                   // the invented source was dropped
  assert.deepEqual(refs.facts.map((f) => f.location), ['page 4', 'slide 9']);
  assert.ok(refs.facts.every((f) => f.sourceTitle === 'Sabre workflow PDF' && f.moduleId)); // matched to the real module, case-insensitively
  await prisma.trainingCourse.update({ where: { id: course.id }, data: { origin: 'AI_PRACTICE' } });
  const page = await get(admin, `/ai-practice/${course.id}?step=analysis`);
  assert.equal(page.status, 200); assert.match(page.text, /Where the key points come from/); assert.match(page.text, /page 4/); assert.match(page.text, /slide 9/);
  assert.doesNotMatch(page.text, /An invented fact/);
  await post(admin, `/admin/training/${course.id}/analysis/approve`);
  assert.equal((await prisma.trainingAnalysis.findUnique({ where: { courseId: course.id } })).status, 'APPROVED');
});

test('generated practice carries source references and an AI source check; the check is advice and never blocks generation', async () => {
  const res = await post(admin, `/ai-practice/${course.id}/practice/build`, { mode: 'custom', methods: 'QUIZ', level: '4' });
  assert.equal(res.status, 302);
  assert.ok(await require('../lib/aiTasks').runQueuedBuild(course.id)); // the build runs in the background; here we run the queued task
  const quiz = await prisma.assessment.findFirst({ where: { courseId: course.id, type: 'QUIZ' }, include: { questions: { orderBy: { displayOrder: 'asc' } } } });
  assert.equal(quiz.status, 'AI_GENERATED');                                   // never auto-approved
  assert.deepEqual(JSON.parse(quiz.questions[0].sourceRefJson), { title: 'Sabre workflow PDF', location: 'page 4' });
  assert.equal(quiz.questions[1].sourceRefJson, null);                          // no guessed reference
  const validation = JSON.parse(quiz.configJson).validation;
  assert.deepEqual([validation.total, validation.supported, validation.application], [3, 2, 2]);
  assert.deepEqual(validation.coverageGaps, ['Ticketing time limits']);

  const review = await get(admin, `/admin/assessments/${quiz.id}`);
  assert.match(review.text, /AI source check/); assert.match(review.text, /2<\/strong> of <strong>3|2 of 3/); assert.match(review.text, /24-hour rule is not in the material/); assert.match(review.text, /Ticketing time limits/);
  assert.match(review.text, /Source: Sabre workflow PDF, page 4/); assert.doesNotMatch(review.text, /re-check it/);
  // editing after the check marks it stale, and the Admin can re-run it
  await post(admin, `/admin/assessments/${quiz.id}/questions/${quiz.questions[2].id}`, { prompt: 'A 24-hour hold is free only in some cases.', correctAnswer: 'False', explanation: '' });
  assert.match((await get(admin, `/admin/assessments/${quiz.id}`)).text, /re-check it/);
  assert.equal((await post(admin, `/admin/assessments/${quiz.id}/validate`)).status, 302);
  assert.doesNotMatch((await get(admin, `/admin/assessments/${quiz.id}`)).text, /re-check it/);
  assert.ok(await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'assessment.validated', targetId: quiz.id } }));
  assert.ok((await post(sup, `/admin/assessments/${quiz.id}/validate`)).status >= 403);

  // if the AI check is down, the practice is still generated for review
  mode = 'validation-down';
  const again = await post(admin, `/ai-practice/${course.id}/practice/add`, { type: 'QUIZ', level: '4', count: '3' });
  assert.equal(again.status, 302);
  await require('../lib/aiTasks').runQueuedBuild(course.id);
  const quizzes = await prisma.assessment.findMany({ where: { courseId: course.id, type: 'QUIZ' }, orderBy: { createdAt: 'asc' } });
  assert.equal(quizzes.length, 2);
  assert.equal(JSON.parse(quizzes[1].configJson || '{}').validation, undefined);
  assert.ok(await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'practice.validation_failed', targetId: quizzes[1].id } }));
  const failed = await post(admin, `/admin/assessments/${quizzes[1].id}/validate`);
  assert.equal(failed.status, 502); assert.match(failed.text, /Nothing was changed/);
  mode = 'ok';
});
