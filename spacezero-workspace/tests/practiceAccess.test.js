'use strict';
// "Start next practice" must always lead somewhere: the training page lists only the practice the person can really
// open, people who have no assignment of the training get no Start button, and a refused practice explains why.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const app = require('../server');

let org, admin, sup, whole, partial, course, quiz, technical, workflow, cookies = {};
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Practice access tests' } });
  const mk = async (role, name) => {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `PA ${name}`, username: `pa_${org.id}_${name}`, email: `pa_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
    const t = generateToken(); await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookies[p.id] = `sz_session=${t.raw}`;
    return p;
  };
  admin = await mk('ADMIN', 'admin'); sup = await mk('SUPERVISOR', 'sup'); whole = await mk('FLIGHT_EXPERT', 'whole'); partial = await mk('FLIGHT_EXPERT', 'partial');
  course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Sabre access', createdById: admin.id, status: 'PUBLISHED', publishedVersion: 1 } });
  const make = (type, title) => prisma.assessment.create({ data: { organizationId: org.id, courseId: course.id, createdVia: 'ADMIN_MANUAL', type, status: 'APPROVED', title, level: 3, createdById: admin.id, version: 1 } });
  quiz = await make('QUIZ', 'Sabre 2 — QUIZ'); technical = await make('TECHNICAL', 'Sabre 2 — TECHNICAL'); workflow = await make('QUIZ', 'Sabre 2 — Workflow');
  for (const q of [quiz, technical, workflow]) await prisma.question.create({ data: { assessmentId: q.id, type: 'MCQ', prompt: 'Q?', optionsJson: JSON.stringify(['A', 'B']), correctAnswerJson: JSON.stringify('A'), displayOrder: 0 } });
  // the whole training assigned to one person; ONE specific practice assigned to the other
  const a1 = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.id, scope: 'INDIVIDUAL' } });
  await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: a1.id, profileId: whole.id } });
  const a2 = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.id, scope: 'INDIVIDUAL', assessmentId: technical.id } });
  await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: a2.id, profileId: partial.id } });
});
after(async () => { await prisma.$disconnect(); });

// the practices that are steps of the training page (the bar of steps names every step)
const stepTitles = (html) => [...html.matchAll(/<span class="visually-hidden">Step \d+: ([^<(]+?)(?: \((?:done|locked)\))?<\/span>/g)].map((m) => m[1]);
const startLinks = (html) => [...html.matchAll(/href="\/assessments\/([a-z0-9]+)\/(?:take|roleplay)"/g)].map((m) => m[1]);

test('a learner assigned the whole training has every practice as a step, one at a time, and each one opens', async () => {
  const page = await get(whole, `/training-course/${course.id}`);
  assert.equal(page.status, 200);
  const titles = stepTitles(page.text);
  for (const p of [quiz, technical, workflow]) assert.ok(titles.includes(p.title), p.title);
  assert.equal(startLinks(page.text).length, 1);                                 // only the current step has a Start
  for (const p of [quiz, technical, workflow]) assert.equal((await get(whole, `/assessments/${p.id}/take`)).status, 200, p.title);
});

test('a learner assigned ONE practice sees only that one - never a Start that leads to "Page not found"', async () => {
  const page = await get(partial, `/training-course/${course.id}`);
  assert.deepEqual(startLinks(page.text), [technical.id]);
  const titles = stepTitles(page.text);                                             // not the whole set of three
  assert.ok(titles.includes(technical.title)); assert.ok(!titles.includes(quiz.title)); assert.ok(!titles.includes(workflow.title));
  assert.equal((await get(partial, `/assessments/${technical.id}/take`)).status, 200);
  // the practice they were not given is refused with an explanation, not a bare "not found"
  const refused = await get(partial, `/assessments/${quiz.id}/take`).set('Accept', 'text/html');
  assert.equal(refused.status, 404);
  assert.match(refused.text, /not part of a training assigned to you/);
  assert.match(refused.text, /href="\/training"[^>]*data-error-action>Open My Training</);
});

test('an Admin looking at the training sees the practices without a Start button (nothing is assigned to them)', async () => {
  const page = await get(admin, `/training-course/${course.id}`);
  assert.equal(page.status, 200);
  assert.equal(startLinks(page.text).length, 0);
  assert.match(page.text, /opens for the people this training is assigned to/);
  assert.ok(sup); // (a Supervisor without access to the course gets no page at all)
});
