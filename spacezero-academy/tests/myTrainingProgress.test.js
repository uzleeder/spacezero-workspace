'use strict';
// My Training says where the learner stands on each training (required items done, practices passed); opening a
// training starts it; and an Admin who is assigned a training goes through it like anybody else.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { getMyTrainingList } = require('../lib/training');
const { pathOf } = require('../lib/myTraining');
const { nextActions } = require('../lib/development');
const app = require('../server');

let org, admin, agent, cookies = {};
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);
const statusOf = async (who, r) => (await getMyTrainingList(who.id)).find((x) => x.id === r.id).status;
const courseAttempts = (r) => prisma.trainingAttempt.findMany({ where: { recipientId: r.id, assessmentId: null }, orderBy: { attemptNumber: 'asc' } });

before(async () => {
  org = await prisma.organization.create({ data: { name: 'My Training progress tests' } });
  const mk = async (role, name) => {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: name, username: `mtp_${org.id}_${name}`, email: `mtp_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
    const t = generateToken(); await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookies[p.id] = `sz_session=${t.raw}`;
    return p;
  };
  admin = await mk('ADMIN', 'admin'); agent = await mk('TRAVEL_AGENT', 'agent');
});
after(async () => { await prisma.$disconnect(); });

const mkPerson = async (role, name) => {
  const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: name, username: `mtp_${org.id}_${name}`, email: `mtp_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
  const t = generateToken(); await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookies[p.id] = `sz_session=${t.raw}`;
  return p;
};

// A published training with two required notes and one quiz, assigned to `who` as the assignment screens do it.
async function assignTraining(who, title, { quiz = true } = {}) {
  const course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title, createdById: admin.id, status: 'PUBLISHED', modules: { create: [
    { title: 'Read first', contentType: 'NOTE', description: 'Some text.', required: true, displayOrder: 0 },
    { title: 'Read second', contentType: 'NOTE', description: 'More text.', required: true, displayOrder: 1 },
  ] } }, include: { modules: true } });
  if (quiz) await prisma.assessment.create({ data: { organizationId: org.id, courseId: course.id, createdVia: 'ADMIN_MANUAL', type: 'QUIZ', status: 'APPROVED', title: `${title} quiz`, passingScore: 70, createdById: admin.id, version: 1 } });
  const assignment = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.id, scope: 'INDIVIDUAL' } });
  const recipient = await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: assignment.id, profileId: who.id } });
  await prisma.trainingAttempt.create({ data: { recipientId: recipient.id, profileId: who.id, status: 'NOT_STARTED', attemptNumber: 1 } });
  return { course, recipient };
}

test('My Training says where the learner stands: what a training holds before it starts, then items done and practices passed', async () => {
  const { course, recipient } = await assignTraining(agent, 'Progress course');
  let page = (await get(agent, '/training')).text;
  assert.match(page, /2 items · 1 practice/);                                  // not started yet: what it holds
  await prisma.mediaProgress.create({ data: { profileId: agent.id, trainingModuleId: course.modules[0].id, completedAt: new Date(), percentComplete: 100 } });
  await post(agent, `/training/${recipient.id}/start`);
  page = (await get(agent, '/training')).text;
  assert.match(page, /1 of 2 items done · 0 of 1 practice passed/);
  // "Continue" opens the training, which picks up at the first required item not finished yet
  assert.match(page, new RegExp('href="/training-course/' + course.id + '" data-main-action>Continue<'));
  assert.match((await get(agent, '/training-course/' + course.id)).text, /Step 2 of 4/);
  const [row] = (await getMyTrainingList(agent.id, { progress: true })).filter((r) => r.id === recipient.id);
  assert.deepEqual(row.progress, { items: { done: 1, total: 2 }, practices: { passed: 0, total: 1 } });
  assert.equal((await getMyTrainingList(agent.id)).find((r) => r.id === recipient.id).progress, undefined); // other pages do not pay for it
});

test('opening a training starts it, once; opening it again or reopening the list changes nothing more', async () => {
  const { course, recipient } = await assignTraining(agent, 'Open me');
  assert.equal(await statusOf(agent, recipient), 'NOT_STARTED');
  assert.equal((await get(agent, `/training-course/${course.id}`)).status, 200);
  assert.equal(await statusOf(agent, recipient), 'IN_PROGRESS');               // never stays under To do once looked at
  await get(agent, `/training-course/${course.id}`);
  await post(agent, `/training/${recipient.id}/start`);
  const attempts = await courseAttempts(recipient);
  assert.deepEqual(attempts.map((t) => t.status), ['IN_PROGRESS']);
  assert.ok(attempts[0].startedAt);
});

