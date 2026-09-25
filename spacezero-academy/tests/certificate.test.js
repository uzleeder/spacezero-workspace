'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const bcrypt = require('bcryptjs');

const { prisma } = require('../lib/prisma');
const app = require('../server');

const ORG_ID = 'test_org_cert';
let owner, otherAgent, admin, certificate;

before(async () => {
  await prisma.organization.upsert({ where: { id: ORG_ID }, update: {}, create: { id: ORG_ID, name: 'Test Org Cert' } });

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

  owner = await makeProfile('TRAVEL_AGENT', 'test_cert_owner');
  otherAgent = await makeProfile('TRAVEL_AGENT', 'test_cert_other');
  admin = await makeProfile('ADMIN', 'test_cert_admin');

  certificate = await prisma.certificate.create({
    data: { profileId: owner.id, title: 'Test Course', description: 'Completed for testing.' },
  });

  await prisma.rateLimitAttempt.deleteMany({ where: { bucketKey: { contains: 'test_cert' } } });
});

after(async () => {
  const ids = [owner.id, otherAgent.id, admin.id];
  await prisma.certificate.deleteMany({ where: { profileId: { in: ids } } });
  await prisma.session.deleteMany({ where: { profileId: { in: ids } } });
  await prisma.profile.deleteMany({ where: { id: { in: ids } } });
  await prisma.organization.deleteMany({ where: { id: ORG_ID } });
  await prisma.$disconnect();
});

async function loginAs(user) {
  const res = await request(app).post('/login').type('form').send({ identifier: user.username, password: 'TestPass123!', companyCode: 'above9' });
  return res.headers['set-cookie'][0].split(';')[0];
}

test('the certificate owner can view their own certificate', async () => {
  const cookie = await loginAs(owner);
  const res = await request(app).get(`/certificates/${certificate.id}`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Test Course/);
});

test('an unrelated agent cannot view someone else\'s certificate', async () => {
  const cookie = await loginAs(otherAgent);
  const res = await request(app).get(`/certificates/${certificate.id}`).set('Cookie', cookie);
  assert.ok([403, 404].includes(res.status), `expected 403/404, got ${res.status}`);
});

test('an admin can view any certificate in their organization', async () => {
  const cookie = await loginAs(admin);
  const res = await request(app).get(`/certificates/${certificate.id}`).set('Cookie', cookie);
  assert.equal(res.status, 200);
});

test('a nonexistent certificate id returns 404, not a crash', async () => {
  const cookie = await loginAs(owner);
  const res = await request(app).get('/certificates/does-not-exist').set('Cookie', cookie);
  assert.equal(res.status, 404);
});
