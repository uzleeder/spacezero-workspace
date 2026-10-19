'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { enqueueAnalysis } = require('../lib/trainingAnalysis');
const app = require('../server');

const ORG_ID = 'test_org_analysis';
let admin, supervisor, otherSupervisor, adminCookie, supervisorCookie, otherSupervisorCookie;
let courseByAdmin, courseBySupervisor;

before(async () => {
  await prisma.organization.upsert({ where: { id: ORG_ID }, update: {}, create: { id: ORG_ID, name: 'Test Org Analysis' } });

  async function profile(role, suffix) {
    return prisma.profile.create({
      data: {
        organizationId: ORG_ID,
        fullName: `Test ${suffix}`,
        username: `${suffix}_${randomUUID()}`,
        email: `${suffix}_${randomUUID()}@example.invalid`,
        role,
        status: 'ACTIVE',
        employmentStartDate: new Date('2025-01-01'),
      },
    });
  }
  async function session(p) {
    const token = generateToken();
    await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
    return `sz_session=${token.raw}`;
  }
  async function course(createdById) {
    return prisma.trainingCourse.create({ data: { organizationId: ORG_ID, title: `Course ${randomUUID()}`, createdById } });
  }

  admin = await profile('ADMIN', 'analysis_admin');
  supervisor = await profile('SUPERVISOR', 'analysis_sup');
  otherSupervisor = await profile('SUPERVISOR', 'analysis_other_sup');
  adminCookie = await session(admin);
  supervisorCookie = await session(supervisor);
  otherSupervisorCookie = await session(otherSupervisor);

  courseByAdmin = await course(admin.id);
  courseBySupervisor = await course(supervisor.id);
});

after(async () => {
  const ids = [admin.id, supervisor.id, otherSupervisor.id];
  await prisma.trainingAnalysis.deleteMany({ where: { course: { organizationId: ORG_ID } } });
  await prisma.trainingCourse.deleteMany({ where: { organizationId: ORG_ID } });
  await prisma.session.deleteMany({ where: { profileId: { in: ids } } });
  await prisma.profile.deleteMany({ where: { id: { in: ids } } });
  await prisma.organization.deleteMany({ where: { id: ORG_ID } });
  await prisma.$disconnect();
});

test('enqueueAnalysis creates a QUEUED row, resets a failed one, and is idempotent while one is active', async () => {
  const first = await enqueueAnalysis(courseByAdmin.id);
  assert.equal(first.status, 'QUEUED');
  assert.equal(first.retryCount, 0);

  await prisma.trainingAnalysis.update({ where: { id: first.id }, data: { status: 'FAILED', errorMessage: 'boom', retryCount: 3 } });
  const second = await enqueueAnalysis(courseByAdmin.id);
  assert.equal(second.id, first.id);
  assert.equal(second.status, 'QUEUED');
  assert.equal(second.retryCount, 0);
  assert.equal(second.errorMessage, null);
  // a second request while it is queued/running changes nothing and reports the duplicate
  await prisma.trainingAnalysis.update({ where: { id: first.id }, data: { status: 'EXTRACTING', completedStep: null } });
  const third = await enqueueAnalysis(courseByAdmin.id);
  assert.equal(third.duplicate, true);
  assert.equal((await prisma.trainingAnalysis.findUnique({ where: { id: first.id } })).status, 'EXTRACTING');
  await prisma.trainingAnalysis.update({ where: { id: first.id }, data: { status: 'FAILED' } });
});

test('GET /analysis leads to the AI Practice source when no analysis exists yet', async () => {
  const freshCourse = await prisma.trainingCourse.create({ data: { organizationId: ORG_ID, title: `No analysis ${randomUUID()}`, createdById: admin.id } });
  const res = await request(app).get(`/admin/training/${freshCourse.id}/analysis`).set('Cookie', adminCookie);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `/ai-practice/${freshCourse.id}`);
});

test('a supervisor cannot trigger, view, approve, or regenerate analysis on another supervisor\'s course', async () => {
  // lib/objectAccess.js already gates every /admin/training/:id/* subpath centrally (same rule
  // as every other training action route in this codebase) and 404s a non-owning supervisor
  // before the route handler even runs — so these come back 404, not 403.
  const analyzeRes = await request(app).post(`/admin/training/${courseBySupervisor.id}/analyze`).set('Cookie', otherSupervisorCookie);
  assert.equal(analyzeRes.status, 404);

  await prisma.trainingAnalysis.create({ data: { courseId: courseBySupervisor.id, status: 'READY_FOR_REVIEW' } });
  const viewRes = await request(app).get(`/admin/training/${courseBySupervisor.id}/analysis`).set('Cookie', otherSupervisorCookie);
  assert.equal(viewRes.status, 404);

  const approveRes = await request(app).post(`/admin/training/${courseBySupervisor.id}/analysis/approve`).set('Cookie', otherSupervisorCookie);
  assert.equal(approveRes.status, 404);

  const regenRes = await request(app).post(`/admin/training/${courseBySupervisor.id}/analysis/regenerate`).set('Cookie', otherSupervisorCookie);
  assert.equal(regenRes.status, 404);
});

