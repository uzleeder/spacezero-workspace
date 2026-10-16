'use strict';
// Admins can delete an assigned training (for everyone, or for one employee). It leaves My Training and its
// attempts go with it; certificates and skill scores already earned stay. Nobody else may do it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { getMyTrainingList } = require('../lib/training');
const app = require('../server');

let org, admin, otherAdmin, sup, agentA, agentB, outsider, course, cookies = {};
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);

async function assign(recipients) {
  const assignment = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.id, scope: 'INDIVIDUAL' } });
  const rows = [];
  for (const p of recipients) {
    const r = await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: assignment.id, profileId: p.id } });
    await prisma.trainingAttempt.create({ data: { recipientId: r.id, profileId: p.id, status: 'COMPLETED', score: 90, attemptNumber: 1, completedAt: new Date() } });
    await prisma.trainingEmailSchedule.create({ data: { recipientId: r.id } });
    rows.push(r);
  }
  return { assignment, rows };
}

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Delete assignment tests' } });
  const foreignOrg = await prisma.organization.create({ data: { name: 'Foreign org' } });
  const mk = async (role, name, organizationId = org.id) => {
    const p = await prisma.profile.create({ data: { organizationId, fullName: name, username: `da_${organizationId}_${name}`, email: `da_${organizationId}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
    const t = generateToken(); await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookies[p.id] = `sz_session=${t.raw}`;
    return p;
  };
  admin = await mk('ADMIN', 'admin'); otherAdmin = await mk('ADMIN', 'otherAdmin'); sup = await mk('SUPERVISOR', 'sup');
  agentA = await mk('TRAVEL_AGENT', 'agentA'); agentB = await mk('TRAVEL_AGENT', 'agentB'); outsider = await mk('ADMIN', 'outsider', foreignOrg.id);
  course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Course to delete', createdById: admin.id, status: 'PUBLISHED' } });
});
after(async () => { await prisma.$disconnect(); });

test('the Training page offers Delete to Admins only', async () => {
  const { assignment } = await assign([agentA]);
  const page = await get(admin, '/assignments');
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`action="/assignments/${assignment.id}/delete"`));
  assert.match(page.text, /Course to delete/);
  await prisma.trainingAssignment.delete({ where: { id: assignment.id } });
});

test('an Admin deletes an assigned training: it leaves everyone\'s My Training, with attempts and email schedules; certificates stay; it is audited', async () => {
  const { assignment, rows } = await assign([agentA, agentB]);
  await prisma.certificate.create({ data: { profileId: agentA.id, courseId: course.id, title: 'Course to delete', description: 'done' } });
  assert.equal((await getMyTrainingList(agentA.id)).length, 1);
  const res = await post(admin, `/assignments/${assignment.id}/delete`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/assignments?deleted=1');
  assert.equal(await prisma.trainingAssignment.count({ where: { id: assignment.id } }), 0);
  assert.equal(await prisma.trainingAssignmentRecipient.count({ where: { assignmentId: assignment.id } }), 0);
  assert.equal(await prisma.trainingAttempt.count({ where: { recipientId: { in: rows.map((r) => r.id) } } }), 0);
  assert.equal(await prisma.trainingEmailSchedule.count({ where: { recipientId: { in: rows.map((r) => r.id) } } }), 0);
  assert.equal((await getMyTrainingList(agentA.id)).length, 0);
  assert.equal((await getMyTrainingList(agentB.id)).length, 0);
  assert.equal(await prisma.certificate.count({ where: { profileId: agentA.id } }), 1); // earned, stays
  assert.equal(await prisma.trainingCourse.count({ where: { id: course.id } }), 1);       // the course itself is untouched
  const audit = await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'training.assignment_deleted', targetId: assignment.id } });
  assert.equal(audit.actorId, admin.id);
  assert.deepEqual([JSON.parse(audit.metadataJson).recipients, JSON.parse(audit.metadataJson).attempts], [2, 2]);
  assert.match((await get(admin, '/assignments?deleted=1')).text, /assigned training was deleted/);
  assert.equal((await post(admin, `/assignments/${assignment.id}/delete`)).status, 404); // already gone
});

test('Supervisors, Employees and Admins of another organization cannot delete an assignment', async () => {
  const { assignment } = await assign([agentA]);
  for (const who of [sup, agentA, agentB]) assert.ok([302, 403, 404].includes((await post(who, `/assignments/${assignment.id}/delete`)).status));
  assert.equal((await post(outsider, `/assignments/${assignment.id}/delete`)).status, 404);
  assert.equal(await prisma.trainingAssignment.count({ where: { id: assignment.id } }), 1);
  assert.equal((await post(otherAdmin, `/assignments/${assignment.id}/delete`)).status, 302); // any Admin of the organization may
  assert.equal(await prisma.trainingAssignment.count({ where: { id: assignment.id } }), 0);
});

test('an Admin removes one employee from an assignment; the others keep it; the last removal deletes the empty assignment', async () => {
  const { assignment, rows } = await assign([agentA, agentB]);
  const page = await get(admin, `/employees/${agentA.id}/training`);
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`action="/employees/${agentA.id}/training/${rows[0].id}/delete"`));
  const res = await post(admin, `/employees/${agentA.id}/training/${rows[0].id}/delete`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `/employees/${agentA.id}/training?removed=1`);
  assert.equal((await getMyTrainingList(agentA.id)).length, 0);
  assert.equal((await getMyTrainingList(agentB.id)).length, 1);
  assert.equal(await prisma.trainingAssignment.count({ where: { id: assignment.id } }), 1);
  assert.match((await get(admin, `/employees/${agentA.id}/training?removed=1`)).text, /was removed from/);
  // a recipient id that belongs to someone else does not work through another employee's page
  assert.equal((await post(admin, `/employees/${agentA.id}/training/${rows[1].id}/delete`)).status, 404);
  assert.equal((await post(admin, `/employees/${agentB.id}/training/${rows[1].id}/delete`)).status, 302);
  assert.equal(await prisma.trainingAssignment.count({ where: { id: assignment.id } }), 0);
  assert.ok(await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'training.assignment_removed_from_employee', targetId: agentB.id } }));
});

test('only Admins see or use the per-employee Delete', async () => {
  const { assignment, rows } = await assign([agentA]);
  assert.doesNotMatch((await get(agentA, `/employees/${agentA.id}/training`)).text, /\/training\/[^"]+\/delete/);
  assert.equal((await post(agentA, `/employees/${agentA.id}/training/${rows[0].id}/delete`)).status, 403);
  assert.equal((await post(sup, `/employees/${agentA.id}/training/${rows[0].id}/delete`)).status === 200, false);
  assert.equal(await prisma.trainingAssignment.count({ where: { id: assignment.id } }), 1);
  await prisma.trainingAssignment.delete({ where: { id: assignment.id } });
});
