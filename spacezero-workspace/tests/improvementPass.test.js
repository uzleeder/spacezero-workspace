'use strict';
// Improvement pass: employee readiness, setup owner/due date, "Needs your attention", role-based onboarding,
// human-readable activity, versioned training material, AI Practice clean-up (Continue / Retry / Remove),
// and release packaging. Gemini is never called.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

mock.method(require('../lib/gemini'), 'generateStructured', async () => { throw new Error('Gemini must not be called in these tests'); });

const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { hashPassword } = require('../lib/password');
const { readinessFor, decide } = require('../lib/readiness');
const { loadSetupForProfiles, computeSetup } = require('../lib/employeeSetup');
const { attentionFor } = require('../lib/attention');
const { applyOnboarding } = require('../lib/onboarding');
const { runAutomation } = require('../lib/automation');
const { employeeTimeline } = require('../lib/timeline');
const versions = require('../lib/courseVersions');
const state = require('../lib/aiPracticeState');
const pack = require('../scripts/package-release.cjs');
const app = require('../server');

const DAY = 86400000;
const FAKE_KEY = ['AIza', 'SyA1234567890abcdefghijklmnopqrstuv12'].join(''); // built at runtime so this file itself holds no key-shaped text
let org, other, cookies = {};
let admin, sup, supB, agent, agentB, expert, invited, foreignAdmin, team;
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);
const blocked = (res) => res.status !== 200 && res.status < 500;

async function makeUser(role, name, { organizationId = org.id, status = 'ACTIVE', startDaysAgo = 200 } = {}) {
  const passwordHash = await hashPassword('Correct-Horse-9!');
  const p = await prisma.profile.create({ data: { organizationId, fullName: `IP ${name}`, username: `ip_${organizationId}_${name}`, email: `ip_${organizationId}_${name}@example.invalid`, role, status, passwordHash, employmentStartDate: new Date(Date.now() - startDaysAgo * DAY) } });
  const token = generateToken();
  await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
  cookies[p.id] = `sz_session=${token.raw}`;
  return p;
}
async function course(title, extra = {}) {
  return prisma.trainingCourse.create({ data: { organizationId: org.id, title, status: 'PUBLISHED', publishedVersion: 1, createdById: admin.id, mandatory: true, assignPolicy: 'ALL_SUPERVISORS', ...extra } });
}
async function assign(c, profile, { dueDate = null, attempt = { status: 'NOT_STARTED' }, version = 1 } = {}) {
  const a = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: c.id, courseVersion: version, assignedById: admin.id, scope: 'INDIVIDUAL', dueDate } });
  const r = await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: a.id, profileId: profile_id(profile) } });
  const t = await prisma.trainingAttempt.create({ data: { recipientId: r.id, profileId: profile_id(profile), attemptNumber: 1, ...attempt } });
  return { a, r, t };
}
const profile_id = (p) => p.id;

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Improvement pass' } });
  other = await prisma.organization.create({ data: { name: 'Improvement other' } });
  admin = await makeUser('ADMIN', 'admin'); sup = await makeUser('SUPERVISOR', 'sup'); supB = await makeUser('SUPERVISOR', 'supB');
  agent = await makeUser('TRAVEL_AGENT', 'agent'); agentB = await makeUser('TRAVEL_AGENT', 'agentB'); expert = await makeUser('FLIGHT_EXPERT', 'expert');
  invited = await makeUser('TRAVEL_AGENT', 'invited', { status: 'INVITED', startDaysAgo: 1 });
  foreignAdmin = await makeUser('ADMIN', 'foreignAdmin', { organizationId: other.id });
  team = await prisma.team.create({ data: { organizationId: org.id, name: 'IP Team' } });
  for (const m of [sup, agent, expert]) await prisma.teamMembership.create({ data: { teamId: team.id, profileId: m.id } });
  for (const a of [agent, expert]) await prisma.supervisorAssignment.create({ data: { supervisorId: sup.id, agentId: a.id, teamId: team.id, assignedById: admin.id } });
  await prisma.supervisorAssignment.create({ data: { supervisorId: supB.id, agentId: agentB.id, assignedById: admin.id } });
  // one setup requirement of our own, so the default checklist is not seeded: owner = supervisor, due 5 days after the start
  await prisma.setupRequirement.create({ data: { organizationId: org.id, key: 'cockpit', label: 'Cockpit', category: 'System Access', kind: 'MANUAL', verification: 'MANAGEMENT_VERIFICATION', ownerRole: 'SUPERVISOR', dueDays: 5, required: true } });
});
after(async () => { mock.restoreAll(); await prisma.$disconnect(); });

