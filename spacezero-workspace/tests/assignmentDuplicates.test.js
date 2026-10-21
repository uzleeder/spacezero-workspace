'use strict';
// Assigning a training someone already has open does not create a second copy (the old one used to stay Overdue for ever);
// a company-wide assignment of many people finishes inside the database transaction limit.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');

mock.method(require('../lib/gemini'), 'generateStructured', async () => { throw new Error('Gemini must not be called in these tests'); });

const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { mergeDuplicateOpenCopies } = require('../lib/assignmentMerge');
const app = require('../server');

let org, admin, alice, bob, course, adminCookie;
const assign = (body) => request(app).post('/assignments').set('Cookie', adminCookie).type('form').send({ courseId: course.id, ...body });
const copies = (profile) => prisma.trainingAssignmentRecipient.findMany({ where: { profileId: profile.id, assignment: { courseId: course.id } }, include: { assignment: true, attempts: true } });

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Assignment duplicate tests' } });
  const mk = async (role, name) => prisma.profile.create({ data: { organizationId: org.id, fullName: `AD ${name}`, username: `ad_${org.id}_${name}`, email: `ad_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
  admin = await mk('ADMIN', 'admin'); alice = await mk('TRAVEL_AGENT', 'alice'); bob = await mk('TRAVEL_AGENT', 'bob');
  const t = generateToken(); await prisma.session.create({ data: { profileId: admin.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); adminCookie = `sz_session=${t.raw}`;
  course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Duplicates', createdById: admin.id, status: 'PUBLISHED', publishedVersion: 1 } });
});
after(async () => { await prisma.$disconnect(); });

test('assigning an open training again moves the open copy to the new assignment instead of adding a second one', async () => {
  const first = await assign({ scope: 'INDIVIDUAL', targetProfileIds: [alice.id, bob.id], dueDate: '2030-01-10' });
  assert.equal(first.status, 302);
  const [aliceCopy] = await copies(alice);
  const original = aliceCopy.assignment.id;
  // Alice has made progress on the first copy
  await prisma.trainingAttempt.updateMany({ where: { recipientId: aliceCopy.id }, data: { status: 'IN_PROGRESS', startedAt: new Date() } });

  const second = await assign({ scope: 'INDIVIDUAL', targetProfileIds: [alice.id], dueDate: '2030-02-20' });
  assert.equal(second.status, 302);
  const now = await copies(alice);
  assert.equal(now.length, 1);                                                          // still one copy
  assert.equal(now[0].id, aliceCopy.id);                                                // the same one, with her progress
  assert.notEqual(now[0].assignment.id, original);                                      // now on the new assignment, with the new due date
  assert.equal(now[0].assignment.dueDate.toISOString().slice(0, 10), '2030-02-20');
  assert.equal(now[0].attempts[0].status, 'IN_PROGRESS');
  assert.equal((await copies(bob)).length, 1);                                          // Bob was not part of the second assignment
  assert.equal((await copies(bob))[0].assignment.id, original);

  // a company-wide assignment reaches both once, and leaves the old assignment of nobody behind
  const company = await assign({ scope: 'COMPANY', dueDate: '2030-03-30' });
  assert.equal(company.status, 302);
  assert.equal((await copies(alice)).length, 1); assert.equal((await copies(bob)).length, 1);
  assert.equal(await prisma.trainingAssignment.count({ where: { id: original } }), 0);   // emptied: removed
});

test('a finished training is not touched: assigning it again is a fresh round', async () => {
  const [mine] = await copies(bob);
  await prisma.trainingAttempt.create({ data: { recipientId: mine.id, profileId: bob.id, status: 'COMPLETED', attemptNumber: 5, completedAt: new Date(), startedAt: new Date() } });
  await assign({ scope: 'INDIVIDUAL', targetProfileIds: [bob.id], dueDate: '2031-01-01' });
  assert.equal((await copies(bob)).length, 2);
});

test('a company-wide assignment of a few hundred people stays well inside the transaction limit', async () => {
  const extra = [];
  for (let i = 0; i < 250; i++) extra.push({ organizationId: org.id, fullName: `AD bulk ${i}`, username: `ad_bulk_${org.id}_${i}`, email: `ad_bulk_${org.id}_${i}@example.invalid`, role: 'TRAVEL_AGENT', status: 'ACTIVE', employmentStartDate: new Date() });
  await prisma.profile.createMany({ data: extra });
  const bigCourse = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Duplicates big', createdById: admin.id, status: 'PUBLISHED', publishedVersion: 1 } });
  const started = Date.now();
  const res = await request(app).post('/assignments').set('Cookie', adminCookie).type('form').send({ courseId: bigCourse.id, scope: 'COMPANY', dueDate: '2031-06-01' });
  assert.equal(res.status, 302);
  assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms`);
  assert.equal(await prisma.trainingAssignmentRecipient.count({ where: { assignment: { courseId: bigCourse.id } } }), 253);
  assert.equal(await prisma.trainingEmailSchedule.count({ where: { recipient: { assignment: { courseId: bigCourse.id } } } }), 253);
  assert.equal(await prisma.trainingAttempt.count({ where: { recipient: { assignment: { courseId: bigCourse.id } } } }), 253);
});

test('the clean-up removes untouched older duplicates and keeps the copy that was worked on', async () => {
  const dupCourse = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Existing mess', createdById: admin.id, status: 'PUBLISHED', publishedVersion: 1 } });
  const make = async (days, progress) => {
    const a = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: dupCourse.id, assignedById: admin.id, scope: 'INDIVIDUAL', createdAt: new Date(Date.now() - days * 86400000) } });
    const r = await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: a.id, profileId: alice.id, createdAt: new Date(Date.now() - days * 86400000) } });
    await prisma.trainingAttempt.create({ data: { recipientId: r.id, profileId: alice.id, status: progress ? 'IN_PROGRESS' : 'NOT_STARTED', attemptNumber: 1 } });
    return r;
  };
  const worked = await make(20, true); await make(10, false); await make(1, false);
  const dry = await mergeDuplicateOpenCopies(org.id, { dryRun: true });
  assert.ok(dry.removed >= 2);
  assert.equal(await prisma.trainingAssignmentRecipient.count({ where: { profileId: alice.id, assignment: { courseId: dupCourse.id } } }), 3);   // a dry run changes nothing
  await mergeDuplicateOpenCopies(org.id, { dryRun: false });
  const left = await prisma.trainingAssignmentRecipient.findMany({ where: { profileId: alice.id, assignment: { courseId: dupCourse.id } } });
  assert.deepEqual(left.map((r) => r.id), [worked.id]);
});
