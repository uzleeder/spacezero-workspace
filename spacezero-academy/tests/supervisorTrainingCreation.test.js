'use strict';
// Supervisor Training Creation: an Admin-grantable Supervisor may prepare a full AI Practice draft
// (create, analyze, build, review) but never approve/publish it themselves. They submit it for
// Admin approval instead; the Admin either requests changes (with a note, sent back to the same
// draft) or approves & sends it to Training (the existing, already-idempotent sendToTraining()).
// Gemini is never called here — the analysis/practice package is constructed directly via Prisma,
// exactly like tests/finalPhase1.test.js does, since none of the code under test cares HOW a
// component became APPROVED, only THAT it is.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { hashPassword } = require('../lib/password');
const app = require('../server');

let org, admin, supA, supB, agentA, agentB, cookies = {};
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);
const denied = (res) => [403, 404].includes(res.status);

async function makeUser(role, name) {
  const passwordHash = await hashPassword('Correct-Horse-9!');
  const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `STC ${name}`, username: `stc_${org.id}_${name}`, email: `stc_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', passwordHash, employmentStartDate: new Date() } });
  const token = generateToken();
  await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
  cookies[p.id] = `sz_session=${token.raw}`;
  return p;
}

/** A course whose package is fully ready to submit/send — mirrors what the real AI Practice pipeline produces. */
async function readyCourse(createdBy) {
  const course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: `STC course ${course_seq++}`, createdById: createdBy.id, origin: 'AI_PRACTICE', status: 'DRAFT' } });
  await prisma.trainingModule.create({ data: { courseId: course.id, title: 'Source', contentType: 'NOTE', description: 'x' } });
  await prisma.trainingAnalysis.create({ data: { courseId: course.id, status: 'APPROVED', criticalKnowledgeJson: '[]', practicalBehaviorsJson: '[]', commonMistakesJson: '[]', extractedSkillsJson: '["Discovery"]' } });
  await prisma.assessment.create({ data: { organizationId: org.id, courseId: course.id, createdVia: 'AI_TRAINING_ANALYSIS', type: 'ROLEPLAY', title: 'Role-play', level: 3, passingScore: 70, status: 'APPROVED', createdById: createdBy.id, configJson: JSON.stringify({ customerPersonality: 'busy', scenarioBrief: 'b', openingLine: 'o', rubricSkills: ['Discovery'] }) } });
  return prisma.trainingCourse.findUnique({ where: { id: course.id } });
}
let course_seq = 0;

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Supervisor Training Creation tests' } });
  admin = await makeUser('ADMIN', 'admin');
  supA = await makeUser('SUPERVISOR', 'supA'); supB = await makeUser('SUPERVISOR', 'supB');
  agentA = await makeUser('TRAVEL_AGENT', 'agentA'); agentB = await makeUser('TRAVEL_AGENT', 'agentB');
  await prisma.supervisorAssignment.create({ data: { supervisorId: supA.id, agentId: agentA.id, assignedById: admin.id } });
  await prisma.supervisorAssignment.create({ data: { supervisorId: supB.id, agentId: agentB.id, assignedById: admin.id } });
  // supA gets every Supervisor Training Creation capability; supB gets none — the default-deny baseline.
  await post(admin, '/admin/supervisor-permissions/' + supA.id, { capabilities: ['training.create', 'training.revise', 'training.assign', 'training.viewHistory'] });
});
after(async () => { await prisma.$disconnect(); });

test('CAPABILITY REQUIRED: a Supervisor without training.create cannot reach AI Practice at all', async () => {
  assert.ok(denied(await get(supB, '/ai-practice')));
  assert.ok(denied(await get(supB, '/ai-practice/new')));
  assert.ok(denied(await post(supB, '/ai-practice/new', { kind: 'material', noteText: 'x' })));
  assert.ok(denied(await get(agentA, '/ai-practice/new'))); // a plain employee, regardless of capability, is never eligible
});

test('AUTHORIZED SUPERVISOR: can create material, and it is scoped to only what they created', async () => {
  const res = await post(supA, '/ai-practice/new', { kind: 'material', title: 'STC upload', noteText: 'Some notes about the process.' });
  assert.equal(res.status, 302);
  const course = await prisma.trainingCourse.findFirst({ where: { organizationId: org.id, title: 'STC upload' } });
  assert.equal(course.createdById, supA.id);
  assert.equal(course.origin, 'AI_PRACTICE');
  // supA sees it; supB (a different, ungranted supervisor) cannot reach it by ID
  assert.equal((await get(supA, `/ai-practice/${course.id}`)).status, 200);
  assert.ok(denied(await get(supB, `/ai-practice/${course.id}`)));
  // it never appears in another supervisor's AI Practice home, even if they were granted the capability generally
  await post(admin, '/admin/supervisor-permissions/' + supB.id, { capabilities: ['training.create'] });
  assert.doesNotMatch((await get(supB, '/ai-practice')).text, /STC upload/);
  await post(admin, '/admin/supervisor-permissions/' + supB.id, { capabilities: [] }); // back to nothing, for later tests
});

test('PREPARE: a Supervisor may approve their own practice package (not the same as publishing) but never send it to Training', async () => {
  const course = await readyCourse(supA);
  const approve = await post(supA, `/ai-practice/${course.id}/approve`);
  assert.equal(approve.status, 302);
  assert.equal((await prisma.assessment.findFirst({ where: { courseId: course.id } })).status, 'APPROVED');
  // "may NOT approve/publish their own Training" — Send to Training is Admin-only, even for the owner
  assert.ok(denied(await get(supA, `/ai-practice/${course.id}/send`)));
  assert.ok(denied(await post(supA, `/ai-practice/${course.id}/send`, { title: course.title, passingScore: '70' })));
  assert.equal((await prisma.trainingCourse.findUnique({ where: { id: course.id } })).status, 'DRAFT');
  // the UI itself must never dangle a clickable "Send to Training" action in front of a Supervisor —
  // not just the route being blocked. Regression check: this was initially missed (courseState() is
  // shared with the Admin home list and had no role awareness) and only caught by live-browser testing.
  const sourceStep = await get(supA, `/ai-practice/${course.id}?step=source`);
  assert.doesNotMatch(sourceStep.text, /href="\/ai-practice\/[^"]+\/send"/);
  const home = await get(supA, '/ai-practice');
  assert.doesNotMatch(home.text, /href="\/ai-practice\/[^"]+\/send"/);
});

test('SUBMIT FOR APPROVAL: hands the draft to the Admin; the Supervisor cannot approve their own submission', async () => {
  const course = await readyCourse(supA);
  await post(supA, `/ai-practice/${course.id}/approve`);
  const res = await post(supA, `/ai-practice/${course.id}/submit-for-approval`);
  assert.equal(res.status, 302);
  const stored = await prisma.trainingCourse.findUnique({ where: { id: course.id } });
  assert.equal(stored.reviewStatus, 'SUBMITTED');
  assert.equal(stored.submittedById, supA.id);
  assert.ok(stored.submittedAt);
  assert.ok(await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'training.submitted_for_approval', targetId: course.id } }));

  // idempotent: submitting again changes nothing
  const before1 = stored.submittedAt;
  await post(supA, `/ai-practice/${course.id}/submit-for-approval`);
  assert.deepEqual((await prisma.trainingCourse.findUnique({ where: { id: course.id } })).submittedAt, before1);

  // still cannot self-approve/publish, even now that it is submitted
  assert.ok(denied(await post(supA, `/ai-practice/${course.id}/send`, { title: 'x', passingScore: '70' })));
});

test('ADMIN SEES THE SUBMISSION and it counts toward Needs Your Attention', async () => {
  const course = await readyCourse(supA);
  await post(supA, `/ai-practice/${course.id}/approve`);
  await post(supA, `/ai-practice/${course.id}/submit-for-approval`);

  const list = await get(admin, '/ai-practice?tab=approval');
  assert.equal(list.status, 200);
  assert.match(list.text, new RegExp(course.title));

  const dash = await get(admin, '/dashboard');
  assert.match(dash.text, /Training awaiting approval/);
});

test('ADMIN REQUESTS CHANGES: requires a note, reaches the Supervisor, and the draft can be revised and resubmitted', async () => {
  const course = await readyCourse(supA);
  await post(supA, `/ai-practice/${course.id}/approve`);
  await post(supA, `/ai-practice/${course.id}/submit-for-approval`);

  // a note is required
  const noNote = await post(admin, `/ai-practice/${course.id}/review/request-changes`, {});
  assert.equal(noNote.status, 302); // re-rendered via redirect with an error, not a hard failure
  assert.equal((await prisma.trainingCourse.findUnique({ where: { id: course.id } })).reviewStatus, 'SUBMITTED');

  const withNote = await post(admin, `/ai-practice/${course.id}/review/request-changes`, { note: 'Tighten the opening line.' });
  assert.equal(withNote.status, 302);
  const stored = await prisma.trainingCourse.findUnique({ where: { id: course.id } });
  assert.equal(stored.reviewStatus, 'CHANGES_REQUESTED');
  assert.equal(stored.reviewNote, 'Tighten the opening line.');
  const notif = await prisma.notification.findFirst({ where: { profileId: supA.id, type: 'training.changes_requested' } });
  assert.ok(notif);
  assert.match(notif.body, /Tighten the opening line\./);

  // a Supervisor cannot request changes on their own (or anyone's) submission — Admin only
  assert.ok(denied(await post(supA, `/ai-practice/${course.id}/review/request-changes`, { note: 'x' })));

  // the Supervisor can resubmit the same draft (nothing was discarded) and it goes back to SUBMITTED
  const resubmit = await post(supA, `/ai-practice/${course.id}/submit-for-approval`);
  assert.equal(resubmit.status, 302);
  assert.equal((await prisma.trainingCourse.findUnique({ where: { id: course.id } })).reviewStatus, 'SUBMITTED');
});

test('APPROVE & SEND TO TRAINING: Admin-only, idempotent, creates exactly one Training, and clears the review state', async () => {
  const course = await readyCourse(supA);
  await post(supA, `/ai-practice/${course.id}/approve`);
  await post(supA, `/ai-practice/${course.id}/submit-for-approval`);

  const first = await post(admin, `/ai-practice/${course.id}/send`, { title: course.title, passingScore: '70' });
  assert.equal(first.status, 302);
  const published = await prisma.trainingCourse.findUnique({ where: { id: course.id } });
  assert.equal(published.status, 'PUBLISHED');
  assert.equal(published.publishedVersion, 1);
  assert.equal(published.sentById, admin.id);
  assert.equal(published.reviewStatus, 'NONE'); // publishing clears any pending review state
  const versionCountAfterFirst = await prisma.trainingVersion.count({ where: { courseId: course.id, status: 'PUBLISHED' } });
  assert.equal(versionCountAfterFirst, 1);

  // a second click (double submit) must not create a duplicate Training / version
  const second = await post(admin, `/ai-practice/${course.id}/send`, { title: course.title, passingScore: '70' });
  assert.equal(second.status, 302);
  assert.equal(await prisma.trainingVersion.count({ where: { courseId: course.id, status: 'PUBLISHED' } }), 1);
  assert.equal(await prisma.trainingCourse.count({ where: { organizationId: org.id, title: course.title } }), 1);
});

test('REVISE: training.revise (not training.create alone) is required to propose a new version of a published course', async () => {
  const course = await readyCourse(supA);
  await post(supA, `/ai-practice/${course.id}/approve`);
  await post(admin, `/ai-practice/${course.id}/send`, { title: course.title, passingScore: '70' });

  // supB with ONLY training.create (no training.revise) — and not even the owner — is denied
  await post(admin, '/admin/supervisor-permissions/' + supB.id, { capabilities: ['training.create'] });
  assert.ok(denied(await post(supB, `/ai-practice/${course.id}/new-version`)));
  await post(admin, '/admin/supervisor-permissions/' + supB.id, { capabilities: [] });

  // supA (the owner) has training.revise and may propose a new version; the published version is untouched
  const res = await post(supA, `/ai-practice/${course.id}/new-version`);
  assert.equal(res.status, 302);
  const after1 = await prisma.trainingCourse.findUnique({ where: { id: course.id } });
  assert.equal(after1.draftVersion, 2);
  assert.equal(after1.publishedVersion, 1); // still serving whoever has it
});

test('ASSIGN: training.assign is required, independent of the setup/create/revise capabilities', async () => {
  const course = await readyCourse(admin);
  await post(admin, `/ai-practice/${course.id}/send`, { title: course.title, passingScore: '70' });
  await post(admin, `/admin/training/${course.id}/assign-permissions`, { assignPolicy: 'ALL_SUPERVISORS' });

  // supB has none of the training capabilities at this point in the file
  assert.ok(denied(await get(supB, '/assignments')));
  assert.ok(denied(await post(supB, '/assignments', { courseId: course.id, scope: 'INDIVIDUAL', targetProfileIds: [agentB.id] })));

  // supA has training.assign and may assign to their OWN team only
  const own = await post(supA, '/assignments', { courseId: course.id, scope: 'INDIVIDUAL', targetProfileIds: [agentA.id] });
  assert.equal(own.status, 302);
  assert.equal(await prisma.trainingAssignment.count({ where: { courseId: course.id, assignedById: supA.id } }), 1);
  // agentB is outside supA's scope — lib/objectAccess.js's global canViewProfile check rejects it
  // before the route handler's own "own team" message would ever run.
  const other = await post(supA, '/assignments', { courseId: course.id, scope: 'INDIVIDUAL', targetProfileIds: [agentB.id] });
  assert.equal(other.status, 403);
  assert.equal(await prisma.trainingAssignment.count({ where: { courseId: course.id, assignedById: supA.id } }), 1); // unchanged
});

test('VIEW HISTORY: training.viewHistory gates the training-history section and the retake action', async () => {
  // supB lacks training.viewHistory
  const supBPage = await get(supB, `/team/${agentB.id}`);
  assert.equal(supBPage.status, 200);
  assert.doesNotMatch(supBPage.text, /Training History/);

  // supA has it
  const supAPage = await get(supA, `/team/${agentA.id}`);
  assert.equal(supAPage.status, 200);
  assert.match(supAPage.text, /Training History/);

  // the capability check runs before the recipient is even looked up, so a made-up id still proves the gate
  assert.ok(denied(await post(supB, '/training/does-not-exist/retake')));
});