// ================================================================== 4. setup owner + due date
test('SETUP RESPONSIBILITY: a requirement can have an owner and a due date; rows show "Owner: Supervisor (name) / Due: date" and overdue is computed', async () => {
  const req = await prisma.setupRequirement.findFirst({ where: { organizationId: org.id, key: 'cockpit' } });
  const setups = await loadSetupForProfiles(org.id, [agent, invited]);
  const row = setups.get(agent.id).rows[0];
  assert.equal(row.ownerLabel, `Supervisor (${sup.fullName})`);
  assert.equal(row.dueAt.getTime(), agent.employmentStartDate.getTime() + 5 * DAY);
  assert.equal(row.overdue, true); assert.equal(setups.get(agent.id).overdueCount, 1);
  assert.equal(setups.get(invited.id).overdueCount, 0, 'someone who has not activated yet cannot be overdue');
  // a fixed date wins over "N days after start", and a future date is not overdue
  const fixed = computeSetup({ profile: agent, requirements: [{ ...req, dueDate: new Date(Date.now() + 3 * DAY) }], items: [], vaultSystemKeys: [], hasAddress: false });
  assert.equal(fixed.rows[0].overdue, false);
  // the page shows it
  const page = await get(admin, `/employees/${agent.id}/setup`);
  assert.equal(page.status, 200); assert.match(page.text, /Owner: Supervisor \(IP sup\)/); assert.match(page.text, /Due: /); assert.match(page.text, /overdue/);
  // the admin form saves it, validates it and audits the change
  const form = await get(admin, `/admin/setup-requirements/${req.id}/edit`);
  assert.match(form.text, /name="ownerRole"/); assert.match(form.text, /name="dueDays"/); assert.match(form.text, /name="dueDate"/);
  const bad = await post(admin, `/admin/setup-requirements/${req.id}`, { label: 'Cockpit', category: 'System Access', audience: 'ALL_EMPLOYEES', required: 'required', verification: 'MANAGEMENT_VERIFICATION', ownerRole: 'ADMIN', dueDate: 'soon' });
  assert.notEqual(bad.status, 302); assert.equal((await prisma.setupRequirement.findUnique({ where: { id: req.id } })).ownerRole, 'SUPERVISOR');
  const ok = await post(admin, `/admin/setup-requirements/${req.id}`, { label: 'Cockpit', category: 'System Access', audience: 'ALL_EMPLOYEES', required: 'required', verification: 'MANAGEMENT_VERIFICATION', ownerRole: 'ADMIN', dueDays: '7' });
  assert.equal(ok.status, 302);
  const saved = await prisma.setupRequirement.findUnique({ where: { id: req.id } });
  assert.equal(saved.ownerRole, 'ADMIN'); assert.equal(saved.dueDays, 7);
  assert.ok(await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'setup.requirement_updated' } }));
  assert.ok(blocked(await post(sup, `/admin/setup-requirements/${req.id}`, { label: 'X', ownerRole: 'ADMIN' })));
  await prisma.setupRequirement.update({ where: { id: req.id }, data: { ownerRole: 'SUPERVISOR', dueDays: 5 } }); // back for the next tests
});

