'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const app = require('../server');
let org, admin, other, cookie;
const cases = [];

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Login-as isolation test' } });
  async function profile(role, extra = {}) {
    const name = randomUUID();
    return prisma.profile.create({ data: { organizationId: org.id, role, status: 'ACTIVE', fullName: name, username: name, email: `${name}@example.invalid`, employmentStartDate: new Date(), ...extra } });
  }
  admin = await profile('ADMIN'); other = await profile('ADMIN');
  for (const role of ['TRAVEL_AGENT', 'SUPERVISOR', 'FLIGHT_EXPERT']) {
    cases.push({ role, mine: await profile(role, { testOwnerAdminId: admin.id }), foreign: await profile(role, { testOwnerAdminId: other.id }), regular: await profile(role, { createdById: other.id }) });
  }
  const token = generateToken();
  await prisma.session.create({ data: { profileId: admin.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
  cookie = `sz_session=${token.raw}`;
});

after(async () => {
  if (org) {
    await prisma.profile.updateMany({ where: { organizationId: org.id }, data: { testOwnerAdminId: null } });
    await prisma.organization.delete({ where: { id: org.id } });
  }
  await prisma.$disconnect();
});

test('Login as hides other admin personal profiles for all three roles but preserves normal employees', async () => {
  for (const row of cases) {
    const response = await request(app).get(`/admin/login-as?role=${row.role}`).set('Cookie', cookie);
    assert.equal(response.status, 200);
    assert.ok(!response.text.includes(row.mine.fullName));
    assert.ok(response.text.includes(row.regular.fullName));
    assert.ok(!response.text.includes(row.foreign.fullName));
    const ownProfile = await request(app).get('/profile').set('Cookie', cookie);
    assert.equal(ownProfile.status, 200);
    assert.ok(ownProfile.text.includes(row.mine.username));
    assert.ok(!ownProfile.text.includes(row.foreign.username));
    const denied = await request(app).post(`/admin/login-as/${row.foreign.id}`).set('Cookie', cookie);
    assert.equal(denied.status, 404);
    assert.equal(denied.headers['set-cookie'], undefined);
    assert.equal(await prisma.session.count({ where: { profileId: row.foreign.id } }), 0);
    const allowed = await request(app).post(`/admin/login-as/${row.mine.id}`).set('Cookie', cookie);
    assert.equal(allowed.status, 302);
    assert.ok(allowed.headers['set-cookie']);
  }
});

test('another admin cannot remove a personal test designation', async () => {
  const response = await request(app).post(`/admin/employees/${cases[0].foreign.id}/personal-test-profile`).set('Cookie', cookie);
  assert.equal(response.status, 404);
  const target = await prisma.profile.findUnique({ where: { id: cases[0].foreign.id } });
  assert.equal(target.testOwnerAdminId, other.id);
});

test('employees list hides other admins\' personal test profiles but keeps everyone else', async () => {
  const response = await request(app).get('/admin/employees').set('Cookie', cookie);
  assert.equal(response.status, 200);
  for (const row of cases) {
    assert.ok(response.text.includes(row.mine.fullName));
    assert.ok(response.text.includes(row.regular.fullName));
    assert.ok(!response.text.includes(row.foreign.fullName));
  }
});

test('employee detail/status/invite/reset routes 404 or no-op on another admin\'s personal test profile', async () => {
  const foreign = cases[0].foreign;
  const detail = await request(app).get(`/admin/employees/${foreign.id}`).set('Cookie', cookie);
  assert.equal(detail.status, 404);

  const mine = cases[0].mine;
  const ownDetail = await request(app).get(`/admin/employees/${mine.id}`).set('Cookie', cookie);
  assert.equal(ownDetail.status, 200);

  await request(app).post(`/admin/employees/${foreign.id}/disable`).set('Cookie', cookie);
  const afterDisable = await prisma.profile.findUnique({ where: { id: foreign.id } });
  assert.equal(afterDisable.status, 'ACTIVE');

  const resetRes = await request(app).post(`/admin/employees/${foreign.id}/reset-password`).set('Cookie', cookie);
  assert.equal(resetRes.status, 200);
  assert.deepEqual(resetRes.body, { ok: true });
});

test('the new-employee supervisor picker excludes another admin\'s personal test supervisor', async () => {
  const supervisorCase = cases.find((c) => c.role === 'SUPERVISOR');
  const response = await request(app).get('/admin/employees/new').set('Cookie', cookie);
  assert.equal(response.status, 200);
  assert.ok(response.text.includes(supervisorCase.mine.fullName));
  assert.ok(response.text.includes(supervisorCase.regular.fullName));
  assert.ok(!response.text.includes(supervisorCase.foreign.fullName));
});

test('canViewProfile denies certificate/assignment-style access to another admin\'s personal test profile', async () => {
  const { canViewProfile } = require('../lib/authz');
  const foreign = cases[0].foreign;
  const mine = cases[0].mine;
  assert.equal(await canViewProfile(admin, foreign.id), false);
  assert.equal(await canViewProfile(admin, mine.id), true);
});
