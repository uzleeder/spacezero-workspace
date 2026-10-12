'use strict';
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const emails = require('../lib/trainingEmails');
const { trainingDeadline } = require('../lib/trainingDeadline');
const app = require('../server');
let org, admin, learner, sup, outsider, course;
const cookies = {};
const now = new Date('2099-04-01T10:00:00Z');
const later = ms => new Date(now.getTime() + ms);
const oldOrigin = process.env.APP_ORIGIN;
async function person(role, organizationId = org.id) {
  const uid = randomUUID();
  const p = await prisma.profile.create({ data: { organizationId, fullName: 'Email fixture ' + role, username: uid, email: uid + '@example.invalid', role, status: 'ACTIVE', employmentStartDate: now } });
  const token = generateToken();
  await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
  cookies[p.id] = 'sz_session=' + token.raw;
  return p;
}
const post = (actor, url, body = {}) => request(app).post(url).set('Cookie', cookies[actor.id]).type('form').send(body);
async function assignment({ profileId = learner.id, dueDate = now, actor = admin, enqueue = true } = {}) {
  return prisma.$transaction(async tx => {
    const a = await tx.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: actor.id, scope: 'INDIVIDUAL', dueDate } });
    const r = await tx.trainingAssignmentRecipient.create({ data: { assignmentId: a.id, profileId } });
    await tx.trainingAttempt.create({ data: { recipientId: r.id, profileId, attemptNumber: 1, status: 'NOT_STARTED' } });
    if (enqueue) await emails.enqueueAssignment(tx, r.id, now);
    return r;
  });
}
const job = r => prisma.trainingEmailSchedule.findUnique({ where: { recipientId: r.id } });
before(async () => {
  // The suite shares one temporary DB across sequential files. Earlier assignment tests
  // leave pending jobs; this worker test must consume only its own fixtures.
  assert.equal(process.env.NODE_ENV, 'test');
  assert.match(process.env.DATABASE_URL, /academy-tests-/);
  await prisma.trainingEmailSchedule.deleteMany();
  process.env.APP_ORIGIN = 'https://workspace.example.invalid';
  org = await prisma.organization.create({ data: { name: 'Training email tests' } });
  const foreign = await prisma.organization.create({ data: { name: 'Email foreign org' } });
  admin = await person('ADMIN'); learner = await person('TRAVEL_AGENT'); sup = await person('SUPERVISOR'); outsider = await person('ADMIN', foreign.id);
  course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Email course', status: 'PUBLISHED', createdById: admin.id, assignPolicy: 'ALL_SUPERVISORS' } });
  await prisma.supervisorCapability.create({ data: { organizationId: org.id, supervisorId: sup.id, key: 'training.assign', grantedById: admin.id } });
  await prisma.supervisorAssignment.create({ data: { supervisorId: sup.id, agentId: learner.id, assignedById: admin.id } });
});
afterEach(async () => { await prisma.trainingEmailSchedule.deleteMany({ where: { recipient: { assignment: { organizationId: org.id } } } }); });
after(async () => { if (oldOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = oldOrigin; await prisma.$disconnect(); });

test('assignment POST atomically queues one email per recipient and exposes send email controls', async () => {
  const res = await post(admin, '/assignments', { courseId: course.id, scope: 'INDIVIDUAL', targetProfileIds: learner.id, dueDate: '2099-04-01', dueTime: '18:30' });
  assert.equal(res.status, 302);
  const r = await prisma.trainingAssignmentRecipient.findFirst({ where: { profileId: learner.id, assignment: { organizationId: org.id } }, orderBy: { createdAt: 'desc' }, include: { assignment: true, emailSchedule: true } });
  assert.equal(r.assignment.dueDate.toISOString(), '2099-04-01T13:30:00.000Z');
  assert.equal(r.emailSchedule.kind, 'ASSIGNED');
  const page = await request(app).get('/assignments').set('Cookie', cookies[admin.id]);
  assert.equal(page.status, 200); assert.match(page.text, /Assign &amp; send email/); assert.match(page.text, />Send email<\/button>/); assert.match(page.text, /every 3 hours/);
});

test('first email sends immediately; reminders wait 3 hours after due date and repeat at 3-hour intervals', async () => {
  const r = await assignment({ dueDate: later(3600000) }); const sent = [];
  const send = async (m, o) => sent.push({ m, o });
  await emails.processNext({ now, send });
  assert.match(sent[0].m.subject, /Training assigned/); assert.equal(sent[0].m.to, learner.email);
  assert.match(sent[0].m.text, /Tashkent, UTC\+05:00/); assert.match(sent[0].m.text, /https:\/\/workspace.example.invalid\/training-course\//);
  assert.equal((await job(r)).nextSendAt.getTime(), later(4 * 3600000).getTime());
  assert.equal(await emails.processNext({ now: later(4 * 3600000 - 1), send }), false);
  await emails.processNext({ now: later(4 * 3600000), send });
  assert.match(sent[1].m.subject, /Overdue training reminder/);
  assert.equal((await job(r)).nextSendAt.getTime(), later(7 * 3600000).getTime());
  await emails.processNext({ now: later(7 * 3600000), send });
  assert.equal(sent.length, 3); assert.notEqual(sent[1].o.idempotencyKey, sent[2].o.idempotencyKey);
});

test('completion stops reminders; no deadline sends only the assignment email', async () => {
  const r = await assignment(); let count = 0; const send = async () => count++;
  await emails.processNext({ now, send });
  await prisma.trainingAttempt.updateMany({ where: { recipientId: r.id }, data: { status: 'COMPLETED', completedAt: now } });
  await emails.processNext({ now: later(emails.THREE_HOURS), send });
  assert.equal(count, 1); assert.equal((await job(r)).nextSendAt, null);
  const noDue = await assignment({ dueDate: null });
  await emails.processNext({ now, send }); assert.equal((await job(noDue)).nextSendAt, null); assert.equal(count, 2);
});

test('a multi-assessment training is not complete after passing only one component', () => {
  const a = { id: 'a', version: 1, status: 'APPROVED', passingScore: 70 };
  const r = { assignment: { courseVersion: 1, minimumScore: 70, requiredAttempts: 1, course: { assessments: [a, { ...a, id: 'b' }] } }, attempts: [{ assessmentId: 'a', attemptNumber: 2, status: 'COMPLETED', score: 90, completedAt: now }] };
  assert.equal(emails.completed(r), false);
  r.attempts.push({ assessmentId: 'b', attemptNumber: 3, status: 'COMPLETED', score: 90, completedAt: now });
  assert.equal(emails.completed(r), true);
  r.assignment.requiredAttempts = 2; assert.equal(emails.completed(r), false);
});

test('retry retains the payload and idempotency key and never marks a failed send as accepted', async () => {
  const r = await assignment(); const sent = [];
  await emails.processNext({ now, send: async (m, o) => { sent.push({ m, o }); throw new Error('provider unavailable'); } });
  let state = await job(r); assert.equal(state.assignmentSentAt, null); assert.equal(state.retryCount, 1); assert.match(state.lastError, /retried/);
  await prisma.trainingCourse.update({ where: { id: course.id }, data: { title: 'Changed title during retry' } });
  await emails.processNext({ now: new Date(state.nextSendAt), send: async (m, o) => sent.push({ m, o }) });
  assert.deepEqual(sent[0], sent[1]); state = await job(r); assert.ok(state.assignmentSentAt); assert.equal(state.retryCount, 0);
});

test('concurrent workers cannot send the same message; a stale lease is recoverable', async () => {
  const r = await assignment(); let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  let count = 0;
  const first = emails.processNext({ now, send: async () => { count++; started(); await gate; } });
  await ready;
  assert.equal(await emails.processNext({ now, send: async () => count++ }), false);
  release(); await first; assert.equal(count, 1);
  await prisma.trainingEmailSchedule.update({ where: { recipientId: r.id }, data: { claimToken: 'dead-worker', claimedAt: now } });
  await emails.processNext({ now: later(emails.THREE_HOURS), send: async () => count++ });
  assert.equal(count, 2); assert.equal((await job(r)).claimToken, null);
});

test('inactive/test profiles and archived training never receive queued messages', async () => {
  const temp = await person('TRAVEL_AGENT'); const r = await assignment({ profileId: temp.id });
  await prisma.profile.update({ where: { id: temp.id }, data: { status: 'DISABLED' } });
  let count = 0; const send = async () => count++;
  await emails.processNext({ now, send }); assert.equal(count, 0); assert.equal((await job(r)).nextSendAt, null);
  await prisma.profile.update({ where: { id: temp.id }, data: { status: 'ACTIVE', testOwnerAdminId: admin.id } });
  const t = await assignment({ profileId: temp.id }); await emails.processNext({ now, send }); assert.equal((await job(t)).nextSendAt, null);
  const a = await assignment(); await prisma.trainingCourse.update({ where: { id: course.id }, data: { archivedAt: now } });
  await emails.processNext({ now, send }); assert.equal(count, 0); assert.equal((await job(a)).nextSendAt, null);
  await prisma.trainingCourse.update({ where: { id: course.id }, data: { archivedAt: null } });
});

test('email action respects role, organization, supervisor scope and course permissions', async () => {
  const r = await assignment({ actor: sup, enqueue: false });
  assert.equal((await post(learner, `/assignments/${r.assignmentId}/email`)).status, 403);
  assert.equal((await post(outsider, `/assignments/${r.assignmentId}/email`)).status, 404);
  assert.equal((await post(sup, `/assignments/${r.assignmentId}/email`)).status, 302); assert.ok(await job(r));
  await prisma.trainingEmailSchedule.deleteMany({ where: { recipientId: r.id } });
  await prisma.supervisorAssignment.updateMany({ where: { supervisorId: sup.id, agentId: learner.id }, data: { unassignedAt: now } });
  await post(sup, `/assignments/${r.assignmentId}/email`); assert.equal(await job(r), null);
  await prisma.supervisorAssignment.updateMany({ where: { supervisorId: sup.id, agentId: learner.id }, data: { unassignedAt: null } });
});

test('foreign employee IDs cannot create an assignment or queue email; invalid dates are rejected', async () => {
  const count = await prisma.trainingAssignment.count({ where: { organizationId: org.id } });
  const res = await post(admin, '/assignments', { courseId: course.id, scope: 'INDIVIDUAL', targetProfileIds: outsider.id });
  assert.equal(res.status, 403);
  assert.equal(await prisma.trainingAssignment.count({ where: { organizationId: org.id } }), count);
  assert.throws(() => trainingDeadline('2099-02-31'));
  assert.throws(() => trainingDeadline('2099-04-01', '25:00'));
  assert.equal(trainingDeadline('2099-04-01').toISOString(), '2099-04-01T18:59:00.000Z');
});

test('bulk and automatic assignment paths also queue emails in their transactions', async () => {
  const p = await person('FLIGHT_EXPERT');
  const bulk = await require('../lib/bulkAssign').bulkAssign(admin, [p.id], { kind: 'COURSE', employeeIds: [p.id], courseId: course.id, dueDate: '2099-04-01', dueTime: '16:15' });
  const r = await prisma.trainingAssignmentRecipient.findFirst({ where: { assignmentId: bulk.assignmentId }, include: { assignment: true } });
  assert.ok(await job(r)); assert.equal(r.assignment.dueDate.toISOString(), '2099-04-01T11:15:00.000Z');
  const p2 = await person('TRAVEL_AGENT');
  const auto = await require('../lib/automation').autoAssign({ organizationId: org.id, courseId: course.id, profileId: p2.id, assignedById: admin.id });
  const r2 = await prisma.trainingAssignmentRecipient.findFirst({ where: { assignmentId: auto.id } }); assert.ok(await job(r2));
});

test('failed assignment transactions leave no sendable email', async () => {
  const beforeCount = await prisma.trainingEmailSchedule.count();
  await assert.rejects(prisma.$transaction(async tx => { const r = await tx.trainingAssignmentRecipient.findFirst({ where: { assignment: { organizationId: org.id } } }); await emails.enqueueAssignment(tx, r.id, now); throw new Error('rollback'); }));
  assert.equal(await prisma.trainingEmailSchedule.count(), beforeCount);
});

test('manual send preserves pending retries and permits a later resend', async () => {
  const r = await assignment(); const sent = [];
  await emails.processNext({ now, send: async (m, o) => { sent.push({ m, o }); throw new Error('timeout'); } });
  const pending = await job(r);
  await emails.queueAgain([r.id], later(1000));
  assert.equal((await job(r)).sequence, pending.sequence);
  assert.equal((await job(r)).payloadJson, pending.payloadJson);
  await emails.processNext({ now: pending.nextSendAt, send: async (m, o) => sent.push({ m, o }) });
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(await emails.queueAgain([r.id], later(31000)), 0);
  assert.equal(await emails.queueAgain([r.id], later(100000)), 1);
  await emails.processNext({ now: later(100000), send: async (m, o) => sent.push({ m, o }) });
  assert.notEqual(sent[1].o.idempotencyKey, sent[2].o.idempotencyKey);
});

test('extending or removing a deadline postpones or cancels overdue reminders', async () => {
  const r = await assignment(); let count = 0; const send = async () => count++;
  await emails.processNext({ now, send });
  await prisma.trainingAssignment.update({ where: { id: r.assignmentId }, data: { dueDate: later(6 * 3600000) } });
  await emails.processNext({ now: later(emails.THREE_HOURS), send });
  assert.equal(count, 1); assert.equal((await job(r)).nextSendAt.getTime(), later(9 * 3600000).getTime());
  await prisma.trainingAssignment.update({ where: { id: r.assignmentId }, data: { dueDate: null } });
  await emails.processNext({ now: later(9 * 3600000), send });
  assert.equal(count, 1); assert.equal((await job(r)).nextSendAt, null);
});

test('onboarding queues mail once and role assignments skip disabled employees', async () => {
  const p = await person('FLIGHT_EXPERT');
  const onboard = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Email onboarding', status: 'PUBLISHED', createdById: admin.id, onboardingForNewHires: true, roleKey: 'FLIGHT_EXPERT' } });
  const { applyOnboarding } = require('../lib/onboarding');
  await applyOnboarding(p, { actorId: admin.id });
  const r = await prisma.trainingAssignmentRecipient.findFirst({ where: { profileId: p.id, assignment: { courseId: onboard.id } } });
  assert.ok(await job(r)); assert.equal((await applyOnboarding(p, { actorId: admin.id })).length, 0);
  const disabled = await person('FLIGHT_EXPERT');
  await prisma.profile.update({ where: { id: disabled.id }, data: { status: 'DISABLED' } });
  const response = await post(admin, '/assignments', { courseId: course.id, scope: 'ROLE', targetRole: 'FLIGHT_EXPERT' });
  assert.equal(response.status, 302);
  assert.equal(await prisma.trainingAssignmentRecipient.count({ where: { profileId: disabled.id } }), 0);
});