test('opening a training a manager asked to retake starts the retake, the same as pressing Start retake', async () => {
  const { course, recipient } = await assignTraining(agent, 'Retake me');
  await prisma.trainingAttempt.updateMany({ where: { recipientId: recipient.id }, data: { status: 'RETAKE_REQUIRED', retakeRequestedAt: new Date() } });
  assert.equal(await statusOf(agent, recipient), 'RETAKE_REQUIRED');
  assert.equal(pathOf(await getMyTrainingList(agent.id, { progress: true })).steps.find((st) => st.id === recipient.id).retake, true);
  await get(agent, `/training-course/${course.id}`);
  assert.deepEqual((await courseAttempts(recipient)).map((t) => [t.attemptNumber, t.status]), [[1, 'RETAKE_REQUIRED'], [2, 'IN_PROGRESS']]);
  await get(agent, `/training-course/${course.id}`);                             // a second open does not open another
  assert.equal((await courseAttempts(recipient)).length, 2);
});

test('an Admin who is assigned a training goes through it like anybody else: reading counts, and it finishes', async () => {
  const { course, recipient } = await assignTraining(admin, 'Admin learns', { quiz: false });
  const page = await get(admin, `/training-course/${course.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Step 1 of 3/);
  assert.equal(await statusOf(admin, recipient), 'IN_PROGRESS');               // opening it started it
  // opening the note's step started its reading clock, as it does for everybody
  const notes = [...course.modules].sort((x, y) => x.displayOrder - y.displayOrder);
  assert.ok(await prisma.mediaProgress.findUnique({ where: { profileId_trainingModuleId: { profileId: admin.id, trainingModuleId: notes[0].id } } }));
  // reading progress of a document is recorded for an assigned Admin (not treated as a preview)
  const progress = await post(admin, `/training-material/${course.modules[0].id}/progress`, { percent: 40, pages: 1 });
  assert.equal(progress.body.preview, undefined);
  // after a fair time with each note, Next finishes it and opens the next step - and the last one finishes the training
  for (const [i, m] of notes.entries()) {
    await get(admin, `/training-course/${course.id}?step=${i + 1}`);
    await prisma.mediaProgress.updateMany({ where: { profileId: admin.id }, data: { startedAt: new Date(Date.now() - 60000) } });
    const next = await post(admin, `/training-material/${m.id}/acknowledge`, { step: i + 1 });
    assert.equal(next.headers.location, `/training-course/${course.id}?step=${i + 2}`);
  }
  assert.equal(await statusOf(admin, recipient), 'COMPLETED');
  assert.match((await get(admin, '/training')).text, /You've completed all your training/);
});

test('an Admin previewing a training that is not assigned to them records nothing', async () => {
  const course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Just looking', createdById: admin.id, status: 'PUBLISHED', modules: { create: [{ title: 'A note', contentType: 'NOTE', description: 'Text.', required: true }] } }, include: { modules: true } });
  assert.equal((await get(admin, `/training-course/${course.id}`)).status, 200);
  assert.equal(await prisma.mediaProgress.count({ where: { profileId: admin.id, trainingModuleId: course.modules[0].id } }), 0);
  const progress = await post(admin, `/training-material/${course.modules[0].id}/progress`, { percent: 50, pages: 1 });
  assert.equal(progress.body.preview, true);
});

test('the one main button through every state of the path, the finish screen, and the Dashboard pointing at the same step', async () => {
  const who = await mkPerson('FLIGHT_EXPERT', 'walker');
  const mainButton = async () => { const html = (await get(who, '/training')).text; const m = html.match(/data-main-action>([^<]+)</); return { html, label: m ? m[1] : null, buttons: (html.match(/class="btn /g) || []).length }; };
  const dashNext = async () => (await nextActions(who)).next;

  // nothing assigned: no button
  let page = await mainButton();
  assert.match(page.html, /No training assigned yet/); assert.equal(page.buttons, 0);

  // the first training, not started: "Start training"
  const first = await assignTraining(who, 'Walk one');
  page = await mainButton();
  assert.deepEqual([page.label, page.buttons], ['Start training', 1]);
  assert.equal((await dashNext()).course.id, first.course.id);
  assert.equal((await dashNext()).action.label, 'Start training');

  // opened = in progress: "Continue"
  await get(who, '/training-course/' + first.course.id);
  page = await mainButton();
  assert.deepEqual([page.label, page.buttons], ['Continue', 1]);
  assert.equal((await dashNext()).action.label, 'Continue');

  // a failed practice: still "Continue", with what to do underneath
  for (const m of first.course.modules) await prisma.mediaProgress.upsert({ where: { profileId_trainingModuleId: { profileId: who.id, trainingModuleId: m.id } }, create: { profileId: who.id, trainingModuleId: m.id, completedAt: new Date(), percentComplete: 100 }, update: { completedAt: new Date(), percentComplete: 100 } });
  const quiz = await prisma.assessment.findFirst({ where: { courseId: first.course.id } });
  await prisma.trainingAttempt.create({ data: { recipientId: first.recipient.id, profileId: who.id, assessmentId: quiz.id, attemptNumber: 1, status: 'FAILED', score: 40, completedAt: new Date() } });
  page = await mainButton();
  assert.equal(page.label, 'Continue');
  assert.match(page.html, /Pass the quiz again to finish this step/);
  assert.match(page.html, new RegExp('href="/training-course/' + first.course.id + '" data-main-action'));
  // the training step: the 10-minute wait after a failed try, counting down, with Review the material; Try again comes after
  const failedStep = (await get(who, '/training-course/' + first.course.id)).text;
  assert.match(failedStep, /Your last score was 40%\. Pass the quiz again to finish this step\./);
  assert.match(failedStep, /You can try again in <strong data-retake-left>10 minutes<\/strong>/);
  assert.match(failedStep, /data-retake-review>Review the material</);
  assert.match(failedStep, new RegExp('action="/assessments/' + quiz.id + '/remediate" data-once data-retake-try hidden>'));
  assert.match(failedStep, /retake-countdown\.js/);
  // the wait is over: Try again (a new set of questions) is the one way on
  await prisma.trainingAttempt.updateMany({ where: { profileId: who.id, assessmentId: quiz.id }, data: { completedAt: new Date(Date.now() - 11 * 60000) } });
  const readyStep = (await get(who, '/training-course/' + first.course.id)).text;
  assert.match(readyStep, /data-retake-review hidden>/); assert.match(readyStep, new RegExp('action="/assessments/' + quiz.id + '/remediate" data-once data-retake-try>'));
  assert.match((await dashNext()).reason, /Pass the quiz again to finish this step/);

  // a second training waits, locked, behind the first
  const second = await assignTraining(who, 'Walk two');
  page = await mainButton();
  assert.match(page.html, /class="path-locked__title">Walk two</);
  assert.equal(page.buttons, 1);

  // passing finishes the first; its finish screen offers "Start next training"
  await prisma.trainingAttempt.create({ data: { recipientId: first.recipient.id, profileId: who.id, assessmentId: quiz.id, attemptNumber: 2, status: 'COMPLETED', score: 95, completedAt: new Date() } });
  const finish = (await get(who, '/training-course/' + first.course.id)).text;
  assert.match(finish, /<h2 class="step-title">Training complete<\/h2>/);
  assert.match(finish, /Next on your path: <strong>Walk two<\/strong>/);
  assert.match(finish, new RegExp('href="/training-course/' + second.course.id + '" data-step-next>Start next training<')); // the one main button

  // between trainings: "Start next training", and the Dashboard says the same
  page = await mainButton();
  assert.deepEqual([page.label, page.buttons], ['Start next training', 1]);
  assert.match(page.html, /<summary>1 completed<\/summary>/);
  assert.deepEqual([(await dashNext()).course.id, (await dashNext()).action.label], [second.course.id, 'Start next training']);
  const dashboard = (await get(who, '/dashboard')).text;
  assert.match(dashboard.split('id="next"')[1].split('</div>\n</div>')[0], new RegExp('Walk two[\\s\\S]*href="/training-course/' + second.course.id + '">Start next training<'));

  // all completed: no button; the finish screen says so and links back to My Training
  await post(who, '/training/' + second.recipient.id + '/start');
  const quiz2 = await prisma.assessment.findFirst({ where: { courseId: second.course.id } });
  for (const m of second.course.modules) await prisma.mediaProgress.upsert({ where: { profileId_trainingModuleId: { profileId: who.id, trainingModuleId: m.id } }, create: { profileId: who.id, trainingModuleId: m.id, completedAt: new Date(), percentComplete: 100 }, update: { completedAt: new Date(), percentComplete: 100 } });
  await prisma.trainingAttempt.create({ data: { recipientId: second.recipient.id, profileId: who.id, assessmentId: quiz2.id, attemptNumber: 1, status: 'COMPLETED', score: 95, completedAt: new Date() } });
  const lastFinish = (await get(who, '/training-course/' + second.course.id)).text;
  assert.match(lastFinish, /You've completed all your training\./);
  assert.match(lastFinish, /<a class="btn btn-gold" href="\/training" data-step-next>Back to My Training</);
  page = await mainButton();
  assert.deepEqual([page.label, page.buttons], [null, 0]);
  assert.match(page.html, /You've completed all your training/);
  assert.match(page.html, /<details class="path-fold" data-fold="completed" open>/);
  assert.equal(Boolean((await dashNext()) && (await dashNext()).path), false);
});