// ================================================================== 3. readiness
test('READINESS: one simple status — Not Activated / Setup Required / Training Required / Needs Attention / Ready (no score)', async () => {
  const now = new Date();
  const base = { required: 1, completed: 0, overdueCount: 0, hasIssue: false, fullySetUp: false };
  const t = (l) => ({ course: { mandatory: true }, status: 'NOT_STARTED', overdue: false, retake: false, ...l });
  assert.equal(decide({ profile: { status: 'INVITED' }, setup: base, learning: [] }).key, 'NOT_ACTIVATED');
  assert.equal(decide({ profile: { status: 'ACTIVE' }, setup: base, learning: [] }).key, 'SETUP_REQUIRED');
  assert.equal(decide({ profile: { status: 'ACTIVE' }, setup: { ...base, fullySetUp: true, completed: 1 }, learning: [t()] }).key, 'TRAINING_REQUIRED');
  assert.equal(decide({ profile: { status: 'ACTIVE' }, setup: { ...base, fullySetUp: true, completed: 1 }, learning: [t({ course: { mandatory: false } })] }).key, 'READY', 'optional training does not block');
  assert.equal(decide({ profile: { status: 'ACTIVE' }, setup: { ...base, fullySetUp: true }, learning: [t({ status: 'COMPLETED' })] }).key, 'READY');
  assert.equal(decide({ profile: { status: 'ACTIVE' }, setup: { ...base, overdueCount: 1 }, learning: [] }).key, 'NEEDS_ATTENTION');
  assert.equal(decide({ profile: { status: 'ACTIVE' }, setup: { ...base, fullySetUp: true }, learning: [t({ overdue: true })] }).key, 'NEEDS_ATTENTION');
  assert.equal(decide({ profile: { status: 'ACTIVE' }, setup: { ...base, fullySetUp: true }, learning: [t({ retake: true, status: 'RETAKE_REQUIRED' })] }).key, 'NEEDS_ATTENTION');
  assert.equal(decide({ profile: { status: 'DISABLED' }, setup: base, learning: [] }), null);

  // end to end with real records
  const req = await prisma.setupRequirement.findFirst({ where: { organizationId: org.id, key: 'cockpit' } });
  const fresh = await makeUser('TRAVEL_AGENT', 'fresh', { startDaysAgo: 1 }); // due in 4 days: not overdue yet
  let map = await readinessFor(org.id, [invited, fresh]);
  assert.equal(map.get(invited.id).key, 'NOT_ACTIVATED'); assert.equal(map.get(fresh.id).key, 'SETUP_REQUIRED');
  await prisma.employeeSetupItem.create({ data: { profileId: fresh.id, requirementId: req.id, status: 'COMPLETED', verifiedById: admin.id, verifiedAt: now } });
  // Passport Details is a second mandatory (derived) requirement in every org — complete it too so
  // "cockpit" alone still brings this org's whole 2-item checklist to Fully Set Up, as intended.
  // computeSetup reads passport fields straight off the profile object passed to it (no re-fetch),
  // so the in-memory `fresh` used below must be updated too, not just the database row.
  await prisma.profile.update({ where: { id: fresh.id }, data: { passportNumberEnc: 'v1.fake.fake.fake', passportExpiresAt: new Date('2035-01-01T00:00:00.000Z') } });
  fresh.passportNumberEnc = 'v1.fake.fake.fake';
  fresh.passportExpiresAt = new Date('2035-01-01T00:00:00.000Z');
  const mand = await course('IP mandatory');
  const { t: attempt } = await assign(mand, fresh, { dueDate: new Date(Date.now() + 7 * DAY) });
  map = await readinessFor(org.id, [fresh]);
  assert.equal(map.get(fresh.id).key, 'TRAINING_REQUIRED'); assert.match(map.get(fresh.id).reasons[0], /1 mandatory training/);
  await prisma.trainingAttempt.update({ where: { id: attempt.id }, data: { status: 'COMPLETED', score: 90, completedAt: now } });
  assert.equal((await readinessFor(org.id, [fresh])).get(fresh.id).key, 'READY');
  await prisma.trainingAssignment.updateMany({ where: { recipients: { some: { profileId: fresh.id } } }, data: { dueDate: new Date(Date.now() - DAY) } });
  await prisma.trainingAttempt.update({ where: { id: attempt.id }, data: { status: 'RETAKE_REQUIRED' } });
  assert.equal((await readinessFor(org.id, [fresh])).get(fresh.id).key, 'NEEDS_ATTENTION');
});

test('READINESS: shown on the employee lists (with a filter), the employee header and the employee dashboard — and only within scope', async () => {
  const list = await get(admin, '/admin/employees');
  assert.equal(list.status, 200); assert.match(list.text, /Not Activated/); assert.match(list.text, /Needs Attention/);
  const filtered = await get(admin, '/admin/employees?readiness=NOT_ACTIVATED');
  assert.match(filtered.text, /IP invited/); assert.doesNotMatch(filtered.text, /IP agentB/);
  const team1 = await get(sup, '/team?readiness=NEEDS_ATTENTION');
  assert.equal(team1.status, 200); assert.match(team1.text, /IP agent\b/); assert.doesNotMatch(team1.text, /IP agentB/); assert.doesNotMatch(team1.text, /IP invited/);
  const header = await get(admin, `/employees/${agent.id}/setup`);
  assert.match(header.text, /Status:/); assert.match(header.text, /Needs Attention/);
  const mine = await get(agent, '/dashboard');
  assert.equal(mine.status, 200); assert.match(mine.text, /My status/); assert.match(mine.text, /Needs Attention/);
  assert.ok(blocked(await get(agentB, `/employees/${agent.id}/setup`)));
});

