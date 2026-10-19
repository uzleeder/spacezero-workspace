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

async function assign(recipients, assignedBy = admin) {
  const assignment = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: assignedBy.id, scope: 'INDIVIDUAL' } });
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

test('Admin finds and deletes an older supervisor-created assignment beyond the first 20', async () => {
  const { assignment, rows } = await assign([agentA, agentB], sup);
  await prisma.trainingAssignment.update({ where: { id: assignment.id }, data: { createdAt: new Date('2001-01-01') } });
  for (let i = 0; i < 21; i++) await assign([agentA]);
  const firstPage = await get(admin, '/assignments');
  assert.match(firstPage.text, /aria-label="Assignment pages"/);
  assert.doesNotMatch(firstPage.text, new RegExp(`action="/assignments/${assignment.id}/delete"`));
  const secondPage = await get(admin, '/assignments?page=2');
  assert.equal(secondPage.status, 200);
  assert.match(secondPage.text, new RegExp(`action="/assignments/${assignment.id}/delete"`));
  assert.match(secondPage.text, /Assigned by <strong>sup<\/strong> · Supervisor/);
  const search = await get(admin, '/assignments?q=SUP');
  assert.match(search.text, new RegExp(`action="/assignments/${assignment.id}/delete"`));
  assert.match(search.text, /1 assignment/);
  assert.doesNotMatch(search.text, /onsubmit="return confirm/);
  const preview = await get(admin, `/assignments/${assignment.id}/delete?returnTo=${encodeURIComponent('/assignments?q=SUP')}`);
  assert.equal(preview.status, 200);
  assert.match(preview.text, /all 2 recipients/);
  assert.match(preview.text, /Assigned by <strong>sup<\/strong>/);
  assert.equal(await prisma.trainingAssignment.count({ where: { id: assignment.id } }), 1, 'GET confirmation does not delete');
  const deleted = await post(admin, `/assignments/${assignment.id}/delete`, { returnTo: '/assignments?q=SUP' });
  assert.equal(deleted.headers.location, '/assignments?q=SUP&deleted=1');
  assert.equal(await prisma.trainingAssignment.count({ where: { id: assignment.id } }), 0);
  assert.equal(await prisma.trainingEmailSchedule.count({ where: { recipientId: { in: rows.map(r => r.id) } } }), 0);
});

test('Admin can remove training assigned TO a supervisor without removing it from another employee', async () => {
  const { assignment, rows } = await assign([sup, agentB], otherAdmin);
  const page = await get(admin, `/employees/${sup.id}/training`);
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`action="/employees/${sup.id}/training/${rows[0].id}/delete"`));
  const preview = await get(admin, `/employees/${sup.id}/training/${rows[0].id}/delete`);
  assert.equal(preview.status, 200); assert.match(preview.text, /Other recipients will keep their assignment/);
  assert.equal((await post(admin, `/employees/${sup.id}/training/${rows[0].id}/delete`)).status, 302);
  assert.equal(await prisma.trainingAssignmentRecipient.count({ where: { id: rows[0].id } }), 0);
  assert.equal(await prisma.trainingAssignmentRecipient.count({ where: { id: rows[1].id } }), 1);
  assert.equal(await prisma.trainingAssignment.count({ where: { id: assignment.id } }), 1);
});

