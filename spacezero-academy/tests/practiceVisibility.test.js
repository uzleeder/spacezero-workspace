'use strict';
// After the material is finished the quiz must appear. An assignment tied to ONE practice that was later replaced used to
// leave the practice list empty for ever; it is now a whole-training assignment again, and a learner whose assignment
// really has no practice open is told so instead of seeing nothing.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');

mock.method(require('../lib/gemini'), 'generateStructured', async () => { throw new Error('Gemini must not be called in these tests'); });

const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { healDanglingPractices } = require('../lib/assignmentRepair');
const app = require('../server');

let org, admin, agent, cookie, course, quizB, assignment;

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Practice visibility' } });
  const mk = async (role, name) => prisma.profile.create({ data: { organizationId: org.id, fullName: `PV ${name}`, username: `pv_${org.id}_${name}`, email: `pv_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
  admin = await mk('ADMIN', 'admin'); agent = await mk('TRAVEL_AGENT', 'agent');
  const t = generateToken(); await prisma.session.create({ data: { profileId: agent.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookie = `sz_session=${t.raw}`;
  course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Visibility course', createdById: admin.id, status: 'PUBLISHED', publishedVersion: 1 } });   // no required material: the practice is open at once
  const practice = (title) => prisma.assessment.create({ data: { organizationId: org.id, courseId: course.id, createdVia: 'ADMIN_MANUAL', type: 'QUIZ', status: 'APPROVED', title, createdById: admin.id, version: 1 } });
  await practice('Quiz A'); quizB = await practice('Quiz B');
  // assigned for ONE practice that has since been replaced (archived)
  const gone = await prisma.assessment.create({ data: { organizationId: org.id, courseId: course.id, createdVia: 'ADMIN_MANUAL', type: 'QUIZ', status: 'APPROVED', title: 'Old quiz', createdById: admin.id, version: 1, archivedAt: new Date() } });
  assignment = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.id, scope: 'COMPANY', assessmentId: gone.id, courseVersion: 1 } });
  await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: assignment.id, profileId: agent.id } });
});
after(async () => { await prisma.$disconnect(); });

test('an assignment for one replaced practice is a whole-training assignment again, and the quiz appears', async () => {
  const page = await request(app).get(`/training-course/${course.id}`).set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Quiz A/); assert.match(page.text, /Quiz B/);
  assert.doesNotMatch(page.text, /not available yet/);
  assert.equal((await prisma.trainingAssignment.findUnique({ where: { id: assignment.id } })).assessmentId, null);
  assert.equal(await healDanglingPractices(course.id), 0);                              // nothing more to repair
});

test('an assignment for one practice that is still there stays that one practice', async () => {
  await prisma.trainingAssignment.update({ where: { id: assignment.id }, data: { assessmentId: quizB.id } });
  const page = await request(app).get(`/training-course/${course.id}`).set('Cookie', cookie);
  assert.match(page.text, /Quiz B/); assert.doesNotMatch(page.text, /Quiz A/);
  assert.equal((await prisma.trainingAssignment.findUnique({ where: { id: assignment.id } })).assessmentId, quizB.id);
  const open = await request(app).get(`/assessments/${quizB.id}/take`).set('Cookie', cookie);
  assert.equal(open.status, 200);
});

test('a learner whose assigned version has no practice is told, not shown an empty page', async () => {
  await prisma.trainingAssignment.update({ where: { id: assignment.id }, data: { assessmentId: null, courseVersion: 3 } });   // practice exists, but only for version 1
  const page = await request(app).get(`/training-course/${course.id}`).set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Your practice is not available yet/);
});
