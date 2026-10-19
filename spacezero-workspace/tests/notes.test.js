'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const app = require('../server');

const ORG_ID = 'test_org_notes';
let agent, otherAgent, admin, agentCookie, otherCookie, adminCookie;

before(async () => {
  await prisma.organization.upsert({ where: { id: ORG_ID }, update: {}, create: { id: ORG_ID, name: 'Test Org Notes' } });

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

  agent = await profile('TRAVEL_AGENT', 'notes_agent');
  otherAgent = await profile('TRAVEL_AGENT', 'notes_other');
  admin = await profile('ADMIN', 'notes_admin');
  agentCookie = await session(agent);
  otherCookie = await session(otherAgent);
  adminCookie = await session(admin);
});

after(async () => {
  const ids = [agent.id, otherAgent.id, admin.id];
  await prisma.note.deleteMany({ where: { profileId: { in: ids } } });
  await prisma.session.deleteMany({ where: { profileId: { in: ids } } });
  await prisma.profile.deleteMany({ where: { id: { in: ids } } });
  await prisma.organization.deleteMany({ where: { id: ORG_ID } });
  await prisma.$disconnect();
});

test('an agent can create, see, and save a note, but another agent cannot see it', async () => {
  const create = await request(app).post('/notes').type('form').set('Cookie', agentCookie).send({ title: 'My note', content: 'Remember this.' });
  assert.equal(create.status, 302);

  const note = await prisma.note.findFirst({ where: { profileId: agent.id } });
  assert.ok(note);
  assert.equal(note.content, 'Remember this.');
  assert.equal(note.isSaved, false);

  const own = await request(app).get('/notes').set('Cookie', agentCookie);
  assert.match(own.text, /Remember this\./);

  const foreign = await request(app).get('/notes').set('Cookie', otherCookie);
  assert.doesNotMatch(foreign.text, /Remember this\./);

  const save = await request(app).post(`/notes/${note.id}/save`).set('Cookie', agentCookie);
  assert.equal(save.status, 200);
  assert.equal((await prisma.note.findUnique({ where: { id: note.id } })).isSaved, true);

  const savedView = await request(app).get('/notes?view=saved').set('Cookie', agentCookie);
  assert.match(savedView.text, /Remember this\./);
});

test('an agent cannot edit, save, or delete another agent\'s note', async () => {
  const note = await prisma.note.create({ data: { organizationId: ORG_ID, profileId: agent.id, content: 'Private to owner.' } });

  const editAttempt = await request(app).post(`/notes/${note.id}`).type('form').set('Cookie', otherCookie).send({ content: 'Hijacked' });
  assert.equal(editAttempt.status, 404);

  const saveAttempt = await request(app).post(`/notes/${note.id}/save`).set('Cookie', otherCookie);
  assert.equal(saveAttempt.status, 404);

  const deleteAttempt = await request(app).post(`/notes/${note.id}/delete`).set('Cookie', otherCookie);
  assert.equal(deleteAttempt.status, 404);

  const stillThere = await prisma.note.findUnique({ where: { id: note.id } });
  assert.ok(stillThere);
  assert.equal(stillThere.content, 'Private to owner.');
  assert.equal(stillThere.isSaved, false);
});

test('an admin cannot reach the Notes feature (agents/experts only)', async () => {
  const response = await request(app).get('/notes').set('Cookie', adminCookie);
  assert.equal(response.status, 403);
});

test('deleting a note removes it', async () => {
  const note = await prisma.note.create({ data: { organizationId: ORG_ID, profileId: agent.id, content: 'Temporary.' } });
  const del = await request(app).post(`/notes/${note.id}/delete`).set('Cookie', agentCookie);
  assert.equal(del.status, 200);
  assert.equal(await prisma.note.findUnique({ where: { id: note.id } }), null);
});