test('confirmation and searches preserve organization and role boundaries', async () => {
  const { assignment, rows } = await assign([agentB], sup);
  assert.equal((await get(outsider, `/assignments/${assignment.id}/delete`)).status, 404);
  assert.equal((await get(sup, `/assignments/${assignment.id}/delete`)).status, 403);
  assert.equal((await get(agentB, `/employees/${agentB.id}/training/${rows[0].id}/delete`)).status, 403);
  assert.equal((await get(admin, `/employees/${agentA.id}/training/${rows[0].id}/delete`)).status, 404);
  assert.doesNotMatch((await get(outsider, '/assignments?q=sup')).text, new RegExp(`action="/assignments/${assignment.id}/delete"`));
  await prisma.supervisorCapability.create({ data: { organizationId: org.id, supervisorId: sup.id, key: 'training.assign', grantedById: admin.id } });
  const ownPage = await get(sup, '/assignments?q=sup');
  assert.equal(ownPage.status, 200);
  assert.match(ownPage.text, new RegExp(`action="/assignments/${assignment.id}/delete"`)); // their own assignment gets Delete...
  const adminsOwn = await assign([agentB], admin);
  assert.doesNotMatch((await get(sup, '/assignments')).text, new RegExp(`/assignments/${adminsOwn.assignment.id}/delete`)); // ...the Admin's does not
  assert.equal((await get(sup, `/assignments/${adminsOwn.assignment.id}/delete`)).status, 404);
  await prisma.trainingAssignment.delete({ where: { id: adminsOwn.assignment.id } });
  const preview = await get(admin, `/assignments/${assignment.id}/delete?returnTo=https://example.invalid`);
  assert.match(preview.text, /href="\/assignments">Cancel/);
  assert.equal(await prisma.trainingAssignment.count({ where: { id: assignment.id } }), 1);
});

async function usedCourse(title) {
  const c = await prisma.trainingCourse.create({ data: { organizationId: org.id, title, createdById: admin.id, status: 'PUBLISHED', publishedVersion: 1, origin: 'AI_PRACTICE', modules: { create: [{ title: 'Material', contentType: 'NOTE', description: 'x' }] } } });
  const quiz = await prisma.assessment.create({ data: { organizationId: org.id, courseId: c.id, createdVia: 'ADMIN_MANUAL', type: 'QUIZ', title: 'Quiz', createdById: admin.id, status: 'APPROVED', version: 1, questions: { create: [{ type: 'MCQ', prompt: 'Q?', correctAnswerJson: '"a"' }] } } });
  const assignment = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: c.id, assignedById: sup.id, scope: 'INDIVIDUAL' } });
  const recipient = await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: assignment.id, profileId: agentA.id } });
  await prisma.trainingAttempt.create({ data: { recipientId: recipient.id, assessmentId: quiz.id, profileId: agentA.id, status: 'COMPLETED', score: 80, attemptNumber: 1, completedAt: new Date() } });
  await prisma.trainingEmailSchedule.create({ data: { recipientId: recipient.id } });
  await prisma.practiceSession.create({ data: { profileId: agentA.id, assessmentId: quiz.id } });
  await prisma.aiTask.create({ data: { organizationId: org.id, courseId: c.id, taskType: 'ANALYZE' } });
  await prisma.certificate.create({ data: { profileId: agentA.id, courseId: c.id, title, description: 'done' } });
  return { c, quiz, recipient };
}

test('an Admin deletes ANY training, even one that was sent to Training, assigned (by a Supervisor), attempted and certified', async () => {
  const before = (await getMyTrainingList(agentA.id)).length;
  const { c, quiz, recipient } = await usedCourse('Used course');
  assert.equal((await getMyTrainingList(agentA.id)).length, before + 1);
  for (const url of [`/admin/training/${c.id}`, `/admin/training`]) assert.match((await get(admin, url)).text, new RegExp(`href="/admin/training/${c.id}/delete"`));
  const page = await get(admin, `/admin/training/${c.id}/delete`);
  assert.equal(page.status, 200);
  assert.match(page.text, /<strong>1<\/strong> assignment/);
  assert.match(page.text, /<strong>1<\/strong> attempt/);
  assert.equal(await prisma.trainingCourse.count({ where: { id: c.id } }), 1, 'the confirmation page deletes nothing');
  const res = await post(admin, `/admin/training/${c.id}/delete`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/training?deleted=1');
  assert.equal(await prisma.trainingCourse.count({ where: { id: c.id } }), 0);
  for (const model of ['trainingAssignment', 'assessment', 'trainingModule']) assert.equal(await prisma[model].count({ where: { courseId: c.id } }), 0, model);
  assert.equal(await prisma.trainingAttempt.count({ where: { recipientId: recipient.id } }), 0);
  assert.equal(await prisma.trainingEmailSchedule.count({ where: { recipientId: recipient.id } }), 0);
  assert.equal(await prisma.practiceSession.count({ where: { assessmentId: quiz.id } }), 0);
  assert.equal(await prisma.aiTask.count({ where: { courseId: c.id } }), 0);
  assert.equal((await getMyTrainingList(agentA.id)).length, before);
  assert.equal(await prisma.certificate.count({ where: { courseId: c.id } }), 1); // earned, stays
  const audit = await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'training.course_deleted', targetId: c.id } });
  assert.equal(audit.actorId, admin.id);
  assert.equal(JSON.parse(audit.metadataJson).assignments, 1);
  assert.match((await get(admin, '/admin/training?deleted=1')).text, /The training was deleted/);
  assert.equal((await post(admin, `/admin/training/${c.id}/delete`)).status, 404);
});

