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

// the course titles in the My Training list itself (the page header's notification preview also mentions courses)
const listed = (html) => [...html.matchAll(/<a href="\/training-course\/[^"]+" style="font-weight:600[^>]*>([^<]+)</g)].map((m) => m[1]);
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

test('passing the last quiz finishes the training by itself: Completed at once, certificate and notice, nothing left to press', async () => {
  const passed = await post(agent, `/assessments/${assessment.id}/submit`, answers(true));
  assert.equal(passed.status, 200); assert.match(passed.text, /Passed/);
  assert.match(passed.text, new RegExp(`href="/training-course/${course.id}#practice"`));
  // no Submit button to find: it is already submitted
  assert.equal(await status(), 'COMPLETED');
  const attempts = await prisma.trainingAttempt.findMany({ where: { recipientId: recipient.id }, orderBy: { attemptNumber: 'asc' } });
  const course_ = attempts.filter((a) => !a.assessmentId);
  assert.equal(course_.length, 1);
  assert.equal(course_[0].status, 'COMPLETED');
  assert.equal(course_[0].attemptNumber, Math.max(...attempts.map((a) => a.attemptNumber)));   // the newest, so My Training reads it
  assert.equal(await prisma.certificate.count({ where: { profileId: agent.id, courseId: course.id } }), 1);
  assert.equal(await prisma.notification.count({ where: { profileId: agent.id, type: 'training.completed', body: { contains: 'Submit course' } } }), 1);
  const page = await get(agent, `/training-course/${course.id}`);
  assert.match(page.text, /✓ Training submitted/);
  assert.doesNotMatch(page.text, /<button[^>]*>Submit training</);
  // it sits under Completed on My Training and is not Overdue
  const completed = await get(agent, '/training?status=completed');
  assert.deepEqual(listed(completed.text), ['Submit course']);
  assert.deepEqual(listed((await get(agent, '/training?status=overdue')).text), []);
});

test('practising AGAIN afterwards never reopens a finished training, however the attempt goes', async () => {
  const { recordAssessmentAttempt } = require('../lib/practiceAttempts');
  for (const passed of [false, true, true, false]) await recordAssessmentAttempt({ actor: agent, assessment, recipientId: recipient.id, score: passed ? 90 : 40, passed, skillBreakdown: {} });
  assert.equal(await status(), 'COMPLETED');
  assert.equal(await prisma.certificate.count({ where: { profileId: agent.id, courseId: course.id } }), 1);
  assert.equal(await prisma.notification.count({ where: { profileId: agent.id, type: 'training.completed' } }), 1);
  assert.deepEqual(listed((await get(agent, '/training?status=inprogress')).text), []);
});

test('a training that was passed before this rule existed (still sitting in Overdue) is finished when the person opens My Training, and by the sweep for everyone else', async () => {
  const { autoFinishAll } = require('../lib/trainingCompletion');
  const old = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Passed long ago', createdById: admin.id, status: 'PUBLISHED' } });
  const quiz = await prisma.assessment.create({ data: { organizationId: org.id, courseId: old.id, createdVia: 'ADMIN_MANUAL', type: 'QUIZ', status: 'APPROVED', title: 'Old quiz', passingScore: 70, createdById: admin.id, version: 1 } });
  const make = async (who) => {
    const a = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: old.id, assignedById: admin.id, scope: 'INDIVIDUAL', dueDate: new Date(Date.now() - 5 * 86400000) } });
    const r = await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: a.id, profileId: who.id } });
    await prisma.trainingAttempt.create({ data: { recipientId: r.id, profileId: who.id, assessmentId: quiz.id, attemptNumber: 1, status: 'COMPLETED', score: 95, completedAt: new Date(Date.now() - 6 * 86400000) } });
    return r;
  };
  const mine = await make(agent); const theirs = await make(other);
  const statusOf = async (who, r) => (await getMyTrainingList(who.id)).find((x) => x.id === r.id).status;
  assert.equal(await statusOf(agent, mine), 'IN_PROGRESS');   // passed, never submitted: the old rule left it Overdue
  const { buildMyTraining } = require('../lib/myTraining');
  assert.equal(buildMyTraining(await getMyTrainingList(agent.id), { status: 'overdue' }).cards.some((c) => c.row.id === mine.id), true);
  assert.ok(listed((await get(agent, '/training?status=completed')).text).includes('Passed long ago')); // opening My Training finishes it
  assert.equal(await statusOf(agent, mine), 'COMPLETED');
  assert.equal(listed((await get(agent, '/training?status=overdue')).text).includes('Passed long ago'), false);
  assert.equal(await statusOf(other, theirs), 'IN_PROGRESS');   // somebody who has not logged in
  assert.ok(await autoFinishAll() >= 1);
  assert.equal(await statusOf(other, theirs), 'COMPLETED');
  assert.equal(await autoFinishAll(), 0);                       // nothing is finished twice
  assert.equal(await prisma.certificate.count({ where: { profileId: other.id, courseId: old.id } }), 1);
});

