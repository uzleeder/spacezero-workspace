'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const bcrypt = require('bcryptjs');

const { prisma } = require('../lib/prisma');
const app = require('../server');

const ORG_ID = 'test_org_auth';
let adminUser, agentUser, otherAgentUser, supervisorUser;

before(async () => {
  await prisma.organization.upsert({ where: { id: ORG_ID }, update: {}, create: { id: ORG_ID, name: 'Test Org' } });

  async function makeProfile(role, suffix) {
    const email = `${suffix}@test.local`;
    return prisma.profile.upsert({
      where: { email },
      update: {},
      create: {
        organizationId: ORG_ID,
        fullName: `Test ${suffix}`,
        username: suffix,
        email,
        role,
        status: 'ACTIVE',
        passwordHash: await bcrypt.hash('TestPass123!', 4),
        employmentStartDate: new Date('2025-01-01'),
      },
    });
  }

  adminUser = await makeProfile('ADMIN', 'test_admin');
  supervisorUser = await makeProfile('SUPERVISOR', 'test_supervisor');
  agentUser = await makeProfile('TRAVEL_AGENT', 'test_agent');
  otherAgentUser = await makeProfile('TRAVEL_AGENT', 'test_other_agent');

  // Login/forgot-password are rate-limited and persisted in the real
  // database — clear prior runs' counters for our test identities so
  // re-running this suite repeatedly never trips the limiter itself.
  await prisma.rateLimitAttempt.deleteMany({ where: { bucketKey: { contains: 'test' } } });
});

after(async () => {
  const ids = [adminUser, supervisorUser, agentUser, otherAgentUser].map((p) => p.id);
  await prisma.session.deleteMany({ where: { profileId: { in: ids } } });
  await prisma.profile.deleteMany({ where: { id: { in: ids } } });
  await prisma.organization.deleteMany({ where: { id: ORG_ID } });
  await prisma.$disconnect();
});

async function loginAs(user) {
  const res = await request(app)
    .post('/login')
    .type('form')
    .send({ identifier: user.username, password: 'TestPass123!', companyCode: 'above9' });
  const cookie = res.headers['set-cookie']?.[0];
  assert.ok(cookie, `login should set a session cookie for ${user.username}`);
  return cookie.split(';')[0];
}

test('unauthenticated request to a protected page redirects to /login', async () => {
  const res = await request(app).get('/dashboard');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/login/);
});

test('login with wrong password is rejected', async () => {
  const res = await request(app).post('/login').type('form').send({ identifier: 'test_admin', password: 'WrongPassword1', companyCode: 'above9' });
  assert.equal(res.status, 200);
  assert.match(res.text, /Invalid username\/email or password/);
  assert.equal(res.headers['set-cookie'], undefined);
});

test('login is rejected without a valid company code', async () => {
  const res = await request(app).post('/login').type('form').send({ identifier: 'test_admin', password: 'TestPass123!', companyCode: 'wrong' });
  assert.equal(res.status, 200);
  assert.match(res.text, /Invalid company code/);
  assert.equal(res.headers['set-cookie'], undefined);
});

test('login accepts either company code, case-insensitively', async () => {
  const res = await request(app).post('/login').type('form').send({ identifier: 'test_admin', password: 'TestPass123!', companyCode: 'SPACE0' });
  assert.ok(res.headers['set-cookie'], 'space0 (any case) should be accepted as a valid company code');
});

test('login with correct credentials sets a session and reaches the dashboard', async () => {
  const cookie = await loginAs(adminUser);
  const res = await request(app).get('/dashboard').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Dashboard/);
});

test('a non-admin cannot reach admin-only pages (server-side role check)', async () => {
  const cookie = await loginAs(agentUser);
  const res = await request(app).get('/admin/employees').set('Cookie', cookie);
  assert.equal(res.status, 403);
});

test('an agent cannot view another agent\'s data via URL guessing', async () => {
  const supCookie = await loginAs(supervisorUser);
  // supervisor has no assignment to otherAgentUser -> must be rejected, not just hidden in UI
  const res = await request(app).get(`/team/${otherAgentUser.id}`).set('Cookie', supCookie);
  assert.ok([403, 404].includes(res.status), `expected 403/404, got ${res.status}`);
});

// forgot-password is rate-limited per (email, IP) in the real, persisted
// database — reusing an email across test runs would eventually trip that
// limit. Each run gets its own throwaway email so re-running the suite
// repeatedly (as during development) never collides with a prior run.
async function makeThrowawayActiveProfile() {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return prisma.profile.create({
    data: {
      organizationId: ORG_ID,
      fullName: `Throwaway ${suffix}`,
      username: `throwaway_${suffix}`,
      email: `throwaway_${suffix}@test.local`,
      role: 'TRAVEL_AGENT',
      status: 'ACTIVE',
      passwordHash: await bcrypt.hash('TestPass123!', 4),
      employmentStartDate: new Date('2025-01-01'),
    },
  });
}

test('forgot-password never reveals whether an account exists', async () => {
  const throwaway = await makeThrowawayActiveProfile();
  const known = await request(app).post('/forgot-password').type('form').send({ email: throwaway.email });
  const unknown = await request(app).post('/forgot-password').type('form').send({ email: `nobody_${Date.now()}@test.local` });
  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.match(known.text, /you will receive a password reset email/);
  assert.match(unknown.text, /you will receive a password reset email/);
  await prisma.profile.delete({ where: { id: throwaway.id } });
});

test('forgot-password never exposes reset links when SMTP is not configured', async () => {
  const throwaway = await makeThrowawayActiveProfile();
  const res = await request(app).post('/forgot-password').type('form').send({ email: throwaway.email });
  const match = res.text.match(/\/reset-password\/([\w-]+)/);
  assert.equal(match, null, 'reset links must never be exposed publicly');
  await prisma.profile.delete({ where: { id: throwaway.id } });
});

test('security headers are present on every response', async () => {
  const res = await request(app).get('/login');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
});
