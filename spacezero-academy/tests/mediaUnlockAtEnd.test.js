'use strict';
// Watching a required video/audio all the way to the END (100%, played in order, never skipped)
// finishes it, and the moment the server reports that, the practice/quiz of the training must be
// open: on the course page, on the quiz route itself, and the page markup must let the browser swap
// the locked section for the open one without a reload. Before the end the quiz stays locked.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const app = require('../server');

let org, admin, agent, course, lesson, assessment, cookie;
const get = (url) => request(app).get(url).set('Cookie', cookie);
const progress = (body) => request(app).post(`/training-media/${lesson.id}/progress`).set('Cookie', cookie).send(body);
// The anti-skip rule only lets playback advance by (time since the last save) x 1.2, so each step of
// the simulated viewing first moves the last-activity clock back as if that much real time had passed.
const watched = async (position, action = 'tick') => {
  await prisma.mediaProgress.updateMany({ where: { profileId: agent.id, trainingModuleId: lesson.id }, data: { lastActivityAt: new Date(Date.now() - 15000) } });
  return progress({ position, speed: 1, action });
};

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Unlock at end tests' } });
  const mk = async (role, name) => {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: name, username: `uend_${org.id}_${name}`, email: `uend_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
    const token = generateToken();
    await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
    return { p, cookie: `sz_session=${token.raw}` };
  };
  admin = (await mk('ADMIN', 'admin')).p;
  const a = await mk('TRAVEL_AGENT', 'agent');
  agent = a.p; cookie = a.cookie;
  course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Unlock course', createdById: admin.id, status: 'PUBLISHED', publishedVersion: 1 } });
  lesson = await prisma.trainingModule.create({ data: { courseId: course.id, title: 'The video', contentType: 'VIDEO', storagePath: 'training/none.mp4', required: true, sourceRefJson: '{"durationSeconds":60}' } });
  assessment = await prisma.assessment.create({ data: { courseId: course.id, organizationId: org.id, createdById: admin.id, createdVia: 'ADMIN_MANUAL', type: 'QUIZ', status: 'APPROVED', title: 'Unlock quiz', version: 1 } });
  const assignment = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.id, scope: 'INDIVIDUAL', courseVersion: 1 } });
  await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: assignment.id, profileId: agent.id } });
});
after(async () => { await prisma.$disconnect(); });

test('before the end of the video the quiz stays locked, even at 90%; the page marks the parts the browser swaps', async () => {
  assert.equal((await progress({ position: 0, speed: 1, action: 'start' })).status, 200);
  const early = await watched(18);
  assert.equal(early.status, 200);
  assert.equal(early.body.completedAt, null);
  assert.equal(early.body.unlocked, false);

  const page = await get(`/training-course/${course.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Locked until you finish the material/);
  assert.match(page.text, /data-gate-region/);
  assert.match(page.text, /data-next-card/);
  assert.match(page.text, /data-module-badge/);
  assert.match(page.text, /data-done="false"/);

  assert.equal((await watched(36)).body.completedAt, null, '60% is not enough');
  assert.equal((await watched(43)).body.completedAt, null, '70% is not enough any more');
  const ninety = await watched(54);
  assert.equal(ninety.body.completedAt, null, '90% is not enough either - the quiz opens only after 100%');
  assert.equal(ninety.body.unlocked, false);
  assert.match((await get(`/training-course/${course.id}`)).text, /Locked until you finish the material/);
  assert.equal((await get(`/assessments/${assessment.id}/take`)).status, 403);
});

test('at 100% the server reports the item finished AND unlocked, and the quiz opens straight away', async () => {
  const done = await watched(60); // played to the very end
  assert.equal(done.status, 200);
  assert.ok(done.body.completedAt, 'finished once the end is reached');
  assert.equal(done.body.unlocked, true);

  const page = await get(`/training-course/${course.id}`);
  assert.doesNotMatch(page.text, /Locked until you finish the material/);
  assert.match(page.text, /All required material finished/);
  assert.match(page.text, /Unlock quiz/);
  assert.match(page.text, new RegExp(`href="/assessments/${assessment.id}/take"`));
  assert.match(page.text, /data-done="true"/);
  assert.equal((await get(`/assessments/${assessment.id}/take`)).status, 200);
});

test('the player script unlocks in place the moment the server reports completion', async () => {
  const js = (await request(app).get('/static/js/media-progress.js')).text;
  assert.match(js, /data\.completedAt && !announced/, 'reacts to the first completed save');
  assert.match(js, /refreshGate/);
  assert.doesNotMatch(js, /window\.location\.reload\(\)/, 'no reload that would interrupt the video');
  assert.doesNotMatch(js, /70%/, 'no 70% wording any more');
});