// ================================================================== 5. needs your attention
test('NEEDS YOUR ATTENTION: admin sees the organization, a supervisor only their team, an employee only their own actions', async () => {
  const late = await course('IP late course');
  const { r: lateR } = await assign(late, agent, { dueDate: new Date(Date.now() - 2 * DAY) });
  const retakeCourse = await course('IP retake course');
  await assign(retakeCourse, expert, { attempt: { status: 'RETAKE_REQUIRED', score: 50, completedAt: new Date() } });
  await prisma.leaveRequest.create({ data: { organizationId: org.id, profileId: agent.id, teamId: team.id, supervisorId: sup.id, leaveType: 'VACATION', startDate: new Date(Date.now() + 10 * DAY), endDate: new Date(Date.now() + 12 * DAY), days: 3, status: 'PENDING' } });
  await prisma.leaveRequest.create({ data: { organizationId: org.id, profileId: agentB.id, leaveType: 'VACATION', startDate: new Date(Date.now() + 10 * DAY), endDate: new Date(Date.now() + 11 * DAY), days: 2, status: 'PENDING' } });
  const keys = (a) => Object.fromEntries(a.items.map((i) => [i.key, i.value]));
  const a = keys(await attentionFor(admin));
  assert.ok(a.setup >= 1); assert.ok(a.setupOverdue >= 1); assert.equal(a.activation, 1); assert.ok(a.trainingOverdue >= 1); assert.ok(a.retake >= 1); assert.equal(a.leave, 2); assert.equal(a.ai, undefined, 'nothing waiting in AI Practice yet');
  const s = keys(await attentionFor(sup));
  assert.equal(s.leave, 1, 'only the team\'s vacation request'); assert.equal(s.activation, undefined, 'the invited employee is not in this team');
  assert.ok(s.trainingOverdue >= 1); assert.equal(s.ai, undefined);
  const mineItems = keys(await attentionFor(agent));
  assert.equal(mineItems.myOverdue, 1); assert.ok(mineItems.mySetup >= 1); assert.equal(mineItems.leave, undefined);
  const bItems = keys(await attentionFor(agentB));
  assert.equal(bItems.myOverdue, undefined, 'another employee\'s overdue training is not mine');
  // AI Practice shows up for the Admin only
  const src = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'IP AI source', createdById: admin.id, origin: 'AI_PRACTICE', status: 'DRAFT' } });
  await prisma.trainingAnalysis.create({ data: { courseId: src.id, status: 'READY_FOR_REVIEW' } });
  assert.equal(keys(await attentionFor(admin)).ai, 1); assert.equal(keys(await attentionFor(sup)).ai, undefined);
  // dashboards render it with links
  const page = await get(admin, '/dashboard');
  assert.match(page.text, /Needs your attention/); assert.match(page.text, /Pending profile activation/); assert.match(page.text, /AI Practice ready for review/); assert.match(page.text, /Pending vacation requests/);
  assert.match((await get(sup, '/dashboard')).text, /Needs your attention/);
  assert.match((await get(agent, '/dashboard')).text, /Needs your attention/);
  assert.match((await get(agent, '/dashboard')).text, /Training overdue/);
  void lateR;
});

// ================================================================== 6. role-based onboarding
test('ROLE-BASED ONBOARDING: a new employee gets the setup and the onboarding training of their ROLE — nothing configured per person; role change adds more; never duplicated', async () => {
  await course('IP onboarding — agents', { roleKey: 'TRAVEL_AGENT', onboardingForNewHires: true });
  const expertCourse = await course('IP onboarding — experts', { roleKey: 'FLIGHT_EXPERT', onboardingForNewHires: true });
  await course('IP onboarding — everyone', { onboardingForNewHires: true });
  const notFlagged = await course('IP not onboarding');
  const draft = await course('IP draft onboarding', { status: 'DRAFT', publishedVersion: 0, onboardingForNewHires: true });
  const start = new Date().toISOString().slice(0, 10);
  const res = await post(admin, '/admin/employees/new', { fullName: 'IP Newcomer', username: 'ip_newcomer', email: 'ip_newcomer@example.invalid', role: 'TRAVEL_AGENT', employmentStartDate: start });
  assert.ok([302, 503].includes(res.status), `status ${res.status}`); // 503 = the invitation e-mail could not be sent in tests; the employee is still created
  const newcomer = await prisma.profile.findFirst({ where: { organizationId: org.id, username: 'ip_newcomer' } });
  assert.ok(newcomer); assert.equal(newcomer.status, 'INVITED');
  const got = async (p) => (await prisma.trainingAssignmentRecipient.findMany({ where: { profileId: p.id }, include: { assignment: { include: { course: true } } } }));
  let assigned = await got(newcomer);
  assert.deepEqual(assigned.map((r) => r.assignment.course.title).sort(), ['IP onboarding — agents', 'IP onboarding — everyone']);
  assert.ok(!assigned.some((r) => [notFlagged.id, draft.id, expertCourse.id].includes(r.assignment.courseId)), 'only flagged, published, role-matching training');
  const dueDays = Math.round((assigned[0].assignment.dueDate - newcomer.employmentStartDate) / DAY);
  assert.equal(dueDays, 14);
  assert.ok(assigned.every((r) => r.assignment.courseVersion === 1));
  assert.deepEqual(await applyOnboarding(newcomer), [], 'running it again assigns nothing new');
  assert.equal((await got(newcomer)).length, 2);
  // the setup checklist follows the role automatically too: the employee sees the requirement without any per-person set-up
  // (2 rows: this org's own "cockpit" requirement plus the always-present Passport Details requirement)
  assert.equal((await loadSetupForProfiles(org.id, [newcomer])).get(newcomer.id).rows.length, 2);
  // role change brings the new role's onboarding
  const change = await post(admin, `/admin/employees/${newcomer.id}`, { fullName: newcomer.fullName, role: 'FLIGHT_EXPERT', employmentStartDate: start });
  assert.equal(change.status, 302);
  assigned = await got(newcomer);
  assert.ok(assigned.some((r) => r.assignment.courseId === expertCourse.id));
  // the daily automation is a safety net and is idempotent
  const first = await runAutomation(org.id); const before = (await got(newcomer)).length; await runAutomation(org.id);
  assert.equal((await got(newcomer)).length, before); assert.equal(typeof first.onboarding, 'number');
  assert.ok(await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'onboarding.training_assigned' } }));
  assert.equal(await prisma.notification.count({ where: { profileId: newcomer.id, type: 'training.assigned' } }), before);
  // the Admin controls it from the training itself
  const flag = await post(admin, `/admin/training/${notFlagged.id}/edit`, { title: notFlagged.title, passingScore: '70', mandatory: '1', onboardingForm: '1', onboarding: '1' });
  assert.equal(flag.status, 302); assert.equal((await prisma.trainingCourse.findUnique({ where: { id: notFlagged.id } })).onboardingForNewHires, true);
  assert.match((await get(admin, `/admin/training/${notFlagged.id}`)).text, /Assign automatically to new employees/);
  await post(admin, `/admin/training/${notFlagged.id}/edit`, { title: notFlagged.title, passingScore: '70', mandatory: '1', onboardingForm: '1' });
  assert.equal((await prisma.trainingCourse.findUnique({ where: { id: notFlagged.id } })).onboardingForNewHires, false);
  assert.ok(blocked(await post(sup, `/admin/training/${notFlagged.id}/edit`, { title: 'x', onboardingForm: '1', onboarding: '1' })));
});

