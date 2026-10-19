'use strict';
// The UzLeeder signature is visible to Admins only - not to Supervisors, Travel Agents, Flight Experts
// (or when viewing as one of them) and not on the login page.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const app = require('../server');

test('the UzLeeder signature shows for Admins only', async () => {
  const org = await prisma.organization.create({ data: { name: 'Credit tests' } });
  for (const role of ['ADMIN', 'SUPERVISOR', 'TRAVEL_AGENT', 'FLIGHT_EXPERT']) {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `Credit ${role}`, username: `uc_${org.id}_${role}`, email: `uc_${org.id}_${role}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
    const t = generateToken();
    await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } });
    for (const url of ['/dashboard', '/standards', '/profile']) {
      const page = await request(app).get(url).set('Cookie', `sz_session=${t.raw}`);
      assert.equal(page.status, 200, `${role} ${url}`);
      const shown = /<uzleeder-crafted/.test(page.text);
      assert.equal(shown, role === 'ADMIN', `${role} ${url}`);
      assert.equal(/uzleeder-crafted\.js/.test(page.text), role === 'ADMIN', `${role} ${url} script`);
    }
  }
  const login = await request(app).get('/login');
  assert.equal(login.status, 200);
  assert.doesNotMatch(login.text, /<uzleeder-crafted/);
  await prisma.$disconnect();
});
