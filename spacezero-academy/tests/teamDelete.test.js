'use strict';
// An Admin can delete a team completely (active or archived). Its people stay; nothing is left pointing at the team.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const app = require('../server');

let org, admin, supervisor, agent, team, cookies = {};
const post = (p, url) => request(app).post(url).set('Cookie', cookies[p.id]).set('Content-Type', 'application/json').send('{}');

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Team delete tests' } });
  const mk = async (role, name) => {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `TD ${name}`, username: `td_${org.id}_${name}`, email: `td_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
    const t = generateToken(); await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookies[p.id] = `sz_session=${t.raw}`;
    return p;
  };
  admin = await mk('ADMIN', 'admin'); supervisor = await mk('SUPERVISOR', 'sup'); agent = await mk('TRAVEL_AGENT', 'agent');
  team = await prisma.team.create({ data: { organizationId: org.id, name: 'Doomed team', createdById: admin.id } });
  for (const p of [supervisor, agent]) await prisma.teamMembership.create({ data: { teamId: team.id, profileId: p.id } });
  await prisma.supervisorAssignment.create({ data: { supervisorId: supervisor.id, agentId: agent.id, teamId: team.id, assignedById: admin.id } });
  const course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Team course', createdById: admin.id, status: 'PUBLISHED', publishedVersion: 1 } });
  const a = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.id, scope: 'TEAM', targetTeamId: team.id } });
  await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: a.id, profileId: agent.id } });
});
after(async () => { await prisma.$disconnect(); });

test('only an Admin can delete a team', async () => {
  assert.equal((await post(supervisor, `/admin/teams/${team.id}/delete`)).status, 403);
  assert.equal((await post(agent, `/admin/teams/${team.id}/delete`)).status, 403);
  assert.ok(await prisma.team.findUnique({ where: { id: team.id } }));
});

test('the team list offers Delete, also for an archived team', async () => {
  await prisma.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
  const page = await request(app).get('/admin/teams').set('Cookie', cookies[admin.id]);
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`data-action="/admin/teams/${team.id}/delete"`));
});

test('an Admin deletes the team completely; its people, their training and the supervisor link stay', async () => {
  const res = await post(admin, `/admin/teams/${team.id}/delete`);
  assert.equal(res.status, 200);
  assert.equal(await prisma.team.findUnique({ where: { id: team.id } }), null);
  assert.equal(await prisma.teamMembership.count({ where: { teamId: team.id } }), 0);
  assert.equal(await prisma.profile.count({ where: { id: { in: [supervisor.id, agent.id] } } }), 2);          // people are not deleted
  const link = await prisma.supervisorAssignment.findFirst({ where: { agentId: agent.id } });
  assert.equal(link.supervisorId, supervisor.id); assert.equal(link.teamId, null);                        // still supervised, no dangling team id
  assert.equal(await prisma.trainingAssignmentRecipient.count({ where: { profileId: agent.id } }), 1);    // the training they were given stays
  const entry = await prisma.auditLog.findFirst({ where: { actorId: admin.id, action: 'team.deleted' } });
  assert.equal(JSON.parse(entry.metadataJson).name, 'Doomed team');
  assert.equal((await post(admin, `/admin/teams/${team.id}/delete`)).status, 404);                        // already gone
});

test('a team of another organization cannot be deleted', async () => {
  const other = await prisma.organization.create({ data: { name: 'Other org' } });
  const foreign = await prisma.team.create({ data: { organizationId: other.id, name: 'Foreign' } });
  assert.equal((await post(admin, `/admin/teams/${foreign.id}/delete`)).status, 404);
  assert.ok(await prisma.team.findUnique({ where: { id: foreign.id } }));
});
