'use strict';
// A training's status follows the rules of submitting it, everywhere it is shown (My Training, dashboards,
// team views): a submitted training stays Completed when the learner practises again, Retake required means a
// required practice is still not passed, a manager's retake request re-opens the submission itself, and the
// course page shows the material and practice of the learner's latest assigned version.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { getMyTrainingList, getTrainingSummaries } = require('../lib/training');
const { loadLearning } = require('../lib/teamIntel');
const app = require('../server');

let org, admin; const cookies = {}; let n = 0;
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
async function person(role = 'TRAVEL_AGENT') {
  n += 1;
  const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `Status ${n}`, username: `ts_${org.id}_${n}`, email: `ts_${org.id}_${n}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
  const t = generateToken(); await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookies[p.id] = `sz_session=${t.raw}`;
  return p;
}
async function quizOn(courseId, { version = 1, title = 'Quiz' } = {}) {
  const a = await prisma.assessment.create({ data: { organizationId: org.id, courseId, createdVia: 'ADMIN_MANUAL', type: 'QUIZ', title, status: 'APPROVED', level: 2, passingScore: 70, createdById: admin.id, version } });
  const q = await prisma.question.create({ data: { assessmentId: a.id, type: 'MCQ', prompt: `${title} question`, optionsJson: JSON.stringify(['Right', 'Wrong']), correctAnswerJson: JSON.stringify('Right'), skillIdsJson: '[]' } });
  return { a, q };
}
async function setup({ practices = 1 } = {}) {
  const course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: `Status course ${++n}`, createdById: admin.id, status: 'PUBLISHED', passingScore: 70, publishedVersion: 1 } });
  const quizzes = [];
  for (let i = 0; i < practices; i += 1) quizzes.push(await quizOn(course.id, { title: `Quiz ${i + 1}` }));
  const learner = await person();
  const assignment = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.id, scope: 'INDIVIDUAL' } });
  const recipient = await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: assignment.id, profileId: learner.id } });
  return { course, quizzes, learner, recipient };
}
const answer = (learner, { a, q }, value) => post(learner, `/assessments/${a.id}/submit`, { [`q_${q.id}`]: value });
const later = () => new Promise((resolve) => setTimeout(resolve, 15));
/** The status of one recipient as My Training, the employee lists and the team views each compute it. */
async function statusesOf(learner, recipient) {
  const mine = (await getMyTrainingList(learner.id)).find((r) => r.id === recipient.id).status;
  const summary = (await getTrainingSummaries([learner.id])).get(learner.id);
  const listed = Object.entries({ COMPLETED: summary.completed, IN_PROGRESS: summary.inProgress, RETAKE_REQUIRED: summary.retakeRequired, NOT_STARTED: summary.notStarted }).find(([, count]) => count === 1)[0];
  const team = (await loadLearning([learner.id], new Date()))[0].status;
  return [mine, listed, team];
}

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Training status tests' } });
  admin = await person('ADMIN');
});
after(async () => { await prisma.$disconnect(); });

test('a submitted training stays Completed when the learner practises again afterwards, even failing', async () => {
  const { quizzes: [quiz], learner, recipient } = await setup();
  await answer(learner, quiz, 'Right');
  await post(learner, `/training/${recipient.id}/complete`);
  assert.deepEqual(await statusesOf(learner, recipient), ['COMPLETED', 'COMPLETED', 'COMPLETED']);
  await later();
  await answer(learner, quiz, 'Wrong');
  await later();
  await answer(learner, quiz, 'Wrong');
  assert.deepEqual(await statusesOf(learner, recipient), ['COMPLETED', 'COMPLETED', 'COMPLETED']);
});

test('Retake required means a required practice is still not passed - passing another practice does not hide it', async () => {
  const { quizzes: [first, second], learner, recipient } = await setup({ practices: 2 });
  assert.deepEqual(await statusesOf(learner, recipient), ['NOT_STARTED', 'NOT_STARTED', 'NOT_STARTED']);
  await answer(learner, first, 'Wrong'); await later();
  await answer(learner, first, 'Wrong'); await later();
  await answer(learner, first, 'Wrong'); await later();
  await answer(learner, second, 'Right'); // the second practice's attempt #1 used to "win" over the first's #3
  assert.deepEqual(await statusesOf(learner, recipient), ['RETAKE_REQUIRED', 'RETAKE_REQUIRED', 'RETAKE_REQUIRED']);
  await later();
  await answer(learner, first, 'Right');
  assert.deepEqual(await statusesOf(learner, recipient), ['IN_PROGRESS', 'IN_PROGRESS', 'IN_PROGRESS'], 'every practice passed, not submitted yet');
});

test('a manager\'s retake request re-opens the submitted training itself, not a practice attempt', async () => {
  const { quizzes: [quiz], learner, recipient } = await setup();
  await answer(learner, quiz, 'Right');
  await post(learner, `/training/${recipient.id}/complete`);
  await later();
  await answer(learner, quiz, 'Right'); // a later practice attempt whose number ties with the submission's
  await answer(learner, quiz, 'Right');
  const requested = await post(admin, `/training/${recipient.id}/retake`);
  assert.ok([200, 302].includes(requested.status));
  const submission = await prisma.trainingAttempt.findFirst({ where: { recipientId: recipient.id, assessmentId: null } });
  assert.equal(submission.status, 'RETAKE_REQUIRED');
  assert.equal(await prisma.trainingAttempt.count({ where: { recipientId: recipient.id, assessmentId: quiz.a.id, status: 'RETAKE_REQUIRED' } }), 0, 'no practice attempt was re-opened');
  assert.deepEqual(await statusesOf(learner, recipient), ['RETAKE_REQUIRED', 'RETAKE_REQUIRED', 'RETAKE_REQUIRED']);
});

test('after re-assignment to a new version the course page shows that version\'s material and practice, which the lock uses too', async () => {
  const course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: `Versioned ${++n}`, createdById: admin.id, status: 'PUBLISHED', passingScore: 70, publishedVersion: 2, draftVersion: 2 } });
  const note = await prisma.trainingModule.create({ data: { courseId: course.id, title: 'New v2 rule', description: 'Read this new rule.', contentType: 'NOTE', required: true, addedInVersion: 2 } });
  const v1 = await quizOn(course.id, { version: 1, title: 'Version one quiz' });
  const v2 = await quizOn(course.id, { version: 2, title: 'Version two quiz' });
  const learner = await person();
  for (const courseVersion of [1, 2]) {
    const assignment = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.id, scope: 'INDIVIDUAL', courseVersion } });
    await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: assignment.id, profileId: learner.id } });
    await later();
  }
  const page = await get(learner, `/training-course/${course.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /New v2 rule/, 'the required v2 material is shown');
  assert.match(page.text, /Locked until you finish the material/);
  assert.equal((await get(learner, `/assessments/${v2.a.id}/take`)).status, 403, 'locked until that material is finished - which the page now shows');

  await prisma.mediaProgress.updateMany({ where: { profileId: learner.id, trainingModuleId: note.id }, data: { completedAt: new Date(), percentComplete: 100 } });
  const open = await get(learner, `/training-course/${course.id}`);
  assert.match(open.text, /Version two quiz/);
  assert.doesNotMatch(open.text, /Version one quiz/, 'the older version\'s practice is not offered');
  assert.equal((await get(learner, `/assessments/${v2.a.id}/take`)).status, 200);
  assert.ok(v1);
});
