'use strict';
// Practice progress flow: a training with several practices guides the learner through them one by one.
// A result has ONE main button: Continue (back to the training's next step) when passed, Try again when not.
// After the first of two it says "Practice 1 of 2 of this training is done. Next: ..."; after the last the training
// is finished. Scoring, passing, retakes and permissions are untouched.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { practiceFlowFor, startUrl } = require('../lib/trainingCompletion');
const app = require('../server');

let org, admin, agent, cookies = {}, course, quiz, role, questionsOf = {};
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);
const answers = (assessment, right) => Object.fromEntries(questionsOf[assessment.id].map((q, i) => [`q_${q.id}`, right ? `Right ${i}` : `Wrong ${i}`]));

async function practice(courseId, type, title, extra = {}) {
  const a = await prisma.assessment.create({ data: { organizationId: org.id, courseId, createdVia: 'ADMIN_MANUAL', type, status: 'APPROVED', title, level: 2, passingScore: 70, createdById: admin.id, version: 1, ...extra } });
  if (type === 'QUIZ') {
    questionsOf[a.id] = [];
    for (let i = 0; i < 2; i += 1) questionsOf[a.id].push(await prisma.question.create({ data: { assessmentId: a.id, type: 'MCQ', prompt: `${title} question ${i}`, optionsJson: JSON.stringify([`Right ${i}`, `Wrong ${i}`]), correctAnswerJson: JSON.stringify(`Right ${i}`), displayOrder: i } }));
  }
  return a;
}
async function assign(courseId) {
  const assignment = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId, assignedById: admin.id, scope: 'INDIVIDUAL' } });
  return prisma.trainingAssignmentRecipient.create({ data: { assignmentId: assignment.id, profileId: agent.id } });
}

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Practice flow tests' } });
  const mk = async (role_, name) => {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: name, username: `pf_${org.id}_${name}`, email: `pf_${org.id}_${name}@example.invalid`, role: role_, status: 'ACTIVE', employmentStartDate: new Date() } });
    const t = generateToken(); await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookies[p.id] = `sz_session=${t.raw}`;
    return p;
  };
  admin = await mk('ADMIN', 'admin'); agent = await mk('TRAVEL_AGENT', 'agent');
  await require('../lib/orgSettings').setSetting(org.id, 'training.retakeWaitMinutes', 0, admin.id); // these tests fail and retry straight away
  course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Flow course', createdById: admin.id, status: 'PUBLISHED' } });
  quiz = await practice(course.id, 'QUIZ', 'Flow quiz');
  role = await practice(course.id, 'ROLEPLAY', 'Flow role-play', { configJson: JSON.stringify({ customerPersonality: 'calm', scenarioBrief: 'A client calls.', openingLine: 'Hello.', rubricSkills: ['Opening', 'Discovery', 'Closing'] }) });
  await assign(course.id);
});
after(async () => { await prisma.$disconnect(); });

test('startUrl: a role-play opens its conversation, everything else its take page', () => {
  assert.equal(startUrl({ id: 'x', type: 'ROLEPLAY' }), '/assessments/x/roleplay');
  assert.equal(startUrl({ id: 'x', type: 'QUIZ' }), '/assessments/x/take');
  assert.equal(startUrl({ id: 'x', type: 'VOICE' }), '/assessments/x/take');
});

test('the training page goes through the practices one step at a time, starting with the one that is up next', async () => {
  const page = await get(agent, `/training-course/${course.id}`);
  assert.match(page.text, /Step 1 of 3/); assert.match(page.text, /<h2 class="step-title">Flow quiz<\/h2>/);
  assert.match(page.text, new RegExp(`href="/assessments/${quiz.id}/take" data-step-next>Start quiz<`));
  assert.match(page.text, /Step 2: Flow role-play \(locked\)/);                // the role-play comes next, locked until then
});

test('a failed practice: one main button, Try again (a new set on what was missed), and a quiet way back', async () => {
  const failed = await post(agent, `/assessments/${quiz.id}/submit`, answers(quiz, false));
  assert.equal(failed.status, 200); assert.match(failed.text, /Not passed yet/);
  // no wait in this organization: Try again straight away (Review the material is the hidden half of the swap)
  assert.match(failed.text, new RegExp(`action="/assessments/${quiz.id}/remediate" data-once data-retake-try><button type="submit" class="btn btn-gold" data-result-next>Try again<`));
  assert.match(failed.text, /data-retake-review hidden>Review the material</);
  assert.match(failed.text, /← My Training/); assert.doesNotMatch(failed.text, /data-result-where/);
});

