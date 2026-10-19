'use strict';
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const prompts = [];
mock.method(require('../lib/gemini'), 'generateStructured', async (input) => {
  prompts.push(input);
  return { modelVersion: 'test', data: {
    questions: Array.from({ length: 3 }, () => ({ type: 'MCQ', prompt: 'Choose', options: ['A', 'B'], correctAnswer: 'A', skillNames: ['Discovery'] })),
    customerPersonality: 'busy', scenarioBrief: 'New scenario', openingLine: 'Hello', rubricSkills: ['Discovery'],
  } };
});
const app = require('../server');
let org, owner, other, cookie, otherCookie, course, recipient, assessment;
before(async () => {
  org = await prisma.organization.create({ data: { name: 'Retake tests' } });
  async function user(suffix) {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: suffix, username: `${org.id}_${suffix}`, email: `${org.id}_${suffix}@example.invalid`, role: 'TRAVEL_AGENT', status: 'ACTIVE', employmentStartDate: new Date() } });
    const token = generateToken();
    await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
    return [p, `sz_session=${token.raw}`];
  }
  [owner, cookie] = await user('owner');
  [other, otherCookie] = await user('other');
  course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Retake course', createdById: owner.id, status: 'PUBLISHED', analysis: { create: { status: 'APPROVED' } } } });
  const assignment = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: owner.id, scope: 'INDIVIDUAL' } });
  recipient = await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: assignment.id, profileId: owner.id } });
  await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: assignment.id, profileId: other.id } });
  assessment = await prisma.assessment.create({ data: { organizationId: org.id, courseId: course.id, createdById: owner.id, createdVia: 'AI_TRAINING_ANALYSIS', type: 'QUIZ', title: 'Original', status: 'APPROVED', level: 5 } });
  await prisma.trainingAttempt.create({ data: { recipientId: recipient.id, profileId: owner.id, assessmentId: assessment.id, status: 'RETAKE_REQUIRED', skillBreakdownJson: JSON.stringify({ Discovery: 30, Closing: 95 }) } });
});
after(async () => { mock.restoreAll(); await prisma.$disconnect(); });

test('targeted retake keeps history, targets weak skills, caps difficulty and isolates access', async () => {
  const response = await request(app).post(`/assessments/${assessment.id}/remediate`).set('Cookie', cookie);
  assert.equal(response.status, 302);
  const id = response.headers.location.split('/')[2];
  const retake = await prisma.assessment.findUnique({ where: { id } });
  assert.equal(retake.level, 5);
  assert.equal(retake.status, 'APPROVED');
  assert.deepEqual(JSON.parse(retake.configJson).focusSkills, ['Discovery']);
  assert.equal(await prisma.trainingAttempt.count({ where: { assessmentId: assessment.id } }), 1);
  assert.equal((await request(app).get(response.headers.location).set('Cookie', cookie)).status, 200);
  for (const [method, suffix] of [['get', 'take'], ['post', 'submit'], ['post', 'remediate']]) {
    assert.equal((await request(app)[method](`/assessments/${id}/${suffix}`).set('Cookie', otherCookie)).status, 404);
  }
  const page = await request(app).get(`/training-course/${course.id}`).set('Cookie', otherCookie);
  assert.equal(page.status, 200);
  assert.ok(!page.text.includes(id));
});

test('roleplay retake supplies weak skills to the generator and preserves scenario configuration', async () => {
  await prisma.assessment.update({ where: { id: assessment.id }, data: { type: 'ROLEPLAY' } });
  const response = await request(app).post(`/assessments/${assessment.id}/remediate`).set('Cookie', cookie);
  assert.equal(response.status, 302);
  assert.ok(response.headers.location.endsWith('/roleplay'));
  const retake = await prisma.assessment.findUnique({ where: { id: response.headers.location.split('/')[2] } });
  const config = JSON.parse(retake.configJson);
  assert.deepEqual(config.focusSkills, ['Discovery']);
  assert.equal(config.openingLine, 'Hello');
  assert.match(prompts.at(-1).contents[0].parts[0].text, /weak skills: \["Discovery"\]/);
});

test('with no skill evidence the retake covers the whole practice again - never a dead end', async () => {
  const original = await prisma.assessment.create({ data: { organizationId: org.id, courseId: course.id, createdById: owner.id, createdVia: 'AI_TRAINING_ANALYSIS', type: 'QUIZ', title: 'No skills tagged', status: 'APPROVED', level: 2 } });
  await prisma.trainingAttempt.create({ data: { recipientId: recipient.id, profileId: owner.id, assessmentId: original.id, status: 'RETAKE_REQUIRED', skillBreakdownJson: '{}' } });
  const count = prompts.length;
  const response = await request(app).post(`/assessments/${original.id}/remediate`).set('Cookie', cookie);
  assert.equal(response.status, 302);
  assert.notEqual(response.headers.location, '/training');
  const retake = await prisma.assessment.findUnique({ where: { id: response.headers.location.split('/')[2] } });
  assert.equal(JSON.parse(retake.configJson).retakeOf, original.id);
  assert.deepEqual(JSON.parse(retake.configJson).focusSkills, []);
  assert.equal(prompts.length, count + 1);
  assert.match(prompts.at(-1).systemInstruction, /RETAKE of a practice the learner did not pass/);
});
