'use strict';
// An Admin removes a person by ARCHIVING (kept, restorable) or DELETING (gone for good); the page asks which.
// Deleting keeps what the person created for the company (it moves to the Admin) and removes what belongs to them.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const app = require('../server');

let org, foreignOrg, admin, admin2, sup, agent, agent2, outsider, cookies = {};
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);
let seq = 0;

async function person(role, name, organizationId = org.id, extra = {}) {
  seq += 1;
  const p = await prisma.profile.create({ data: { organizationId, fullName: name, username: `ed_${seq}_${name}`, email: `ed_${seq}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date(), passwordHash: 'x', ...extra } });
  const t = generateToken(); await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookies[p.id] = `sz_session=${t.raw}`;
  return p;
}

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Delete people tests' } });
  foreignOrg = await prisma.organization.create({ data: { name: 'Foreign people org' } });
  admin = await person('ADMIN', 'admin'); admin2 = await person('ADMIN', 'admin2'); sup = await person('SUPERVISOR', 'sup');
  agent = await person('TRAVEL_AGENT', 'agent'); agent2 = await person('TRAVEL_AGENT', 'agent2'); outsider = await person('ADMIN', 'outsider', foreignOrg.id);
});
after(async () => { await prisma.$disconnect(); });

test('the delete-or-archive page offers both, and Archive keeps the person', async () => {
  const victim = await person('TRAVEL_AGENT', 'archivee');
  const page = await get(admin, `/admin/employees/${victim.id}/remove`);
  assert.equal(page.status, 200);
  assert.match(page.text, /value="archive"/); assert.match(page.text, /value="delete"/); assert.match(page.text, /type <strong>DELETE<\/strong>/);
  assert.match((await get(admin, `/admin/employees/${victim.id}`)).text, new RegExp(`/admin/employees/${victim.id}/remove`));
  const res = await post(admin, `/admin/employees/${victim.id}/remove`, { mode: 'archive' });
  assert.equal(res.headers.location, '/admin/employees?removed=archived');
  const kept = await prisma.profile.findUnique({ where: { id: victim.id } });
  assert.equal(kept.status, 'ARCHIVED'); assert.ok(kept.archivedAt);
  assert.equal(await prisma.session.count({ where: { profileId: victim.id } }), 0); // signed out
  assert.match((await get(admin, '/admin/employees?removed=archived')).text, /was archived/);
  assert.match((await post(admin, `/admin/employees/${victim.id}/remove`, {})).text, /Choose Archive or Delete/);
});

test('Delete needs the typed confirmation; then the person and everything of theirs is gone, what they created is kept and handed to the Admin', async () => {
  const victim = sup;
  const course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Made by the supervisor', createdById: victim.id, status: 'PUBLISHED', publishedVersion: 1 } });
  const quiz = await prisma.assessment.create({ data: { organizationId: org.id, courseId: course.id, createdVia: 'ADMIN_MANUAL', type: 'QUIZ', title: 'Quiz', createdById: victim.id, status: 'APPROVED' } });
  const assignment = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: victim.id, scope: 'INDIVIDUAL' } });
  const rec = await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: assignment.id, profileId: agent2.id } });
  await prisma.trainingAttempt.create({ data: { recipientId: rec.id, assessmentId: quiz.id, profileId: agent2.id, status: 'COMPLETED', score: 80, attemptNumber: 1, completedAt: new Date() } });
  const batch = await prisma.callBatch.create({ data: { organizationId: org.id, uploadedById: victim.id, mode: 'BEST_PRACTICE' } });
  const item = await prisma.libraryItem.create({ data: { organizationId: org.id, title: 'Doc', itemType: 'NOTE', createdById: victim.id } });
  const team = await prisma.team.create({ data: { organizationId: org.id, name: 'Sup team', createdById: victim.id } });
  await prisma.supervisorAssignment.create({ data: { supervisorId: victim.id, agentId: agent2.id } });
  await prisma.coachingNote.create({ data: { organizationId: org.id, profileId: agent2.id, authorId: victim.id, body: 'About someone else' } });
  await prisma.coachingNote.create({ data: { organizationId: org.id, profileId: victim.id, authorId: admin.id, body: 'About the supervisor' } });
  await prisma.credential.create({ data: { organizationId: org.id, ownerId: victim.id, system: 'GDS', payloadEnc: 'x' } });
  await prisma.practiceSession.create({ data: { profileId: victim.id, assessmentId: quiz.id } });
  const test = await person('TRAVEL_AGENT', 'suptest', org.id, { testOwnerAdminId: null });

  const preview = await get(admin, `/admin/employees/${victim.id}/remove?mode=delete`);
  assert.match(preview.text, /Handed over to you/); assert.match(preview.text, /1 vault entry/);
  // not confirmed -> nothing happens
  assert.match((await post(admin, `/admin/employees/${victim.id}/remove`, { mode: 'delete', confirm: 'delete me' })).text, /Type DELETE/);
  assert.equal(await prisma.profile.count({ where: { id: victim.id } }), 1);
  const res = await post(admin, `/admin/employees/${victim.id}/remove`, { mode: 'delete', confirm: 'DELETE' });
  assert.equal(res.status, 302); assert.equal(res.headers.location, '/admin/employees?removed=deleted');
  assert.equal(await prisma.profile.count({ where: { id: victim.id } }), 0);
  for (const [model, where] of [['session', { profileId: victim.id }], ['credential', { ownerId: victim.id }], ['supervisorAssignment', { supervisorId: victim.id }], ['practiceSession', { profileId: victim.id }], ['coachingNote', { profileId: victim.id }]]) assert.equal(await prisma[model].count({ where }), 0, model);
  // what they made for the company survives, now attributed to the Admin
  for (const [model, id, field] of [['trainingCourse', course.id, 'createdById'], ['assessment', quiz.id, 'createdById'], ['trainingAssignment', assignment.id, 'assignedById'], ['callBatch', batch.id, 'uploadedById'], ['libraryItem', item.id, 'createdById'], ['team', team.id, 'createdById']]) {
    assert.equal((await prisma[model].findUnique({ where: { id } }))[field], admin.id, model);
  }
  assert.equal(await prisma.trainingAssignmentRecipient.count({ where: { id: rec.id } }), 1); // other people keep their training
  assert.equal((await prisma.coachingNote.findFirst({ where: { profileId: agent2.id, body: 'About someone else' } })).authorId, admin.id);
  const audit = await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'employee.deleted', targetId: victim.id } });
  assert.equal(audit.actorId, admin.id); assert.equal(JSON.parse(audit.metadataJson).username, victim.username);
  assert.match((await get(admin, '/admin/employees?removed=deleted')).text, /deleted permanently/);
  assert.ok(test); // an unrelated person is untouched
  assert.equal(await prisma.profile.count({ where: { id: test.id } }), 1);
  // the deleted person's old session no longer works
  assert.notEqual((await get(victim, '/dashboard')).status, 200);
});

test('limits: not yourself, not the last Administrator, not another organization, Admins only', async () => {
  assert.match((await post(admin, `/admin/employees/${admin.id}/remove`, { mode: 'delete', confirm: 'DELETE' })).text, /cannot delete your own/);
  assert.match((await post(admin, `/admin/employees/${admin.id}/remove`, { mode: 'archive' })).text, /cannot archive your own/);
  assert.equal(await prisma.profile.count({ where: { id: admin.id } }), 1);
  assert.equal((await get(admin, `/admin/employees/${outsider.id}/remove`)).status, 404);
  assert.equal((await post(admin, `/admin/employees/${outsider.id}/remove`, { mode: 'delete', confirm: 'DELETE' })).status, 404);
  assert.equal(await prisma.profile.count({ where: { id: outsider.id } }), 1);
  for (const who of [agent, agent2]) assert.notEqual((await post(who, `/admin/employees/${admin2.id}/remove`, { mode: 'delete', confirm: 'DELETE' })).status, 302);
  assert.equal(await prisma.profile.count({ where: { id: admin2.id } }), 1);
  // another Administrator may be deleted while someone else remains...
  const extra = await person('ADMIN', 'extraadmin');
  assert.equal((await post(admin, `/admin/employees/${extra.id}/remove`, { mode: 'delete', confirm: 'DELETE' })).status, 302);
  assert.equal(await prisma.profile.count({ where: { id: extra.id } }), 0);
  // ...but never the last active one
  const last = await person('ADMIN', 'lastadmin', foreignOrg.id); // the only other Administrator of its own organization is the outsider
  await prisma.profile.update({ where: { id: outsider.id }, data: { status: 'DISABLED' } });
  const { deleteBlocker } = require('../lib/employeeDeletion');
  assert.match(await deleteBlocker(outsider, last), /last active Administrator/);
  await prisma.profile.update({ where: { id: outsider.id }, data: { status: 'ACTIVE' } });
  assert.equal(await deleteBlocker(outsider, last), null);
});

test('an Administrator\'s private test profiles are deleted with them', async () => {
  const boss = await person('ADMIN', 'boss');
  const t1 = await person('TRAVEL_AGENT', 'bosstest1', org.id, { testOwnerAdminId: boss.id });
  await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Boss course', createdById: boss.id, status: 'DRAFT' } });
  const res = await post(admin, `/admin/employees/${boss.id}/remove`, { mode: 'delete', confirm: 'DELETE' });
  assert.equal(res.status, 302);
  assert.equal(await prisma.profile.count({ where: { id: { in: [boss.id, t1.id] } } }), 0);
  assert.equal((await prisma.trainingCourse.findFirst({ where: { title: 'Boss course' } })).createdById, admin.id);
  const audit = await prisma.auditLog.findFirst({ where: { action: 'employee.deleted', targetId: boss.id } });
  assert.equal(JSON.parse(audit.metadataJson).testProfilesDeleted, 1);
});