test('a practice that is NOT passed, or material that is not finished, does not finish anything; a requested retake must be passed again', async () => {
  const c = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Not yet', createdById: admin.id, status: 'PUBLISHED', modules: { create: [{ title: 'Must read', contentType: 'NOTE', description: 'text', required: true }] } } });
  const q = await prisma.assessment.create({ data: { organizationId: org.id, courseId: c.id, createdVia: 'ADMIN_MANUAL', type: 'QUIZ', status: 'APPROVED', title: 'Quiz', passingScore: 70, createdById: admin.id, version: 1 } });
  const a = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: c.id, assignedById: admin.id, scope: 'INDIVIDUAL' } });
  const r = await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: a.id, profileId: agent.id } });
  const { autoFinishForProfile } = require('../lib/trainingCompletion');
  const stat = async () => (await getMyTrainingList(agent.id)).find((x) => x.id === r.id).status;
  await prisma.trainingAttempt.create({ data: { recipientId: r.id, profileId: agent.id, assessmentId: q.id, attemptNumber: 1, status: 'COMPLETED', score: 90, completedAt: new Date(Date.now() - 60000) } });
  assert.equal(await autoFinishForProfile(agent.id, { id: r.id }), 0); // required material is not finished
  assert.notEqual(await stat(), 'COMPLETED');
  const mod = await prisma.trainingModule.findFirst({ where: { courseId: c.id } });
  await prisma.mediaProgress.create({ data: { profileId: agent.id, trainingModuleId: mod.id, completedAt: new Date(), percentComplete: 100 } });
  assert.equal(await autoFinishForProfile(agent.id, { id: r.id }), 1);
  assert.equal(await stat(), 'COMPLETED');
  // an Admin asks for a retake: the earlier pass no longer counts, the training is open again until it is passed again
  assert.equal((await post(admin, `/training/${r.id}/retake`)).status, 302);
  assert.equal(await stat(), 'RETAKE_REQUIRED');
  await get(agent, '/training');
  assert.equal(await stat(), 'RETAKE_REQUIRED');                                  // still open: nothing new was passed
  const { recordAssessmentAttempt } = require('../lib/practiceAttempts');
  await new Promise((resolve) => setTimeout(resolve, 20));
  await recordAssessmentAttempt({ actor: agent, assessment: q, recipientId: r.id, score: 85, passed: true, skillBreakdown: {} });
  assert.equal(await stat(), 'COMPLETED');                                         // passed again -> finished again
});
test('submitting again changes nothing: no second certificate, notification or attempt', async () => {
  const notices = () => prisma.notification.count({ where: { profileId: agent.id, type: 'training.completed', body: { contains: 'Submit course' } } });
  const before = await prisma.trainingAttempt.count({ where: { recipientId: recipient.id } });
  assert.equal((await post(agent, `/training/${recipient.id}/complete`)).status, 302);
  assert.equal(await prisma.trainingAttempt.count({ where: { recipientId: recipient.id } }), before);
  assert.equal(await prisma.certificate.count({ where: { profileId: agent.id, courseId: course.id } }), 1);
  assert.equal(await notices(), 1);
});

test('nobody can submit someone else\'s training', async () => {
  const before = await prisma.trainingAttempt.count({ where: { recipientId: recipient.id } });
  const res = await post(other, `/training/${recipient.id}/complete`);
  assert.notEqual(res.status, 200);
  assert.equal(await prisma.trainingAttempt.count({ where: { recipientId: recipient.id } }), before);
  assert.equal(await prisma.certificate.count({ where: { profileId: other.id, courseId: course.id } }), 0);
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