// ================================================================== 7. activity timeline
test('ACTIVITY: a readable timeline (activated, verified by, assigned, completed — 87%, retake, skill evidence, vacation) — separate from the raw security audit log', async () => {
  const person = await makeUser('TRAVEL_AGENT', 'journey', { startDaysAgo: 30 });
  const enzo = await makeUser('SUPERVISOR', 'Enzo');
  await prisma.supervisorAssignment.create({ data: { supervisorId: sup.id, agentId: person.id, assignedById: admin.id } });
  const gds = await prisma.setupRequirement.create({ data: { organizationId: org.id, key: 'gds', label: 'GDS', kind: 'MANUAL', required: false } });
  await prisma.invitation.create({ data: { profileId: person.id, tokenHash: `hash-${person.id}`, invitedById: admin.id, expiresAt: new Date(Date.now() + DAY), status: 'ACCEPTED', acceptedAt: new Date(Date.now() - 20 * DAY) } });
  await prisma.employeeSetupItem.create({ data: { profileId: person.id, requirementId: gds.id, status: 'COMPLETED', verifiedById: enzo.id, verifiedAt: new Date(Date.now() - 18 * DAY) } });
  const c = await course('IP timeline course');
  const { t } = await assign(c, person, { dueDate: new Date(Date.now() + 5 * DAY) });
  await prisma.trainingAttempt.update({ where: { id: t.id }, data: { status: 'COMPLETED', score: 87, completedAt: new Date(Date.now() - 10 * DAY) } });
  const c2 = await course('IP second course');
  await assign(c2, person, { attempt: { status: 'RETAKE_REQUIRED', score: 55, completedAt: new Date(Date.now() - 5 * DAY) } });
  const skill = await prisma.skill.create({ data: { organizationId: org.id, name: 'IP Closing', roleKey: 'TRAVEL_AGENT' } });
  const es = await prisma.employeeSkill.create({ data: { profileId: person.id, skillId: skill.id } });
  await prisma.skillEvidence.create({ data: { employeeSkillId: es.id, sourceType: 'ASSESSMENT', assessmentType: 'QUIZ', scoreImpact: 72, createdAt: new Date(Date.now() - 4 * DAY) } });
  await prisma.leaveRequest.create({ data: { organizationId: org.id, profileId: person.id, leaveType: 'VACATION', startDate: new Date(Date.now() + 20 * DAY), endDate: new Date(Date.now() + 22 * DAY), days: 3, status: 'APPROVED', reviewedAt: new Date(Date.now() - 2 * DAY), reviewedById: admin.id } });
  await prisma.auditLog.create({ data: { organizationId: org.id, actorId: person.id, action: 'auth.login', targetTable: 'Profile', targetId: person.id } });
  await prisma.auditLog.create({ data: { organizationId: org.id, actorId: admin.id, action: 'credential.viewed', targetTable: 'Credential', targetId: person.id } });

  const events = await employeeTimeline(person);
  const text = events.map((e) => e.text);
  for (const expected of ['Profile created', 'Profile activated', 'GDS verified by IP Enzo', 'Training assigned: IP timeline course', 'Training completed — IP timeline course — 87%', 'Retake required — IP second course (scored 55%)', 'Skill evidence added — IP Closing (72% from assessment)', 'Vacation approved']) assert.ok(text.includes(expected), `missing "${expected}" in ${JSON.stringify(text)}`);
  assert.ok(events.every((e, i) => i === 0 || new Date(events[i - 1].at) >= new Date(e.at)), 'newest first');
  const page = await get(admin, `/employees/${person.id}/activity`);
  assert.equal(page.status, 200);
  for (const words of ['Profile activated', 'GDS verified by IP Enzo', 'Training completed', '87%', 'Retake required', 'Vacation approved']) assert.match(page.text, new RegExp(words));
  assert.doesNotMatch(page.text, /auth\.login|auth login|credential viewed|credential\.viewed/);  // raw security events stay in the audit log
  assert.match(page.text, /Security &amp; Audit log/);
  assert.equal((await get(sup, `/employees/${person.id}/activity`)).status, 200);      // their supervisor
  assert.equal((await get(person, `/employees/${person.id}/activity`)).status, 200);   // themselves
  for (const who of [agentB, supB, foreignAdmin]) assert.ok(blocked(await get(who, `/employees/${person.id}/activity`)), `${who.fullName} must not see it`);
  assert.doesNotMatch((await get(person, `/employees/${person.id}/activity`)).text, /Security &amp; Audit log/, 'the audit link is Admin-only');
});