test('only an Admin of the same organization can delete a training; AI Practice sends an Admin to the confirmation page', async () => {
  const { c } = await usedCourse('Protected course');
  for (const who of [sup, agentA, outsider]) {
    assert.notEqual((await post(who, `/admin/training/${c.id}/delete`)).status, 302);
    assert.notEqual((await get(who, `/admin/training/${c.id}/delete`)).status, 200);
  }
  assert.equal(await prisma.trainingCourse.count({ where: { id: c.id } }), 1);
  const viaAi = await post(admin, `/ai-practice/${c.id}/delete`);
  assert.equal(viaAi.headers.location, `/admin/training/${c.id}/delete`);
  assert.equal(await prisma.trainingCourse.count({ where: { id: c.id } }), 1);
  assert.equal((await post(otherAdmin, `/admin/training/${c.id}/delete`)).status, 302); // any Admin of the organization
  assert.equal(await prisma.trainingCourse.count({ where: { id: c.id } }), 0);
});

test('a Supervisor can delete the trainings THEY assigned (and remove them from their own team), never the Admin\'s', async () => {
  await prisma.supervisorAssignment.create({ data: { supervisorId: sup.id, agentId: agentA.id, assignedById: admin.id } });
  const mine = await assign([agentA, agentB], sup);
  const adminsOwn = await assign([agentA], admin);
  // from the employee page: only the ones they assigned
  const page = (await get(sup, `/employees/${agentA.id}/training`)).text;
  assert.match(page, new RegExp(`/employees/${agentA.id}/training/${mine.rows[0].id}/delete`));
  assert.doesNotMatch(page, new RegExp(`/employees/${agentA.id}/training/${adminsOwn.rows[0].id}/delete`));
  assert.equal((await post(sup, `/employees/${agentA.id}/training/${adminsOwn.rows[0].id}/delete`)).status, 403);
  assert.equal(await prisma.trainingAssignmentRecipient.count({ where: { id: adminsOwn.rows[0].id } }), 1);
  assert.equal((await post(sup, `/employees/${agentA.id}/training/${mine.rows[0].id}/delete`)).status, 302);
  assert.equal(await prisma.trainingAssignmentRecipient.count({ where: { id: mine.rows[0].id } }), 0);
  assert.equal(await prisma.trainingAssignmentRecipient.count({ where: { id: mine.rows[1].id } }), 1); // the other person keeps it
  // the whole assignment from the Training page: theirs yes, the Admin's no
  assert.equal((await post(sup, `/assignments/${adminsOwn.assignment.id}/delete`)).status, 404);
  assert.equal((await post(sup, `/assignments/${mine.assignment.id}/delete`)).status, 302);
  assert.equal(await prisma.trainingAssignment.count({ where: { id: mine.assignment.id } }), 0);
  assert.equal(await prisma.trainingAssignment.count({ where: { id: adminsOwn.assignment.id } }), 1);
  assert.ok(await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'training.assignment_deleted', targetId: mine.assignment.id, actorId: sup.id } }));
  // a Supervisor without the assign permission has none of this
  await prisma.supervisorCapability.deleteMany({ where: { supervisorId: sup.id, key: 'training.assign' } });
  const again = await assign([agentA], sup);
  assert.equal((await post(sup, `/assignments/${again.assignment.id}/delete`)).status, 403);
  assert.doesNotMatch((await get(sup, `/employees/${agentA.id}/training`)).text, /training\/[^"]+\/delete/);
  assert.equal((await post(sup, `/employees/${agentA.id}/training/${again.rows[0].id}/delete`)).status, 403);
  await prisma.supervisorCapability.create({ data: { organizationId: org.id, supervisorId: sup.id, key: 'training.assign', grantedById: admin.id } });
  await prisma.trainingAssignment.deleteMany({ where: { id: { in: [again.assignment.id, adminsOwn.assignment.id] } } });
});

