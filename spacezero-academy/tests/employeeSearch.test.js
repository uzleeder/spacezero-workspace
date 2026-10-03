'use strict';
// The Employees & Teams search box used to be ignored: its OR clause was overwritten by the
// "hide other admins' test profiles" OR clause, so every search returned everyone.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { containsText } = require('../lib/textSearch');
const app = require('../server');

test('containsText trims and only adds insensitive mode on Postgres', () => {
  const saved = process.env.DATABASE_URL;
  try {
    process.env.DATABASE_URL = 'file:./dev.db';
    assert.deepEqual(containsText('  Ali '), { contains: 'Ali' });
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
    assert.deepEqual(containsText('Ali'), { contains: 'Ali', mode: 'insensitive' });
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved;
  }
});

test('the employee search narrows the list and combines with the role filter', async () => {
  const org = await prisma.organization.create({ data: { name: 'Employee search tests' } });
  const make = (key, fullName, role) => prisma.profile.create({ data: { organizationId: org.id, fullName, username: `es_${org.id}_${key}`, email: `es_${org.id}_${key}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
  const admin = await make('admin', 'Search Admin', 'ADMIN');
  await make('a', 'Zanzibar Quill', 'TRAVEL_AGENT');
  await make('b', 'Mirelle Dovetail', 'TRAVEL_AGENT');
  await make('c', 'Zanzibar Pilot', 'FLIGHT_EXPERT');
  const t = generateToken();
  await prisma.session.create({ data: { profileId: admin.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } });
  const get = (qs) => request(app).get('/admin/employees' + qs).set('Cookie', `sz_session=${t.raw}`);
  const names = (res) => ['Zanzibar Quill', 'Mirelle Dovetail', 'Zanzibar Pilot'].filter((n) => res.text.includes(n));

  assert.deepEqual(names(await get('')), ['Zanzibar Quill', 'Mirelle Dovetail', 'Zanzibar Pilot']);
  assert.deepEqual(names(await get('?q=zanzibar')), ['Zanzibar Quill', 'Zanzibar Pilot']);
  assert.deepEqual(names(await get('?q=DOVETAIL')), ['Mirelle Dovetail']);
  assert.deepEqual(names(await get(`?q=es_${org.id}_b`)), ['Mirelle Dovetail']);
  assert.deepEqual(names(await get('?q=zanzibar&role=FLIGHT_EXPERT')), ['Zanzibar Pilot']);
  assert.deepEqual(names(await get('?q=nobody-has-this-name')), []);
  await prisma.$disconnect();
});
