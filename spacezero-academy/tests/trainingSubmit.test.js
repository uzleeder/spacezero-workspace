'use strict';
// After passing every practice / quiz of a training, the agent can SUBMIT (finish) the training: the
// training page shows the button, the submission is enforced on the server, it is numbered after every
// practice attempt so My Training reads it as the current status, and it is idempotent.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { getMyTrainingList } = require('../lib/training');
const app = require('../server');

let org, admin, agent, other, course, assessment, questions, recipient, cookies = {};
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);
const answers = (right) => Object.fromEntries(questions.map((q, i) => [`q_${q.id}`, right ? `Right ${i}` : `Wrong ${i}`]));

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Training submit tests' } });
  const mk = async (role, name) => {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: name, username: `ts_${org.id}_${name}`, email: `ts_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
    const t = generateToken(); await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookies[p.id] = `sz_session=${t.raw}`;
    return p;
  };
  admin = await mk('ADMIN', 'admin'); agent = await mk('TRAVEL_AGENT', 'agent'); other = await mk('TRAVEL_AGENT', 'other');
  course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Submit course', createdById: admin.id, status: 'PUBLISHED', passingScore: 70 } });
  const assignment = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.id, scope: 'INDIVIDUAL' } });
  recipient = await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: assignment.id, profileId: agent.id } });
  assessment = await prisma.assessment.create({ data: { organizationId: org.id, courseId: course.id, createdVia: 'ADMIN_MANUAL', type: 'QUIZ', status: 'APPROVED', title: 'Final quiz', level: 3, passingScore: 70, createdById: admin.id, version: 1 } });
  questions = [];
  for (let i = 0; i < 2; i += 1) questions.push(await prisma.question.create({ data: { assessmentId: assessment.id, type: 'MCQ', prompt: `Question ${i}`, optionsJson: JSON.stringify([`Right ${i}`, `Wrong ${i}`]), correctAnswerJson: JSON.stringify(`Right ${i}`), displayOrder: i } }));
});
after(async () => { await prisma.$disconnect(); });

const status = async () => (await getMyTrainingList(agent.id)).find((r) => r.id === recipient.id).status;

test('before the quiz is passed there is no Submit button, and a direct submission is refused', async () => {
  const page = await get(agent, `/training-course/${course.id}`);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /<button[^>]*>Submit training</);
  assert.match(page.text, /0 of 1 practice passed\. Still to pass: Final quiz/);
  assert.equal((await post(agent, `/training/${recipient.id}/complete`)).status, 403);
  assert.equal(await prisma.certificate.count({ where: { profileId: agent.id } }), 0);
});

test('a failed quiz still does not allow submitting', async () => {
  await post(agent, `/training/${recipient.id}/start`);
  const failed = await post(agent, `/assessments/${assessment.id}/submit`, answers(false));
  assert.equal(failed.status, 200); assert.match(failed.text, /Retake required/);
  assert.doesNotMatch((await get(agent, `/training-course/${course.id}`)).text, /<button[^>]*>Submit training</);
  assert.equal((await post(agent, `/training/${recipient.id}/complete`)).status, 403);
});

test('after passing every quiz the agent sees "Submit training" (also on the result page) and can submit', async () => {
  const passed = await post(agent, `/assessments/${assessment.id}/submit`, answers(true));
  assert.equal(passed.status, 200); assert.match(passed.text, /Passed/);
  assert.match(passed.text, new RegExp(`href="/training-course/${course.id}#practice"[^>]*>Continue`));
  const page = await get(agent, `/training-course/${course.id}`);
  assert.match(page.text, /All practice and quizzes passed/);
  assert.match(page.text, new RegExp(`action="/training/${recipient.id}/complete"`));
  assert.match(page.text, /<button[^>]*>Submit training</);
  assert.match(page.text, /✓ Completed/);
  assert.equal(await status(), 'IN_PROGRESS', 'passing a practice must not move an unsubmitted course to Completed');

  // My Training says so too: the card is marked "ready to submit" and carries the Submit button itself
  const mine = await get(agent, '/training?status=inprogress');
  assert.match(mine.text, /data-ready-notice[^>]*><strong>1 training is ready to submit\./);
  assert.match(mine.text, /data-ready-badge>All passed — ready to submit</);
  assert.match(mine.text, new RegExp(`action="/training/${recipient.id}/complete"[^>]*><button[^>]*data-submit-training>Submit training<`));
  assert.doesNotMatch(mine.text, />Continue</);
  assert.doesNotMatch((await get(other, '/training')).text, /data-ready-notice/); // nobody else sees it

  const done = await post(agent, `/training/${recipient.id}/complete`);
  assert.equal(done.status, 302);
  assert.equal(done.headers.location, '/training');
  const attempts = await prisma.trainingAttempt.findMany({ where: { recipientId: recipient.id }, orderBy: { attemptNumber: 'asc' } });
  const course_ = attempts.filter((a) => !a.assessmentId);
  assert.equal(course_.length, 1);
  assert.equal(course_[0].status, 'COMPLETED');
  assert.equal(course_[0].attemptNumber, Math.max(...attempts.map((a) => a.attemptNumber)));   // the newest, so My Training reads it
  assert.equal(await status(), 'COMPLETED');
  assert.equal(await prisma.certificate.count({ where: { profileId: agent.id, courseId: course.id } }), 1);
  assert.equal(await prisma.notification.count({ where: { profileId: agent.id, type: 'training.completed' } }), 1);
  assert.match((await get(agent, `/training-course/${course.id}`)).text, /✓ Training submitted/);
  assert.doesNotMatch((await get(agent, `/training-course/${course.id}`)).text, /<button[^>]*>Submit training</);
  // ...and it now sits under Completed on My Training, with no "ready to submit" prompt left
  const completed = await get(agent, '/training?status=completed');
  assert.match(completed.text, /Submit course/);
  assert.doesNotMatch(completed.text, /data-ready-notice|data-ready-badge/);
});

test('submitting again changes nothing: no second certificate, notification or attempt', async () => {
  const before = await prisma.trainingAttempt.count({ where: { recipientId: recipient.id } });
  assert.equal((await post(agent, `/training/${recipient.id}/complete`)).status, 302);
  assert.equal(await prisma.trainingAttempt.count({ where: { recipientId: recipient.id } }), before);
  assert.equal(await prisma.certificate.count({ where: { profileId: agent.id, courseId: course.id } }), 1);
  assert.equal(await prisma.notification.count({ where: { profileId: agent.id, type: 'training.completed' } }), 1);
});

test('nobody can submit someone else\'s training', async () => {
  const before = await prisma.trainingAttempt.count({ where: { recipientId: recipient.id } });
  const res = await post(other, `/training/${recipient.id}/complete`);
  assert.notEqual(res.status, 200);
  assert.equal(await prisma.trainingAttempt.count({ where: { recipientId: recipient.id } }), before);
  assert.equal(await prisma.certificate.count({ where: { profileId: other.id } }), 0);
});

test('a training with no practice can be finished without having pressed Start first', async () => {
  const plain = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Reading only', createdById: admin.id, status: 'PUBLISHED' } });
  const assignment = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: plain.id, assignedById: admin.id, scope: 'INDIVIDUAL' } });
  const r = await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: assignment.id, profileId: agent.id } });
  const page = await get(agent, `/training-course/${plain.id}`);
  assert.match(page.text, /Finish training/);
  assert.equal((await post(agent, `/training/${r.id}/complete`)).status, 302);
  assert.equal((await getMyTrainingList(agent.id)).find((x) => x.id === r.id).status, 'COMPLETED');
  assert.equal(await prisma.certificate.count({ where: { profileId: agent.id, courseId: plain.id } }), 1);
});