// ================================================================== 2. versioned training material
test('TRAINING VERSIONING: changing the material of a sent training creates a new version; v1 learners keep v1 material; the material cannot be edited in place', async () => {
  const c = await course('IP versioned', { origin: 'AI_PRACTICE' });
  const modA = await prisma.trainingModule.create({ data: { courseId: c.id, title: 'Guide v1', contentType: 'NOTE', description: 'Original guide.', addedInVersion: 1 } });
  const v1Agent = await makeUser('TRAVEL_AGENT', 'v1learner'); const v2Agent = await makeUser('TRAVEL_AGENT', 'v2learner');
  await assign(c, v1Agent, { version: 1 });
  // published: the old in-place editing routes refuse
  const replace = await request(app).post(`/admin/training/${c.id}/modules/${modA.id}/file`).set('Cookie', cookies[admin.id]).attach('file', Buffer.from('%PDF-1.4\n'), { filename: 'x.pdf', contentType: 'application/pdf' });
  assert.equal(replace.status, 409); assert.match(replace.text, /new version/);
  assert.equal((await post(admin, `/admin/training/${c.id}/modules/${modA.id}/required`, { required: 'false' })).status, 409);
  assert.equal((await prisma.trainingModule.findUnique({ where: { id: modA.id } })).required, true);
  // new version: add material B, take A out of v2
  assert.equal((await post(admin, `/ai-practice/${c.id}/new-version`)).status, 302);
  assert.equal((await post(admin, `/ai-practice/${c.id}/sources`, { noteText: 'Improved guide.' })).status, 302);
  const modB = await prisma.trainingModule.findFirst({ where: { courseId: c.id, id: { not: modA.id } } });
  await prisma.trainingModule.update({ where: { id: modB.id }, data: { title: 'Guide v2' } });
  assert.equal(modB.addedInVersion, 2);
  assert.equal((await post(admin, `/ai-practice/${c.id}/sources/${modA.id}/remove`)).status, 302);
  const a = await prisma.trainingModule.findUnique({ where: { id: modA.id } });
  assert.equal(a.removedInVersion, 2); assert.equal(await prisma.trainingModule.count({ where: { id: modA.id } }), 1, 'v1 material is kept, only left out of v2');
  const full = await prisma.trainingCourse.findUnique({ where: { id: c.id }, include: { modules: true } });
  assert.deepEqual(versions.modulesFor(full.modules, 1).map((m) => m.title), ['Guide v1']);
  assert.deepEqual(versions.modulesFor(full.modules, 2).map((m) => m.title), ['Guide v2']);
  // the workspace works on v2, Training and the v1 learner still see v1
  assert.match((await get(admin, `/ai-practice/${c.id}?step=source`)).text, /Guide v2/); assert.doesNotMatch((await get(admin, `/ai-practice/${c.id}?step=source`)).text, /Guide v1/);
  const learner1 = await get(v1Agent, `/training-course/${c.id}`);
  assert.equal(learner1.status, 200); assert.match(learner1.text, /Guide v1/); assert.doesNotMatch(learner1.text, /Guide v2/);
  assert.match((await get(admin, `/admin/training/${c.id}`)).text, /Guide v1/);
  // publishing v2 (analysis + practice are not part of this test: mark the draft as sent directly through the same rule)
  await prisma.trainingCourse.update({ where: { id: c.id }, data: { publishedVersion: 2 } });
  await assign(c, v2Agent, { version: 2 });
  const learner2 = await get(v2Agent, `/training-course/${c.id}`);
  assert.match(learner2.text, /Guide v2/); assert.doesNotMatch(learner2.text, /Guide v1/);
  assert.match((await get(v1Agent, `/training-course/${c.id}`)).text, /Guide v1/, 'the v1 learner is still on v1');
  await prisma.trainingCourse.update({ where: { id: c.id }, data: { publishedVersion: 1 } });
  // discarding the draft removes what was added in it and brings back what it removed
  assert.equal((await post(admin, `/ai-practice/${c.id}/version/discard`)).status, 302);
  assert.equal(await prisma.trainingModule.count({ where: { id: modB.id } }), 0);
  assert.equal((await prisma.trainingModule.findUnique({ where: { id: modA.id } })).removedInVersion, null);
});