test('a Supervisor can delete a training they created, but not the Admin\'s, nor one the Admin assigned to others', async () => {
  const own = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Supervisor course', createdById: sup.id, status: 'PUBLISHED', publishedVersion: 1, origin: 'AI_PRACTICE' } });
  const adminsCourse = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Admin course', createdById: admin.id, status: 'PUBLISHED', publishedVersion: 1 } });
  const catalog = (await get(sup, '/admin/training?category=UNCATEGORIZED')).text;
  assert.match(catalog, new RegExp(`/admin/training/${own.id}/delete`));
  assert.doesNotMatch(catalog, new RegExp(`/admin/training/${adminsCourse.id}/delete`));
  // someone else's training: the central object-access guard answers 404 (it does not even confirm the course exists)
  assert.equal((await get(sup, `/admin/training/${adminsCourse.id}/delete`)).status, 404);
  assert.equal((await post(sup, `/admin/training/${adminsCourse.id}/delete`)).status, 404);
  assert.equal(await prisma.trainingCourse.count({ where: { id: adminsCourse.id } }), 1);
  // the Admin assigned it to somebody: the Supervisor may no longer remove it
  const byAdmin = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: own.id, assignedById: admin.id, scope: 'INDIVIDUAL' } });
  assert.equal((await post(sup, `/admin/training/${own.id}/delete`)).status, 403);
  assert.notEqual((await post(sup, `/ai-practice/${own.id}/delete`)).headers.location, `/admin/training/${own.id}/delete`);
  assert.equal(await prisma.trainingCourse.count({ where: { id: own.id } }), 1);
  await prisma.trainingAssignment.delete({ where: { id: byAdmin.id } });
  // theirs alone: confirmation page, then it is gone, for the people they assigned it to as well
  const theirs = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: own.id, assignedById: sup.id, scope: 'INDIVIDUAL' } });
  await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: theirs.id, profileId: agentB.id } });
  assert.equal((await get(sup, `/admin/training/${own.id}/delete`)).status, 200);
  assert.equal((await post(sup, `/admin/training/${own.id}/delete`)).status, 302);
  assert.equal(await prisma.trainingCourse.count({ where: { id: own.id } }), 0);
  assert.equal(await prisma.trainingAssignment.count({ where: { id: theirs.id } }), 0);
  assert.ok(await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'training.course_deleted', targetId: own.id, actorId: sup.id } }));
  await prisma.trainingCourse.delete({ where: { id: adminsCourse.id } });
});

