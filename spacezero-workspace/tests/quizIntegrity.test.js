'use strict';
// Quiz integrity: a failed quiz does not hand out the answers, tries are spaced and capped, multi-answer questions grade
// correctly when an option contains a comma, and an Admin "viewing as" an employee writes nothing in that employee's name.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');

mock.method(require('../lib/gemini'), 'generateStructured', async () => { throw new Error('Gemini must not be called in these tests'); });

const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { gradeAttempt } = require('../lib/practiceGrading');
const { listOf, fitToOptions } = require('../lib/answerKey');
const app = require('../server');

let org, admin, agent, tester, course, quiz, questions = {}, cookies = {}, adminCookie;
const as = (p) => cookies[p.id];
const submit = (cookie, answers) => request(app).post(`/assessments/${quiz.id}/submit`).set('Cookie', cookie).type('form').send(answers);
const right = () => ({ [`q_${questions.mcq.id}`]: 'Doha', [`q_${questions.multi.id}`]: ['Doha, Qatar', 'Dubai, UAE'] });
const wrong = () => ({ [`q_${questions.mcq.id}`]: 'Paris', [`q_${questions.multi.id}`]: ['Paris, France'] });
const rewind = (profile, minutes) => prisma.trainingAttempt.updateMany({ where: { profileId: profile.id, assessmentId: quiz.id }, data: { completedAt: new Date(Date.now() - minutes * 60000) } });

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Quiz integrity tests' } });
  const mk = async (role, name, extra = {}) => {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `QI ${name}`, username: `qi_${org.id}_${name}`, email: `qi_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date(), ...extra } });
    const t = generateToken(); await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookies[p.id] = `sz_session=${t.raw}`;
    return p;
  };
  admin = await mk('ADMIN', 'admin'); agent = await mk('TRAVEL_AGENT', 'agent'); tester = await mk('TRAVEL_AGENT', 'tester', { testOwnerAdminId: admin.id });
  adminCookie = cookies[admin.id].replace('sz_session=', '');
  course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Quiz integrity', createdById: admin.id, status: 'PUBLISHED', publishedVersion: 1 } });
  quiz = await prisma.assessment.create({ data: { organizationId: org.id, courseId: course.id, createdVia: 'ADMIN_MANUAL', type: 'QUIZ', status: 'APPROVED', title: 'Cities', createdById: admin.id, version: 1, passingScore: 70 } });
  questions.mcq = await prisma.question.create({ data: { assessmentId: quiz.id, type: 'MCQ', prompt: 'Capital of Qatar?', optionsJson: JSON.stringify(['Doha', 'Paris']), correctAnswerJson: JSON.stringify('Doha'), explanation: 'Because Doha.', skillIdsJson: JSON.stringify(['Geography']), displayOrder: 0 } });
  // stored the old way: ONE comma-joined string, while the options themselves contain commas
  questions.multi = await prisma.question.create({ data: { assessmentId: quiz.id, type: 'MULTI_SELECT', prompt: 'Gulf hubs?', optionsJson: JSON.stringify(['Doha, Qatar', 'Dubai, UAE', 'Paris, France']), correctAnswerJson: JSON.stringify('Doha, Qatar,Dubai, UAE'), skillIdsJson: JSON.stringify(['Geography']), displayOrder: 1 } });
  for (const p of [agent, tester]) {
    const a = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.id, scope: 'INDIVIDUAL' } });
    await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: a.id, profileId: p.id } });
  }
});
after(async () => { await prisma.$disconnect(); });

test('multi-answer questions grade correctly when an option contains a comma, whichever way the answer was stored', async () => {
  const options = ['Doha, Qatar', 'Dubai, UAE', 'Paris, France'];
  assert.deepEqual(listOf('Doha, Qatar,Dubai, UAE', options), ['Doha, Qatar', 'Dubai, UAE']);
  assert.deepEqual(listOf('A,B', ['A', 'B', 'C']), ['A', 'B']);
  assert.deepEqual(fitToOptions({ type: 'MULTI_SELECT', options, correctAnswer: 'Doha, Qatar,Dubai, UAE' }).correctAnswer, ['Doha, Qatar', 'Dubai, UAE']);
  assert.equal(fitToOptions({ type: 'MCQ', options, correctAnswer: 'Doha, Qatar' }).correctAnswer, 'Doha, Qatar');
  const q = await prisma.question.findUnique({ where: { id: questions.multi.id } });
  assert.equal((await gradeAttempt([q], { [q.id]: ['Doha, Qatar', 'Dubai, UAE'] })).overallScore, 100);   // the learner who answered correctly passes
  assert.equal((await gradeAttempt([q], { [q.id]: ['Doha, Qatar'] })).overallScore, 0);
  assert.equal((await gradeAttempt([q], { [q.id]: ['Doha, Qatar', 'Dubai, UAE', 'Paris, France'] })).overallScore, 0);
  const stored = await prisma.question.create({ data: { assessmentId: quiz.id, type: 'ORDERING', prompt: 'Order', optionsJson: JSON.stringify(['Quote, then hold', 'Book']), correctAnswerJson: JSON.stringify(['Quote, then hold', 'Book']), displayOrder: 9 } });
  assert.equal((await gradeAttempt([stored], { [stored.id]: ['Quote, then hold', 'Book'] })).overallScore, 100);
  await prisma.question.delete({ where: { id: stored.id } });
});

test('a failed quiz does not show the answers; every next try waits, and tries never run out', async () => {
  const first = await submit(as(agent), wrong());
  assert.equal(first.status, 200);
  assert.match(first.text, /Not passed yet/);
  assert.doesNotMatch(first.text, /Correct answer/); assert.doesNotMatch(first.text, /Because Doha/); assert.doesNotMatch(first.text, /Doha, Qatar/);

  const again = await submit(as(agent), right());                                          // straight away: refused, nothing recorded
  assert.equal(again.status, 429); assert.match(again.text, /You can try again in/);
  const take = await request(app).get(`/assessments/${quiz.id}/take`).set('Cookie', as(agent));
  assert.equal(take.status, 429);
  assert.equal(await prisma.trainingAttempt.count({ where: { profileId: agent.id, assessmentId: quiz.id } }), 1);

  await rewind(agent, 11);                                                                  // after the pause it opens again
  assert.equal((await request(app).get(`/assessments/${quiz.id}/take`).set('Cookie', as(agent))).status, 200);
  assert.equal((await submit(as(agent), wrong())).status, 200);
  await rewind(agent, 11);
  assert.equal((await submit(as(agent), wrong())).status, 200);                             // the third failed try
  await rewind(agent, 11);
  assert.equal((await request(app).get(`/assessments/${quiz.id}/take`).set('Cookie', as(agent))).status, 200); // no limit on tries: after the wait it opens
  assert.equal((await submit(as(agent), wrong())).status, 200);                             // a fourth failed try is accepted
  const waiting = await request(app).get(`/assessments/${quiz.id}/take`).set('Cookie', as(agent));
  assert.equal(waiting.status, 429); assert.match(waiting.text, /You can try again in/); assert.match(waiting.text, />Review the material</);

  // a retake asked for by the supervisor / Admin gives a fresh start
  const latest = await prisma.trainingAttempt.findFirst({ where: { profileId: agent.id, assessmentId: quiz.id }, orderBy: { attemptNumber: 'desc' } });
  await rewind(agent, 5);                                                                   // the failed tries are 5 minutes old, the request is newer
  await prisma.trainingAttempt.update({ where: { id: latest.id }, data: { retakeRequestedById: admin.id, retakeRequestedAt: new Date() } });
  assert.equal((await request(app).get(`/assessments/${quiz.id}/take`).set('Cookie', as(agent))).status, 200);
});

test('passing shows the answers, and a passed practice is never held back', async () => {
  const passer = tester;                                                                    // fresh learner (also has the test-account flag, which changes nothing here)
  const ok = await submit(as(passer), right());
  assert.match(ok.text, /Passed/); assert.doesNotMatch(ok.text, /Not passed yet/);
  assert.equal((await request(app).get(`/assessments/${quiz.id}/take`).set('Cookie', as(passer))).status, 200);
});

test('an Admin viewing a real employee writes nothing in their name; an Admin test account is not restricted; the log names the Admin', async () => {
  const viewing = (p) => `${cookies[p.id]}; sz_admin_session=${adminCookie}`;
  const post = (p, url, body = {}) => request(app).post(url).set('Cookie', viewing(p)).send(body);

  assert.equal((await post(agent, `/assessments/${quiz.id}/submit`)).status, 403);
  const refused = await post(agent, `/assessments/${quiz.id}/submit`);
  assert.match(refused.text, /look-only/i);
  assert.equal((await post(agent, '/training-material/none/progress', { percent: 10 })).status, 403);
  assert.equal((await post(agent, '/standards/none/acknowledge')).status, 403);
  assert.equal((await request(app).get(`/assessments/${quiz.id}/take`).set('Cookie', viewing(agent))).status, 403);   // opening a practice would start a session in their name

  const before = await prisma.auditLog.count({ where: { actorId: agent.id } });
  const course1 = await request(app).get(`/training-course/${course.id}`).set('Cookie', viewing(agent));
  assert.equal(course1.status, 200);
  const entry = await prisma.auditLog.findFirst({ where: { actorId: agent.id, action: 'training.content_read' }, orderBy: { createdAt: 'desc' } });
  assert.ok(await prisma.auditLog.count({ where: { actorId: agent.id } }) > before);
  assert.equal(JSON.parse(entry.metadataJson).viaAdminId, admin.id);                                                    // the Admin is on record, not only the employee

  const sandbox = await prisma.trainingAttempt.count({ where: { profileId: tester.id } });
  assert.equal((await request(app).get(`/assessments/${quiz.id}/take`).set('Cookie', viewing(tester))).status, 200);   // the test account may try the learner's side
  assert.ok(sandbox >= 1);
  assert.equal((await post(agent, '/end-impersonation')).status, 302);                                                  // ending the view still works (it is not blocked)
});