test('TRAINING VERSIONING: the material check for required media uses the version the learner was assigned', async () => {
  const { mediaGate } = require('../lib/mediaProgress');
  const c = await course('IP media', { origin: 'AI_PRACTICE' });
  const learner = await makeUser('TRAVEL_AGENT', 'medialearner');
  await assign(c, learner, { version: 1 });
  const video = await prisma.trainingModule.create({ data: { courseId: c.id, title: 'Video v2 only', contentType: 'VIDEO', required: true, storagePath: 'training/none.mp4', addedInVersion: 2, sourceRefJson: JSON.stringify({ durationSeconds: 60 }) } });
  assert.equal((await mediaGate(learner.id, c.id)).unlocked, true, 'a v1 learner is not held to material that only exists in v2');
  assert.equal((await mediaGate(learner.id, c.id, 2)).unlocked, false);
  assert.equal((await mediaGate(learner.id, c.id, 2)).modules[0].id, video.id);
});

// ================================================================== 1. AI Practice unification
test('AI PRACTICE: one unified list — no separate "earlier raw uploads"; failed and stuck items offer Continue / Retry / Remove; Training stays separate until sent', async () => {
  // legacy raw-upload routes are gone
  assert.ok(blocked(await request(app).post('/ai-practice').set('Cookie', cookies[admin.id]).field('title', 'x').field('materialType', 'NOTE').field('noteContent', 'y')));
  assert.equal((await get(admin, '/ai-practice')).text.includes('Earlier raw uploads'), false);
  // a failed analysis
  const failed = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'IP failed source', createdById: admin.id, origin: 'AI_PRACTICE', modules: { create: { title: 'Note', contentType: 'NOTE', description: 'x' } } } });
  await prisma.trainingAnalysis.create({ data: { courseId: failed.id, status: 'FAILED', errorMessage: 'boom' } });
  // a stuck analysis
  const stuck = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'IP stuck source', createdById: admin.id, origin: 'AI_PRACTICE', modules: { create: { title: 'Note', contentType: 'NOTE', description: 'x' } } } });
  const sa = await prisma.trainingAnalysis.create({ data: { courseId: stuck.id, status: 'MAPPING' } });
  await prisma.trainingAnalysis.update({ where: { id: sa.id }, data: { updatedAt: new Date(Date.now() - 3600000) } });
  const items = await state.loadSources(admin);
  const f = items.find((i) => i.id === failed.id); const s = items.find((i) => i.id === stuck.id);
  assert.equal(f.state.primary.label, 'Retry'); assert.equal(f.remove.label, 'Remove');
  assert.equal(s.state.primary.label, 'Continue'); assert.equal(s.remove.label, 'Remove');
  const list = await get(admin, '/ai-practice');
  assert.match(list.text, /Retry/); assert.match(list.text, /Remove/); // (opening the list already continues the stalled analysis by itself)
  // Continue re-queues the stuck one with its finished steps; Remove deletes unused work
  assert.equal((await post(admin, `/ai-practice/${stuck.id}/analysis/resume`)).status, 302);
  assert.equal((await prisma.trainingAnalysis.findUnique({ where: { id: sa.id } })).status, 'QUEUED');
  assert.equal((await post(admin, `/ai-practice/${failed.id}/delete`)).headers.location, '/ai-practice?notice=deleted');
  assert.equal(await prisma.trainingCourse.count({ where: { id: failed.id } }), 0);
  // a stalled call can be removed too, a healthy one cannot
  const stalled = await prisma.callBatch.create({ data: { organizationId: org.id, uploadedById: admin.id, mode: 'BEST_PRACTICE', status: 'TRANSCRIBING', analysisRequestedAt: new Date() } });
  assert.equal((await post(admin, `/ai-practice/calls/${stalled.id}/delete`)).status, 409);
  await prisma.callBatch.update({ where: { id: stalled.id }, data: { updatedAt: new Date(Date.now() - 3600000) } });
  assert.equal(state.callState(await prisma.callBatch.findUnique({ where: { id: stalled.id }, include: { recordings: true } })).remove.label, 'Remove');
  assert.equal((await post(admin, `/ai-practice/calls/${stalled.id}/delete`)).status, 302);
  // AI Practice work is invisible in Training until it is sent
  const training = await get(admin, '/admin/training');
  assert.doesNotMatch(training.text, /IP stuck source/);
});