test('AI Practice: an Admin deletes trainings that are in use in bulk (after a confirmation page) and recordings behind a training; nobody else can', async () => {
  const a = await usedCourse('Bulk in use A'); const b = await usedCourse('Bulk in use B');
  const unused = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Bulk unused', createdById: admin.id, status: 'DRAFT', origin: 'AI_PRACTICE' } });
  const ids = [`material:${a.c.id}`, `material:${b.c.id}`, `material:${unused.id}`];
  // the plain delete still protects what is in use
  await post(admin, '/ai-practice/bulk', { action: 'delete', ids });
  assert.equal(await prisma.trainingCourse.count({ where: { id: { in: [a.c.id, b.c.id] } } }), 2);
  assert.equal(await prisma.trainingCourse.count({ where: { id: unused.id } }), 0);
  const ids2 = [`material:${a.c.id}`, `material:${b.c.id}`];
  assert.match((await get(admin, '/ai-practice')).text, /value="delete-all"/);
  // delete-all first shows what goes, and deletes nothing
  const confirm = await post(admin, '/ai-practice/bulk', { action: 'delete-all', ids: ids2 });
  assert.equal(confirm.status, 200); assert.match(confirm.text, /2 items will be deleted permanently/); assert.match(confirm.text, /1 assignment/);
  assert.equal(await prisma.trainingCourse.count({ where: { id: { in: [a.c.id, b.c.id] } } }), 2);
  // a Supervisor cannot use it
  assert.notEqual((await post(sup, '/ai-practice/bulk', { action: 'delete-all', confirm: '1', ids: ids2 })).status, 200);
  assert.equal(await prisma.trainingCourse.count({ where: { id: { in: [a.c.id, b.c.id] } } }), 2);
  const done = await post(admin, '/ai-practice/bulk', { action: 'delete-all', confirm: '1', ids: ids2 });
  assert.equal(done.status, 302);
  assert.equal(await prisma.trainingCourse.count({ where: { id: { in: [a.c.id, b.c.id] } } }), 0);
  assert.equal(await prisma.trainingAssignment.count({ where: { courseId: { in: [a.c.id, b.c.id] } } }), 0);
  assert.equal(await prisma.certificate.count({ where: { courseId: a.c.id } }), 1); // earned, stays
  assert.ok(await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'training.course_deleted', targetId: a.c.id } }));
  // recordings an analysis turned into a training: an Admin may delete them, the training stays
  const made = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Made from calls', createdById: admin.id, status: 'PUBLISHED', publishedVersion: 1 } });
  const batch = await prisma.callBatch.create({ data: { organizationId: org.id, uploadedById: admin.id, mode: 'BEST_PRACTICE', status: 'APPROVED', generatedCourseId: made.id } });
  assert.equal((await post(admin, `/ai-practice/calls/${batch.id}/delete`)).status, 302);
  assert.equal(await prisma.callBatch.count({ where: { id: batch.id } }), 0);
  assert.equal(await prisma.trainingCourse.count({ where: { id: made.id } }), 1);
  const batch2 = await prisma.callBatch.create({ data: { organizationId: org.id, uploadedById: admin.id, mode: 'BEST_PRACTICE', status: 'APPROVED', generatedCourseId: made.id } });
  const viaBulk = await post(admin, '/ai-practice/bulk', { action: 'delete-all', confirm: '1', ids: [`call:${batch2.id}`] });
  assert.equal(viaBulk.status, 302); assert.equal(await prisma.callBatch.count({ where: { id: batch2.id } }), 0);
});
test('search, categories and pagination combine, including invalid page input', async () => {
  await prisma.trainingCourse.update({ where: { id: course.id }, data: { trainingCategory: 'PRODUCT' } });
  const page = await get(admin, '/assignments?q=agentA&category=PRODUCT&page=2');
  assert.equal(page.status, 200);
  assert.match(page.text, /Page 2 of 2/);
  assert.match(page.text, /q=agentA&amp;category=PRODUCT/);
  const wrongCategory = await get(admin, '/assignments?q=agentA&category=SALES');
  assert.match(wrongCategory.text, /No matching assignments/);
  for (const value of ['-1', 'NaN', '99999999999999999999']) assert.equal((await get(admin, `/assignments?page=${value}`)).status, 200);
});