test('AI Practice is Admin-only: even the supervisor who owns a course cannot view or act on its analysis or practice', async () => {
  const id = courseBySupervisor.id;
  for (const url of [`/admin/training/${id}/analysis`, `/admin/training/${id}/practice-plan`, '/ai-practice', '/ai-practice/new', '/admin/training/new']) {
    const res = await request(app).get(url).set('Cookie', supervisorCookie);
    assert.ok([403, 404].includes(res.status), `GET ${url} -> ${res.status}`);
  }
  for (const url of [`/admin/training/${id}/analyze`, `/admin/training/${id}/analysis/approve`, `/admin/training/${id}/analysis/regenerate`, `/admin/training/${id}/practice-plan`, `/admin/training/${id}/send-to-training`, `/admin/training/${id}/publish`]) {
    const res = await request(app).post(url).set('Cookie', supervisorCookie);
    assert.ok([403, 404].includes(res.status), `POST ${url} -> ${res.status}`);
  }
  await prisma.trainingCourse.update({ where: { id }, data: { origin: 'AI_PRACTICE' } });
  const viewRes = await request(app).get(`/ai-practice/${id}?step=analysis`).set('Cookie', adminCookie);
  assert.equal(viewRes.status, 200);
  assert.match(viewRes.text, /Analysis/);
});

test('approve is rejected unless the analysis is READY_FOR_REVIEW', async () => {
  const c = await prisma.trainingCourse.create({ data: { organizationId: ORG_ID, title: `Still processing ${randomUUID()}`, createdById: admin.id } });
  await prisma.trainingAnalysis.create({ data: { courseId: c.id, status: 'EXTRACTING' } });
  const res = await request(app).post(`/admin/training/${c.id}/analysis/approve`).set('Cookie', adminCookie);
  assert.equal(res.status, 400);
  const stored = await prisma.trainingAnalysis.findUnique({ where: { courseId: c.id } });
  assert.equal(stored.status, 'EXTRACTING');
});

test('the owning admin can approve a READY_FOR_REVIEW analysis and the review page renders its data', async () => {
  const c = await prisma.trainingCourse.create({ data: { organizationId: ORG_ID, title: `Ready ${randomUUID()}`, createdById: admin.id, origin: 'AI_PRACTICE' } });
  await prisma.trainingAnalysis.create({
    data: {
      courseId: c.id,
      status: 'READY_FOR_REVIEW',
      classificationsJson: JSON.stringify(['TECHNICAL', 'PROCESS_SOP']),
      objectivesJson: JSON.stringify(['Do the thing correctly.']),
      recommendedMethodsJson: JSON.stringify(['TECHNICAL']),
      recommendedIntensityJson: JSON.stringify(3),
    },
  });

  const viewRes = await request(app).get(`/ai-practice/${c.id}?step=analysis`).set('Cookie', adminCookie);
  assert.equal(viewRes.status, 200);
  assert.match(viewRes.text, /Technical/);
  assert.match(viewRes.text, /Do the thing correctly\./);
  assert.match(viewRes.text, /Create Recommended Practice/);

  const approveRes = await request(app).post(`/admin/training/${c.id}/analysis/approve`).set('Cookie', adminCookie);
  assert.equal(approveRes.status, 302);
  const stored = await prisma.trainingAnalysis.findUnique({ where: { courseId: c.id } });
  assert.equal(stored.status, 'APPROVED');
  assert.equal(stored.approvedById, admin.id);
  assert.ok(stored.approvedAt);
});

test('the passing-score floor is enforced on course creation', async () => {
  const res = await request(app)
    .post('/admin/training/new')
    .type('form')
    .set('Cookie', adminCookie)
    .send({ title: 'Below floor course', mandatory: '1', passingScore: '50', modulesJson: JSON.stringify([{ title: 'M1', contentType: 'NOTE', description: 'x' }]) });
  assert.equal(res.status, 200);
  assert.match(res.text, /below the organization minimum of 70%/);
  const created = await prisma.trainingCourse.findFirst({ where: { title: 'Below floor course' } });
  assert.equal(created, null);
});
