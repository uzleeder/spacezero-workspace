'use strict';
// Small fixes from the pre-release audit: a mistyped sign-in keeps the return address, a bad filter value shows an empty
// list instead of an error page, and a workflow simulation without a skills list finishes instead of crashing.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');

mock.method(require('../lib/gemini'), 'generateStructured', async () => { throw new Error('Gemini must not be called in these tests'); });

const request = require('supertest');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const app = require('../server');

let org, admin, agent, cookies = {}, sim;
const withCookie = (p, req) => req.set('Cookie', cookies[p.id]);

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Audit small fixes' } });
  const mk = async (role, name) => {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `SF ${name}`, username: `sf_${org.id}_${name}`, email: `sf_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', passwordHash: await bcrypt.hash('TestPass123!', 4), employmentStartDate: new Date() } });
    const t = generateToken(); await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookies[p.id] = `sz_session=${t.raw}`;
    return p;
  };
  admin = await mk('ADMIN', 'admin'); agent = await mk('TRAVEL_AGENT', 'agent');
  const course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Sim course', createdById: admin.id, status: 'PUBLISHED', publishedVersion: 1 } });
  sim = await prisma.assessment.create({ data: { organizationId: org.id, courseId: course.id, createdVia: 'ADMIN_MANUAL', type: 'PROCESS_SIM', status: 'APPROVED', title: 'Booking workflow', createdById: admin.id, version: 1, configJson: JSON.stringify({ startId: 'a', nodes: [{ id: 'a', situation: 'A customer calls', options: [{ label: 'Greet them', score: 80, feedback: 'Good.', nextId: null }] }] }) } }); // no "skills" in the setup
  const a = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.id, scope: 'INDIVIDUAL' } });
  await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: a.id, profileId: agent.id } });
});
after(async () => { await prisma.$disconnect(); });

test('a failed sign-in keeps where the person was going', async () => {
  const res = await request(app).post('/login').type('form').send({ identifier: agent.username, password: 'wrong-password', companyCode: 'above9', next: '/training-course/abc123' });
  assert.equal(res.status, 200);
  assert.match(res.text, /Invalid username\/email or password/);
  assert.match(res.text, /name="next" value="\/training-course\/abc123"/);
  const ok = await request(app).post('/login').type('form').send({ identifier: agent.username, password: 'TestPass123!', companyCode: 'above9', next: '/training-course/abc123' });
  assert.equal(ok.status, 302); assert.equal(ok.headers.location, '/training-course/abc123');
  const foreign = await request(app).post('/login').type('form').send({ identifier: agent.username, password: 'TestPass123!', companyCode: 'above9', next: 'https://evil.example/' });
  assert.doesNotMatch(foreign.headers.location, /evil/);                                    // the redirect is still checked
});

test('a bad filter value on the Employees page is no filter, not an error page', async () => {
  for (const query of ['role=NOPE', 'status=%27%3B--', 'role=ADMIN&status=nonsense', 'role[]=x']) {
    const res = await withCookie(admin, request(app).get(`/admin/employees?${query}`));
    assert.equal(res.status, 200, query);
  }
  const real = await withCookie(admin, request(app).get('/admin/employees?role=TRAVEL_AGENT'));
  assert.match(real.text, /SF agent/);
});

test('a workflow simulation without a skills list finishes with a result', async () => {
  await withCookie(agent, request(app).get(`/assessments/${sim.id}/take`));
  const session = await prisma.practiceSession.findFirst({ where: { profileId: agent.id, assessmentId: sim.id } });
  const done = await withCookie(agent, request(app).post(`/assessments/${sim.id}/process`)).type('form').send({ sessionId: session.id, choice: '0' });
  assert.equal(done.status, 200);
  assert.match(done.text, /80%/);
  assert.equal(await prisma.trainingAttempt.count({ where: { profileId: agent.id, assessmentId: sim.id } }), 1);
});
