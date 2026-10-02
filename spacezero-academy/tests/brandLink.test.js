'use strict';
// Clicking the SPACE ZERO / WORKSPACE logo in the sidebar goes to the dashboard (for every role).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const app = require('../server');

test('the sidebar logo is a link to the dashboard on every page and role', async () => {
  const org = await prisma.organization.create({ data: { name: 'Brand link tests' } });
  for (const role of ['ADMIN', 'SUPERVISOR', 'TRAVEL_AGENT', 'FLIGHT_EXPERT']) {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `Brand ${role}`, username: `bl_${org.id}_${role}`, email: `bl_${org.id}_${role}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
    const t = generateToken();
    await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } });
    for (const url of ['/dashboard', '/standards', '/profile']) {
      const page = await request(app).get(url).set('Cookie', `sz_session=${t.raw}`);
      assert.equal(page.status, 200, `${role} ${url}`);
      assert.match(page.text, /<div class="sidebar-brand">\s*<a href="\/dashboard" class="sidebar-brand-link"[^>]*>\s*[\s\S]*?SPACE ZERO[\s\S]*?<\/a>/, `${role} ${url}`);
    }
  }
  await prisma.$disconnect();
});