test('Quiz passed -> "Practice 1 of 2 of this training is done. Next: Flow role-play." -> Continue -> the role-play step', async () => {
  const passed = await post(agent, `/assessments/${quiz.id}/submit`, answers(quiz, true));
  assert.equal(passed.status, 200); assert.match(passed.text, /Passed/);
  assert.match(passed.text, /Practice 1 of 2 of this training is done\. Next: Flow role-play\./);
  assert.match(passed.text, new RegExp(`href="/training-course/${course.id}" data-result-next>Continue<`));
  assert.equal((passed.text.match(/class="btn /g) || []).length, 1);            // exactly one button, no countdown
  assert.doesNotMatch(passed.text, /Continuing automatically/);
  const page = await get(agent, `/training-course/${course.id}`);                 // the training is now on the role-play
  assert.match(page.text, /Step 2 of 3/); assert.match(page.text, new RegExp(`href="/assessments/${role.id}/roleplay" data-step-next>Start role-play<`));
  assert.match((await get(agent, `/training-course/${course.id}?step=1`)).text, /✓ Passed/);
  const flow = await practiceFlowFor(agent.id, quiz);
  assert.deepEqual([flow.position, flow.total, flow.completed, flow.completedCount, flow.allDone, flow.next.id], [1, 2, true, 1, false, role.id]);
  // the next practice really is open
  assert.equal((await get(agent, `/assessments/${role.id}/roleplay`)).status, 200);
});

test('Role-play -> Completed -> "Practice completed." -> submit the training (the last practice never points at another)', async () => {
  // the role-play finished and passed (scored attempt recorded the way the finish route does)
  const recipient = await prisma.trainingAssignmentRecipient.findFirst({ where: { profileId: agent.id, assignment: { courseId: course.id } } });
  await prisma.trainingAttempt.create({ data: { recipientId: recipient.id, profileId: agent.id, assessmentId: role.id, attemptNumber: 1, status: 'COMPLETED', score: 88, completedAt: new Date(), transcriptJson: JSON.stringify([{ role: 'agent', text: 'Hi' }]), skillBreakdownJson: JSON.stringify({ Opening: 88 }), answersJson: JSON.stringify({ feedback: 'Good.', review: {} }) } });
  const flow = await practiceFlowFor(agent.id, role);
  assert.deepEqual([flow.position, flow.total, flow.completed, flow.allDone, flow.next], [2, 2, true, true, null]);
  const result = await get(agent, `/assessments/${role.id}/result`);
  assert.equal(result.status, 200);
  assert.match(result.text, /Practice 2 of 2 of this training is done\. That was the last one\./);
  assert.match(result.text, new RegExp(`href="/training-course/${course.id}" data-result-next>Continue<`));
  assert.equal((result.text.match(/class="btn /g) || []).length, 1);
  const page = await get(agent, `/training-course/${course.id}`);
  // opening the training finishes it by itself now (everything is passed): no Submit press is left to do
  assert.match(page.text, /<h2 class="step-title">Training complete<\/h2>/); assert.match(page.text, /You finished this training/);
  assert.doesNotMatch(page.text, /<button[^>]*>Submit training</);
  assert.equal((await require('../lib/training').getMyTrainingList(agent.id)).find((r) => r.id === recipient.id).status, 'COMPLETED');
});

test('an earlier practice that is still open is offered after the last one; targeted retakes and other courses never enter the sequence', async () => {
  const c2 = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Flow course 2', createdById: admin.id, status: 'PUBLISHED' } });
  const first = await practice(c2.id, 'QUIZ', 'Two first'); const second = await practice(c2.id, 'QUIZ', 'Two second');
  const retake = await practice(c2.id, 'QUIZ', 'Targeted retake', { configJson: JSON.stringify({ targetedRetake: true }) });
  const r2 = await assign(c2.id);
  await prisma.trainingAttempt.create({ data: { recipientId: r2.id, profileId: agent.id, assessmentId: second.id, attemptNumber: 1, status: 'COMPLETED', score: 95, completedAt: new Date() } });
  const flow = await practiceFlowFor(agent.id, second);
  assert.equal(flow.total, 2);                         // the targeted retake is not part of the sequence
  assert.equal(flow.next.id, first.id);                // the first one is still open: offered, not skipped
  assert.equal(await practiceFlowFor(agent.id, retake), null);
  assert.equal(await practiceFlowFor(agent.id, { id: 'x', courseId: null }), null);
  assert.equal(await practiceFlowFor(admin.id, first), null); // someone without the assignment gets no sequence
});

test('a training with ONE practice: the result simply leads back to the training', async () => {
  const c3 = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Flow course single', createdById: admin.id, status: 'PUBLISHED' } });
  const only = await practice(c3.id, 'QUIZ', 'Only quiz');
  await assign(c3.id);
  const page = await get(agent, `/training-course/${c3.id}`);
  assert.doesNotMatch(page.text, /Practice 1 of 1/); assert.doesNotMatch(page.text, /Up next/);
  const passed = await post(agent, `/assessments/${only.id}/submit`, answers(only, true));
  assert.equal(passed.status, 200); assert.match(passed.text, /Passed/);
  assert.match(passed.text, /This step of the training is done\./); assert.doesNotMatch(passed.text, /Practice 1 of 1/);
  assert.match(passed.text, new RegExp(`href="/training-course/${c3.id}" data-result-next>Continue<`));
  // scoring / passing are exactly as before: the attempt is the usual one
  const attempt = await prisma.trainingAttempt.findFirst({ where: { assessmentId: only.id, profileId: agent.id } });
  assert.equal(attempt.status, 'COMPLETED'); assert.equal(attempt.score, 100);
});

test('flow stays with the recorded recipient and version; archived practice never blocks completion', async () => {
  const c = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Versioned flow', createdById: admin.id, status: 'PUBLISHED' } });
  const first = await practice(c.id, 'QUIZ', 'Version one');
  await practice(c.id, 'QUIZ', 'Archived practice', { archivedAt: new Date() });
  const original = await assign(c.id);
  await prisma.trainingAttempt.create({ data: { recipientId: original.id, profileId: agent.id, assessmentId: first.id, attemptNumber: 1, status: 'COMPLETED', score: 95, completedAt: new Date() } });
  const newer = await assign(c.id);
  await prisma.trainingAssignment.update({ where: { id: newer.assignmentId }, data: { courseVersion: 2 } });
  const flow = await practiceFlowFor(agent.id, first, original.id);
  assert.equal(flow.total, 1); assert.equal(flow.allDone, true); assert.equal(flow.next, null);
  assert.equal(await practiceFlowFor(agent.id, first, newer.id), null);
  assert.equal(await practiceFlowFor(admin.id, first, original.id), null);
});