// ================================================================== 8. production / packaging
test('PACKAGING: the release list never contains .env files, databases, uploads, logs, sessions or keys, and the ZIP scan finds no secrets', async () => {
  for (const bad of ['.env', '.env.local', '.env.production', 'prisma/dev.db', 'prisma/dev.db-journal', 'storage/training/a.pdf', 'public/uploads/x.png', 'debug.log', 'ngrok-out.log', 'backup.zip', 'server.pem', 'keys/id.key', 'tmp/session.json', 'sessions/abc', 'generated/postgresql/client.js', 'node_modules/x/index.js', '.claude/settings.json', 'coverage/lcov.info', 'SpaceZero-Workspace-Demo.html']) assert.equal(pack.shouldExclude(bad), true, `${bad} must be excluded`);
  for (const good of ['server.js', 'lib/readiness.js', 'prisma/schema.prisma', 'prisma/migrations/20260922100000_readiness_versioned_modules/migration.sql', '.env.production.example', 'views/layout.ejs', 'public/css/styles.css']) assert.equal(pack.shouldExclude(good), false, `${good} must be included`);
  // a scratch project with secrets and local data: none of it gets in, and a secret inside an included file blocks the build
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-'));
  const put = (rel, content) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); };
  put('server.js', 'module.exports = 1;'); put('.env', `GEMINI_API_KEY=${FAKE_KEY}`); put('prisma/dev.db', 'sqlite'); put('storage/a.pdf', '%PDF'); put('public/uploads/a.png', 'png'); put('app.log', 'log'); put('.env.production.example', 'GEMINI_API_KEY=\nCREDENTIAL_ENCRYPTION_KEY=\nDATABASE_URL=postgresql://USER:CHANGE_ME@HOST:5432/db\n');
  const clean = pack.plan(dir);
  assert.deepEqual(clean.files, ['.env.production.example', 'server.js']); assert.deepEqual(clean.secrets, []); assert.deepEqual(clean.forbidden, []);
  put('config.js', `const key = '${FAKE_KEY}';`);
  put('deploy.md', 'GEMINI_API_KEY=abcdef1234567890abcdef1234567890\n');
  const dirty = pack.plan(dir);
  assert.deepEqual(dirty.secrets.map((s) => s.file).sort(), ['config.js', 'deploy.md']);
  assert.throws(() => pack.build(dir), /Release blocked/);
  fs.rmSync(dir, { recursive: true, force: true });
  // the real project
  const real = pack.plan();
  assert.deepEqual(real.forbidden, []); assert.deepEqual(real.secrets, [], JSON.stringify(real.secrets));
  assert.ok(real.files.includes('server.js') && real.files.includes('scripts/package-release.cjs'));
  assert.ok(!real.files.some((f) => /^\.env(\.|$)/.test(path.basename(f)) && path.basename(f) !== '.env.production.example'));
  assert.ok(!real.files.some((f) => /(^|\/)(storage|uploads|node_modules|\.claude|generated)\//.test(f)));
});

test('PRODUCTION: secrets are not logged, credentials stay encrypted at rest, and source code never prints keys', async () => {
  const roots = ['lib', 'routes', 'routes/admin', 'server.js'];
  const files = roots.flatMap((r) => { const p = path.join(__dirname, '..', r); return fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter((f) => f.endsWith('.js')).map((f) => path.join(p, f)) : [p]; });
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /console\.(log|error|warn|info)\([^)]*(process\.env|req\.body|apiKey|GEMINI_API_KEY|CREDENTIAL_ENCRYPTION_KEY|passwordHash|payloadEnc)/, `${path.basename(f)} logs something sensitive`);
  }
  const { encryptText } = require('../lib/credentialCrypto');
  const enc = encryptText(JSON.stringify({ username: 'u', password: 'Sup3r-secret-value' }));
  assert.doesNotMatch(enc, /Sup3r-secret-value/); assert.doesNotMatch(enc, /username/);
  // the audit trail of a credential action never contains the secret
  const rows = await prisma.auditLog.findMany({ where: { organizationId: org.id } });
  assert.ok(rows.every((r) => !/Sup3r|password/i.test(r.metadataJson || '')));
});
