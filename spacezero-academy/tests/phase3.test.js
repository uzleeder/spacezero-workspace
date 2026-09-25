'use strict';
// Phase 3: skill intelligence, personalized development, supervisor/admin intelligence, effectiveness,
// automation, certifications, search filters and the security matrix. Gemini is mocked and never called.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');

mock.method(require('../lib/gemini'), 'generateStructured', async () => { throw new Error('AI service unavailable (test)'); });

const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { hashPassword } = require('../lib/password');
const { recomputeSkillScore, evidenceWeight } = require('../lib/scoring');
const { nextActions } = require('../lib/development');
const { teamIntelligence } = require('../lib/teamIntel');
const { organizationIntelligence } = require('../lib/orgIntel');
const { courseEffectiveness } = require('../lib/effectiveness');
const { runAutomation } = require('../lib/automation');
const { evaluateOrganization } = require('../lib/certifications');
const app = require('../server');

const DAY = 86400000;
let org, other, cookies = {};
let admin, sup, supB, agent, agentB, expert, foreignAdmin;
let team, teamB;
let sk = {}; // skills by short name
let course, practice;
const as = (p) => cookies[p.id];
const get = (p, url) => request(app).get(url).set('Cookie', as(p));
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', as(p)).type('form').send(body);
const blocked = (res) => res.status !== 200 && res.status < 500; // 302 to login, 403 or 404 — never the page

async function makeUser(role, name, organizationId = org.id, extra = {}) {
  const passwordHash = await hashPassword('Correct-Horse-9!');
  const p = await prisma.profile.create({ data: { organizationId, fullName: `P3 ${name}`, username: `p3_${organizationId}_${name}`, email: `p3_${organizationId}_${name}@example.invalid`, role, status: 'ACTIVE', passwordHash, employmentStartDate: new Date(Date.now() - 200 * DAY), ...extra } });
  const token = generateToken();
  await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
  cookies[p.id] = `sz_session=${token.raw}`;
  return p;
}
async function skillRow(profile, skill) {
  return prisma.employeeSkill.upsert({ where: { profileId_skillId: { profileId: profile.id, skillId: skill.id } }, update: {}, create: { profileId: profile.id, skillId: skill.id } });
}
/** Writes one piece of evidence dated `daysAgo` and recomputes the aggregate as of that moment (so history has a real timeline). */
async function addEvidence(profile, skill, score, { type = 'QUIZ', source = 'ASSESSMENT', daysAgo = 0, difficulty = 3 } = {}) {
  const row = await skillRow(profile, skill);
  const at = new Date(Date.now() - daysAgo * DAY);
  await prisma.skillEvidence.create({ data: { employeeSkillId: row.id, sourceType: source, assessmentType: type, difficulty, scoreImpact: score, weight: evidenceWeight({ sourceType: source, assessmentType: type, difficulty }), createdAt: at } });
  await recomputeSkillScore(row.id, { now: at });
  return row;
}
const skillOf = (profile, skill) => prisma.employeeSkill.findUnique({ where: { profileId_skillId: { profileId: profile.id, skillId: skill.id } } });
async function newCourse(title, { status = 'PUBLISHED', policy = 'ALL_SUPERVISORS', analysis = null } = {}) {
  const c = await prisma.trainingCourse.create({ data: { organizationId: org.id, title, status, assignPolicy: policy, createdById: admin.id, mandatory: true } });
  if (analysis) await prisma.trainingAnalysis.create({ data: { courseId: c.id, status: 'APPROVED', extractedSkillsJson: JSON.stringify(analysis) } });
  return c;
}
async function assign(c, profile, { dueDate = null, assessmentId = null, createdAt = new Date(), attempt = { status: 'NOT_STARTED' } } = {}) {
  const a = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: c.id, assignedById: admin.id, scope: 'INDIVIDUAL', dueDate, assessmentId, createdAt } });
  const r = await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: a.id, profileId: profile.id } });
  const t = await prisma.trainingAttempt.create({ data: { recipientId: r.id, profileId: profile.id, attemptNumber: 1, ...attempt } });
  return { assignment: a, recipient: r, attempt: t };
}

before(async () => {
  org = await prisma.organization.create({ data: { name: 'P3 tests' } });
  other = await prisma.organization.create({ data: { name: 'P3 other org' } });
  admin = await makeUser('ADMIN', 'admin'); sup = await makeUser('SUPERVISOR', 'sup'); supB = await makeUser('SUPERVISOR', 'supB');
  agent = await makeUser('TRAVEL_AGENT', 'agent'); agentB = await makeUser('TRAVEL_AGENT', 'agentB'); expert = await makeUser('FLIGHT_EXPERT', 'expert');
  foreignAdmin = await makeUser('ADMIN', 'foreignAdmin', other.id);
  team = await prisma.team.create({ data: { organizationId: org.id, name: 'P3 Team' } });
  teamB = await prisma.team.create({ data: { organizationId: org.id, name: 'P3 Team B' } });
  for (const [t, members] of [[team, [sup, agent]], [teamB, [supB, agentB]]]) for (const m of members) await prisma.teamMembership.create({ data: { teamId: t.id, profileId: m.id } });
  await prisma.supervisorAssignment.create({ data: { supervisorId: sup.id, agentId: agent.id, teamId: team.id, assignedById: admin.id } });
  await prisma.supervisorAssignment.create({ data: { supervisorId: supB.id, agentId: agentB.id, teamId: teamB.id, assignedById: admin.id } });
  const mk = (name, roleKey, category) => prisma.skill.create({ data: { organizationId: org.id, name, roleKey, category } });
  sk.closing = await mk('Closing', 'TRAVEL_AGENT', 'Sales');
  sk.discovery = await mk('Discovery Questions', 'TRAVEL_AGENT', 'Sales');
  sk.objection = await mk('Objection Handling', 'TRAVEL_AGENT', 'Sales');
  sk.fare = await mk('Fare Search', 'FLIGHT_EXPERT', 'GDS / Technical');
  sk.sop = await mk('Company SOP', null, 'Process');
  course = await newCourse('P3 Sales Foundations', { analysis: ['Closing'] });
  practice = await prisma.assessment.create({ data: { organizationId: org.id, courseId: course.id, createdById: admin.id, createdVia: 'ADMIN_MANUAL', type: 'QUIZ', title: 'Closing practice', status: 'APPROVED', configJson: JSON.stringify({ focusSkills: ['Closing'] }) } });
});
after(async () => { mock.restoreAll(); await prisma.$disconnect(); });

// ------------------------------------------------------------------ skill evidence and confidence
test('evidence -> score: a lone 92% quiz is LOW confidence, a well-evidenced 82% is HIGH, so 92% never looks more competent', async () => {
  const lone = await makeUser('TRAVEL_AGENT', 'lone');
  const solid = await makeUser('TRAVEL_AGENT', 'solid');
  await addEvidence(lone, sk.closing, 92, { daysAgo: 1 });
  for (const [score, type, days] of [[80, 'QUIZ', 40], [84, 'ROLEPLAY', 30], [82, 'ROLEPLAY', 20], [81, 'PROCESS_SIM', 10], [83, 'ROLEPLAY', 3]]) await addEvidence(solid, sk.closing, score, { type, daysAgo: days });
  const a = await skillOf(lone, sk.closing); const b = await skillOf(solid, sk.closing);
  assert.equal(a.confidenceLevel, 'LOW');
  assert.equal(b.confidenceLevel, 'HIGH');
  assert.ok(Math.round(b.currentScore) >= 80 && Math.round(b.currentScore) <= 84);
  assert.equal(a.evidenceCount, 1); assert.equal(b.evidenceCount, 5);
});

test('improvement 48 -> 76 -> 84 keeps the full history: rows are appended, the first is never overwritten', async () => {
  const p = await makeUser('TRAVEL_AGENT', 'improver');
  await addEvidence(p, sk.discovery, 48, { daysAgo: 60 });
  await addEvidence(p, sk.discovery, 76, { daysAgo: 30 });
  await addEvidence(p, sk.discovery, 84, { daysAgo: 1 });
  const row = await skillOf(p, sk.discovery);
  const history = await prisma.skillScoreHistory.findMany({ where: { employeeSkillId: row.id }, orderBy: { recordedAt: 'asc' } });
  assert.equal(history.length, 3);
  assert.equal(Math.round(history[0].score), 48);
  assert.ok(history[1].score > history[0].score && history[2].score > history[1].score);
  assert.equal(Math.round(row.currentScore), Math.round(history[2].score));
  const res = await get(p, `/employees/${p.id}/skills/${row.id}`);
  assert.equal(res.status, 200);
  assert.match(res.text, /Discovery Questions/);
});

test('recalculating from evidence after a configuration change appends history and never deletes it', async () => {
  const p = await makeUser('TRAVEL_AGENT', 'recalc');
  const row = await addEvidence(p, sk.closing, 70, { daysAgo: 5 });
  const before = await prisma.skillScoreHistory.count({ where: { employeeSkillId: row.id } });
  const res = await post(admin, '/admin/skills/recalculate');
  assert.equal(res.status, 302);
  assert.ok((await prisma.skillScoreHistory.count({ where: { employeeSkillId: row.id } })) > before);
});

// ------------------------------------------------------------------ personalized development
test('agent journey: a weak skill produces a next action with a reason from real evidence and practice the employee can start', async () => {
  const p = await makeUser('TRAVEL_AGENT', 'journey');
  await assign(course, p, { assessmentId: null });
  await addEvidence(p, sk.closing, 42, { daysAgo: 6 });
  await addEvidence(p, sk.closing, 48, { daysAgo: 2 });
  const res = await nextActions(p);
  const item = res.items.find((i) => i.skill && i.skill.name === 'Closing');
  assert.ok(item, 'a Closing item exists');
  assert.match(item.reason, /Closing is \d+%/);
  assert.equal(item.action.type, 'START');
  assert.ok(item.action.href.includes(practice.id));
  const page = await get(p, '/dashboard');
  assert.equal(page.status, 200);
  assert.match(page.text, /What should I practice next/i);
});

test('Flight Experts never receive sales skills or sales practice', async () => {
  await assign(course, expert);
  await addEvidence(expert, sk.fare, 55, { daysAgo: 3 });
  const res = await nextActions(expert);
  const names = res.rows.map((r) => r.skill.name);
  assert.ok(names.includes('Fare Search'));
  for (const sales of ['Closing', 'Discovery Questions', 'Objection Handling']) assert.ok(!names.includes(sales), `${sales} must not appear`);
  assert.ok(!res.items.some((i) => /Closing|Discovery|Objection/.test(i.title + i.reason)));
  const page = await get(expert, '/skill-graph');
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /Objection Handling/);
});

test('an employee with no evidence, or a single assessment, is handled honestly (no fake scores, low confidence)', async () => {
  const empty = await makeUser('TRAVEL_AGENT', 'empty');
  const res = await nextActions(empty);
  assert.equal(res.rows.filter((r) => r.assessed).length, 0);
  assert.equal((await get(empty, '/skill-graph')).status, 200);
  assert.equal((await get(empty, '/dashboard')).status, 200);
  const one = await makeUser('TRAVEL_AGENT', 'single');
  await addEvidence(one, sk.objection, 88, { daysAgo: 2 });
  const row = await skillOf(one, sk.objection);
  assert.equal(row.confidenceLevel, 'LOW');
});

// ------------------------------------------------------------------ retention, automation
test('retention: a decline after training recommends a targeted practice (not the whole course) and never duplicates', async () => {
  const p = await makeUser('TRAVEL_AGENT', 'retention');
  const done = new Date(Date.now() - 40 * DAY);
  await assign(course, p, { createdAt: new Date(done.getTime() - 3 * DAY), attempt: { status: 'COMPLETED', score: 88, completedAt: done, startedAt: done } });
  const row = await skillRow(p, sk.closing);
  await prisma.skillScoreHistory.create({ data: { employeeSkillId: row.id, score: 85, confidence: 65, recordedAt: new Date(done.getTime() + 3600000) } });
  await prisma.employeeSkill.update({ where: { id: row.id }, data: { currentScore: 60, evidenceCount: 3, confidenceLevel: 'MEDIUM' } });
  const first = await runAutomation(org.id);
  assert.ok(first.retentionScheduled >= 2 && first.retention.declined >= 1);
  const recs = await prisma.developmentRecommendation.findMany({ where: { profileId: p.id, kind: 'RETENTION' } });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].assessmentId, practice.id, 'a targeted practice is recommended');
  assert.match(recs[0].reason, /not the whole training/);
  await runAutomation(org.id);
  assert.equal(await prisma.developmentRecommendation.count({ where: { profileId: p.id, kind: 'RETENTION' } }), 1);
  assert.equal(await prisma.notification.count({ where: { profileId: p.id, type: 'development.recommended' } }), 1);
  const items = (await nextActions(p)).items;
  assert.ok(items.some((i) => i.kind === 'RETENTION' && i.action.type === 'START'));
});

test('assignment rules recommend by default; ASSIGN never assigns a draft; rules fire once per employee', async () => {
  const p = await makeUser('TRAVEL_AGENT', 'ruled');
  await addEvidence(p, sk.objection, 35, { daysAgo: 4 });
  await addEvidence(p, sk.objection, 40, { daysAgo: 2 });
  const draft = await newCourse('P3 Draft Only', { status: 'DRAFT' });
  await prisma.assignmentRule.create({ data: { organizationId: org.id, name: 'Objections weak', roleKey: 'TRAVEL_AGENT', conditionJson: JSON.stringify({ skillId: sk.objection.id, below: 60, minConfidence: 'LOW' }), action: 'RECOMMEND', courseId: course.id, createdById: admin.id } });
  await prisma.assignmentRule.create({ data: { organizationId: org.id, name: 'Draft auto', roleKey: 'TRAVEL_AGENT', conditionJson: JSON.stringify({ skillId: sk.objection.id, below: 60, minConfidence: 'LOW' }), action: 'ASSIGN', courseId: draft.id, createdById: admin.id } });
  const before = await prisma.trainingAssignment.count({ where: { courseId: draft.id } });
  await runAutomation(org.id); await runAutomation(org.id);
  const recs = await prisma.developmentRecommendation.findMany({ where: { profileId: p.id, kind: 'RULE' } });
  assert.equal(recs.length, 2);
  assert.ok(recs.every((r) => r.status === 'OPEN'), 'a draft is never auto-assigned; it stays a recommendation');
  assert.equal(await prisma.trainingAssignment.count({ where: { courseId: draft.id } }), before);
  // an established published training with ASSIGN really is assigned, once
  const established = await newCourse('P3 Established');
  await prisma.assignmentRule.create({ data: { organizationId: org.id, name: 'Auto established', roleKey: 'TRAVEL_AGENT', conditionJson: JSON.stringify({ skillId: sk.objection.id, below: 60, minConfidence: 'LOW' }), action: 'ASSIGN', courseId: established.id, createdById: admin.id } });
  await runAutomation(org.id); await runAutomation(org.id);
  assert.equal(await prisma.trainingAssignmentRecipient.count({ where: { profileId: p.id, assignment: { courseId: established.id } } }), 1);
});

test('onboarding path steps fire once for a new hire, inside their window', async () => {
  const hire = await makeUser('TRAVEL_AGENT', 'hire', org.id, { employmentStartDate: new Date(Date.now() - 8 * DAY) });
  const path = await prisma.developmentPath.create({ data: { organizationId: org.id, name: 'First 90 days', roleKey: 'TRAVEL_AGENT', createdById: admin.id } });
  await prisma.developmentPathStep.create({ data: { pathId: path.id, dayOffset: 7, title: 'Week 1 check-in practice', courseId: course.id } });
  await runAutomation(org.id); await runAutomation(org.id);
  assert.equal(await prisma.developmentRecommendation.count({ where: { profileId: hire.id, kind: 'ONBOARDING' } }), 1);
  assert.equal(await prisma.developmentRecommendation.count({ where: { profileId: agent.id, kind: 'ONBOARDING' } }), 0, 'a long-tenured employee is outside the grace window');
});

test('reminders and supervisor alerts are sent once however often the automation runs', async () => {
  const late = await makeUser('TRAVEL_AGENT', 'late');
  await prisma.supervisorAssignment.create({ data: { supervisorId: sup.id, agentId: late.id, teamId: team.id, assignedById: admin.id } });
  const c = await newCourse('P3 Overdue Course');
  await assign(c, late, { dueDate: new Date(Date.now() - 3 * DAY) });
  await runAutomation(org.id); await runAutomation(org.id); await runAutomation(org.id);
  assert.equal(await prisma.notification.count({ where: { profileId: late.id, type: 'training.overdue' } }), 1);
  assert.equal(await prisma.notification.count({ where: { profileId: sup.id, type: 'training.overdue', title: { contains: 'P3 late' } } }), 1);
});

// ------------------------------------------------------------------ team intelligence + bulk assignment
test('supervisor with 10 agents: the team priority is the weakest common skill and 4 can be assigned individually', async () => {
  const boss = await makeUser('SUPERVISOR', 'boss');
  const agents = [];
  for (let i = 0; i < 10; i += 1) {
    const a = await makeUser('TRAVEL_AGENT', `crew${i}`);
    await prisma.supervisorAssignment.create({ data: { supervisorId: boss.id, agentId: a.id, assignedById: admin.id } });
    await addEvidence(a, sk.closing, i < 7 ? 45 : 90, { daysAgo: 3 });
    await addEvidence(a, sk.closing, i < 7 ? 50 : 88, { daysAgo: 1 });
    agents.push(a);
  }
  const intel = await teamIntelligence(org.id, agents.map((a) => a.id));
  assert.equal(intel.priority.skill.name, 'Closing');
  assert.equal(intel.priority.weakCount, 7);
  assert.equal((await get(boss, '/team-skills')).status, 200);
  assert.equal((await get(boss, `/bulk-assign?skillId=${sk.closing.id}`)).status, 200);
  const chosen = agents.slice(0, 4).map((a) => a.id);
  const res = await post(boss, '/bulk-assign', { kind: 'COURSE', courseId: course.id, employeeIds: chosen });
  assert.equal(res.status, 302);
  const recipients = await prisma.trainingAssignmentRecipient.findMany({ where: { profileId: { in: agents.map((a) => a.id) }, assignment: { courseId: course.id, assignedById: boss.id } }, include: { attempts: true } });
  assert.equal(recipients.length, 4);
  assert.ok(recipients.every((r) => r.attempts.length === 1 && r.attempts[0].status === 'NOT_STARTED'), 'each is tracked individually');
  assert.equal(await prisma.notification.count({ where: { profileId: chosen[0], type: 'training.assigned' } }), 1);
  // another team's employee in the same request: nothing at all is created
  const attempt = await post(boss, '/bulk-assign', { kind: 'COURSE', courseId: course.id, employeeIds: [agents[5].id, agentB.id] });
  assert.equal(attempt.status, 403);
  assert.equal(await prisma.trainingAssignmentRecipient.count({ where: { profileId: { in: [agents[5].id, agentB.id] }, assignment: { assignedById: boss.id } } }), 0);
});

test('drafts and admin-only training can not be bulk-assigned by a supervisor', async () => {
  const draft = await newCourse('P3 Draft For Bulk', { status: 'DRAFT' });
  const adminOnly = await newCourse('P3 Admin Only', { policy: 'ADMIN_ONLY' });
  for (const c of [draft, adminOnly]) {
    const res = await post(sup, '/bulk-assign', { kind: 'COURSE', courseId: c.id, employeeIds: [agent.id] });
    assert.ok([403, 404].includes(res.status), `status ${res.status}`);
    assert.equal(await prisma.trainingAssignmentRecipient.count({ where: { assignment: { courseId: c.id } } }), 0);
  }
});

test('coaching view for an assigned supervisor works and coaching notes are stored with the author', async () => {
  const res = await post(sup, `/employees/${agent.id}/coaching-notes`, { body: 'Practise closing on longer itineraries.', skillId: sk.closing.id });
  assert.ok([200, 302].includes(res.status));
  const note = await prisma.coachingNote.findFirst({ where: { profileId: agent.id } });
  assert.equal(note.authorId, sup.id);
  assert.equal((await get(sup, `/employees/${agent.id}/skills`)).status, 200);
});

// ------------------------------------------------------------------ organization intelligence + effectiveness
test('admin organization intelligence renders and drills down; supervisors and agents cannot open it', async () => {
  const res = await get(admin, '/admin/intelligence');
  assert.equal(res.status, 200);
  assert.equal((await get(admin, `/admin/intelligence?role=TRAVEL_AGENT&teamId=${team.id}`)).status, 200);
  assert.equal((await get(admin, '/admin/intelligence?teamId=someone-elses-team')).status, 200); // an unknown team is ignored, not trusted
  for (const p of [sup, agent, expert]) assert.ok(blocked(await get(p, '/admin/intelligence')));
  const intel = await organizationIntelligence(admin);
  assert.ok(intel.employees >= 5);
  assert.ok(intel.weaknesses.some((w) => w.skill.name === 'Closing'));
});

test('training effectiveness: fewer than 3 observations is "not enough evidence"; with enough it reports observed change and an indicator with its disclaimer', async () => {
  const c = await newCourse('P3 Effectiveness Course', { analysis: ['Discovery Questions'] });
  const few = await courseEffectiveness(org.id, c.id);
  assert.equal(few.observed.enough, false);
  assert.equal(few.indicator.score, null);
  const done = new Date(Date.now() - 20 * DAY);
  for (let i = 0; i < 3; i += 1) {
    const p = await makeUser('TRAVEL_AGENT', `eff${i}`);
    const row = await skillRow(p, sk.discovery);
    await prisma.skillScoreHistory.create({ data: { employeeSkillId: row.id, score: 50, confidence: 35, recordedAt: new Date(done.getTime() - 10 * DAY) } });
    await prisma.skillScoreHistory.create({ data: { employeeSkillId: row.id, score: 70, confidence: 65, recordedAt: new Date(done.getTime() + DAY) } });
    await prisma.employeeSkill.update({ where: { id: row.id }, data: { currentScore: 70, evidenceCount: 2 } });
    await assign(c, p, { createdAt: new Date(done.getTime() - 5 * DAY), attempt: { status: 'COMPLETED', score: 80, completedAt: done } });
  }
  const full = await courseEffectiveness(org.id, c.id);
  assert.equal(full.observed.enough, true);
  assert.equal(full.observed.before, 50); assert.equal(full.observed.after, 70); assert.equal(full.observed.change, 20);
  assert.equal(typeof full.indicator.score, 'number');
  assert.match(full.indicator.disclaimer, /not scientifically validated/);
  assert.match(full.indicator.disclaimer, /does not prove/);
  const page = await get(admin, `/admin/intelligence/training/${c.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Observed skill change/);
  assert.equal((await get(admin, '/admin/intelligence/training')).status, 200);
  assert.equal((await get(foreignAdmin, `/admin/intelligence/training/${c.id}`)).status, 404);
});

// ------------------------------------------------------------------ certifications
test('certifications need demonstrated competency: a single high score is not enough; issued once with a stored snapshot; expiry handled', async () => {
  const p = await makeUser('TRAVEL_AGENT', 'certified');
  const def = await prisma.certificationDefinition.create({ data: { organizationId: org.id, name: 'Closing Certified', roleKey: 'TRAVEL_AGENT', requirementsJson: JSON.stringify({ skills: [{ skillId: sk.closing.id, min: 80, minConfidence: 'MEDIUM' }], noOutstandingRetakes: false }), validityDays: 30, renewalNote: 'Retake the role-play.', createdById: admin.id } });
  await addEvidence(p, sk.closing, 95, { daysAgo: 2 });
  await evaluateOrganization(org.id);
  assert.equal(await prisma.earnedCertification.count({ where: { profileId: p.id } }), 0, 'one quiz is LOW confidence');
  await addEvidence(p, sk.closing, 90, { type: 'ROLEPLAY', daysAgo: 1 });
  await addEvidence(p, sk.closing, 88, { type: 'ROLEPLAY', daysAgo: 0 });
  await evaluateOrganization(org.id); await evaluateOrganization(org.id);
  const earned = await prisma.earnedCertification.findMany({ where: { profileId: p.id } });
  assert.equal(earned.length, 1);
  assert.ok(earned[0].expiresAt > new Date());
  assert.ok(JSON.parse(earned[0].snapshotJson).checks.length >= 1);
  assert.equal(await prisma.notification.count({ where: { profileId: p.id, type: 'certification.earned' } }), 1);
  await prisma.earnedCertification.update({ where: { id: earned[0].id }, data: { expiresAt: new Date(Date.now() - DAY) } });
  await evaluateOrganization(org.id);
  assert.equal((await prisma.earnedCertification.findUnique({ where: { id: earned[0].id } })).status, 'EXPIRED');
  await prisma.certificationDefinition.update({ where: { id: def.id }, data: { isActive: false } });
});

test('admin certification and skill management pages work, are audited, and are admin-only', async () => {
  for (const url of ['/admin/development', '/admin/certifications', '/admin/skills']) {
    assert.equal((await get(admin, url)).status, 200, url);
    for (const p of [sup, agent, expert]) assert.ok(blocked(await get(p, url)), `${url} for ${p.role}`);
  }
  const before = await prisma.skill.count({ where: { organizationId: org.id } });
  assert.equal((await post(sup, '/admin/skills', { name: 'Hacked Skill' })).status, 403);
  assert.equal(await prisma.skill.count({ where: { organizationId: org.id } }), before);
  await post(admin, '/admin/skills', { name: 'Negotiation', category: '__new', newCategory: 'Sales', roleKey: 'TRAVEL_AGENT' });
  assert.ok(await prisma.skill.findFirst({ where: { organizationId: org.id, name: 'Negotiation' } }));
  const audits = await prisma.auditLog.findMany({ where: { organizationId: org.id, action: 'skill.created' } });
  assert.ok(audits.length >= 1);
  // archiving keeps the history
  const neg = await prisma.skill.findFirst({ where: { organizationId: org.id, name: 'Negotiation' } });
  await post(admin, `/admin/skills/${neg.id}`, { name: 'Negotiation', category: 'Sales', roleKey: 'TRAVEL_AGENT' });
  assert.equal((await prisma.skill.findUnique({ where: { id: neg.id } })).isActive, false);
  // a certification with no competency requirement is refused
  const res = await post(admin, '/admin/certifications', { name: 'Watched videos' });
  assert.equal(res.status, 302);
  assert.equal(await prisma.certificationDefinition.count({ where: { organizationId: org.id, name: 'Watched videos' } }), 0);
});

test('micro-practice generation fails cleanly when Gemini is unavailable: nothing is created and the admin is told', async () => {
  const skill = sk.closing;
  const before = await prisma.assessment.count({ where: { organizationId: org.id } });
  const res = await post(admin, '/admin/skills/micro-practice', { skillId: skill.id, courseId: course.id });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /error=/);
  assert.equal(await prisma.assessment.count({ where: { organizationId: org.id } }), before);
});

// ------------------------------------------------------------------ search and filters
test('employee filters: skill + range narrow the list; a skill from another organization matches nobody', async () => {
  const foreignSkill = await prisma.skill.create({ data: { organizationId: other.id, name: 'Foreign Skill' } });
  const weak = await makeUser('TRAVEL_AGENT', 'filterWeak'); const strong = await makeUser('TRAVEL_AGENT', 'filterStrong');
  await addEvidence(weak, sk.closing, 30, { daysAgo: 2 }); await addEvidence(strong, sk.closing, 95, { daysAgo: 2 });
  const res = await get(admin, `/admin/employees?skill=${sk.closing.id}&max=50`);
  assert.equal(res.status, 200);
  assert.match(res.text, /P3 filterWeak/);
  assert.doesNotMatch(res.text, /P3 filterStrong/);
  const none = await get(admin, `/admin/employees?skill=${foreignSkill.id}`);
  assert.equal(none.status, 200);
  assert.doesNotMatch(none.text, /P3 filterWeak/);
  const overdue = await get(admin, '/admin/employees?overdue=1');
  assert.equal(overdue.status, 200);
  assert.match(overdue.text, /P3 late/);
  // supervisor: the same filters only ever see their own team
  const team1 = await get(sup, '/team?overdue=1');
  assert.equal(team1.status, 200);
  assert.match(team1.text, /P3 late/);
  assert.doesNotMatch(team1.text, /P3 agentB/);
});

// ------------------------------------------------------------------ security matrix
test('security: employees, supervisors and flight experts can only reach what they are entitled to', async () => {
  const rowB = await skillRow(agentB, sk.closing);
  const rowA = await skillRow(agent, sk.closing);
  assert.ok(blocked(await get(agent, `/employees/${agentB.id}/skills`)), 'agent A -> agent B');
  assert.ok(blocked(await get(expert, `/employees/${agent.id}/skills`)), 'flight expert -> agent');
  assert.ok(blocked(await get(sup, `/employees/${agentB.id}/skills`)), 'supervisor A -> team B agent');
  assert.ok(blocked(await get(supB, `/employees/${agent.id}/skills`)), 'supervisor B -> team A agent');
  assert.ok(blocked(await get(foreignAdmin, `/employees/${agent.id}/skills`)), 'other organization');
  // a skill-row id belonging to somebody else, requested under one's own employee id
  assert.equal((await get(agent, `/employees/${agent.id}/skills/${rowB.id}`)).status, 404);
  assert.equal((await get(sup, `/employees/${agent.id}/skills/${rowB.id}`)).status, 404);
  assert.equal((await get(agent, `/employees/${agent.id}/skills/${rowA.id}`)).status, 200);
  // agents and experts have no management actions
  for (const p of [agent, expert]) {
    assert.ok(blocked(await post(p, '/bulk-assign', { kind: 'COURSE', courseId: course.id, employeeIds: [p.id] })));
    assert.ok(blocked(await get(p, '/team-skills')));
    assert.ok(blocked(await post(p, `/employees/${agent.id}/coaching-notes`, { body: 'x' })));
  }
  // an agent cannot start a manual assessment of a colleague's skill
  assert.ok(blocked(await post(agent, `/employees/${agentB.id}/skills/${rowB.id}/assessment`, {})));
  // team B's supervisor cannot coach team A
  assert.ok(blocked(await post(supB, `/employees/${agent.id}/coaching-notes`, { body: 'not my team' })));
  assert.equal(await prisma.coachingNote.count({ where: { profileId: agent.id, authorId: supB.id } }), 0);
});

test('security: recommendations can only be acted on inside one\'s own scope (team / organization)', async () => {
  const rec = await prisma.developmentRecommendation.create({ data: { organizationId: org.id, profileId: agentB.id, kind: 'RULE', source: 'RULE', sourceKey: 'sec-test', courseId: course.id, title: 'Sec test', reason: 'test', priority: 1 } });
  assert.equal((await post(sup, `/recommendations/${rec.id}/dismiss`)).status, 404, 'supervisor of another team');
  assert.equal((await post(foreignAdmin, `/recommendations/${rec.id}/dismiss`)).status, 404, 'other organization');
  assert.ok(blocked(await post(agentB, `/recommendations/${rec.id}/dismiss`)), 'the employee themself');
  assert.equal((await prisma.developmentRecommendation.findUnique({ where: { id: rec.id } })).status, 'OPEN');
  assert.equal((await post(supB, `/recommendations/${rec.id}/assign`)).status, 302);
  assert.equal((await prisma.developmentRecommendation.findUnique({ where: { id: rec.id } })).status, 'ASSIGNED');
  assert.equal(await prisma.trainingAssignmentRecipient.count({ where: { profileId: agentB.id, assignment: { courseId: course.id, assignedById: supB.id } } }), 1);
});

test('security: employees only ever see their own certifications and notifications', async () => {
  const mine = await prisma.notification.create({ data: { profileId: agent.id, type: 't', title: 'P3 private note for agent', dedupeKey: 'sec-notif' } });
  const page = await get(agentB, '/notifications');
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /P3 private note for agent/);
  const own = await get(agent, '/notifications');
  assert.match(own.text, /P3 private note for agent/);
  await prisma.notification.delete({ where: { id: mine.id } });
});

// ------------------------------------------------------------------ edge cases
test('archived employees, archived training and team changes do not break intelligence', async () => {
  const gone = await makeUser('TRAVEL_AGENT', 'gone');
  await addEvidence(gone, sk.closing, 20, { daysAgo: 2 });
  await prisma.profile.update({ where: { id: gone.id }, data: { status: 'ARCHIVED' } });
  const intel = await organizationIntelligence(admin);
  const drill = await organizationIntelligence(admin, { role: 'TRAVEL_AGENT' });
  assert.ok(!drill.drill.some((d) => d.person.id === gone.id), 'archived employee is out of the picture');
  assert.ok(intel.employees > 0);
  const c = await newCourse('P3 To Delete');
  const mover = await makeUser('TRAVEL_AGENT', 'mover');
  await assign(c, mover);
  await prisma.trainingCourse.update({ where: { id: c.id }, data: { archivedAt: new Date() } });
  assert.equal((await nextActions(mover)).learning.length, 0);
  assert.equal((await get(mover, '/dashboard')).status, 200);
  await prisma.supervisorAssignment.create({ data: { supervisorId: sup.id, agentId: mover.id, assignedById: admin.id } });
  await prisma.supervisorAssignment.updateMany({ where: { agentId: mover.id }, data: { unassignedAt: new Date() } });
  assert.ok(blocked(await get(sup, `/employees/${mover.id}/skills`)), 'a supervisor loses access after the assignment ends');
});

test('conflicting and very old evidence: the score reflects both, old evidence loses influence, history is intact', async () => {
  const p = await makeUser('TRAVEL_AGENT', 'conflict');
  await addEvidence(p, sk.discovery, 95, { daysAgo: 400 });
  await addEvidence(p, sk.discovery, 40, { type: 'ROLEPLAY', daysAgo: 3 });
  const row = await skillOf(p, sk.discovery);
  assert.ok(row.currentScore < 55, `recent practical evidence dominates (${row.currentScore})`);
  const res = await get(p, `/employees/${p.id}/skills/${row.id}`);
  assert.equal(res.status, 200);
});

test('failed retakes remain in evidence and the attempt history', async () => {
  const p = await makeUser('TRAVEL_AGENT', 'retaker');
  await assign(course, p, { attempt: { status: 'RETAKE_REQUIRED', score: 55, completedAt: new Date() } });
  await addEvidence(p, sk.closing, 55, { daysAgo: 2 });
  await addEvidence(p, sk.closing, 78, { daysAgo: 0 });
  const row = await skillOf(p, sk.closing);
  assert.equal(row.evidenceCount, 2);
  assert.ok(row.currentScore > 55 && row.currentScore < 78, 'a failure followed by a pass is a blend, not an overwrite');
  const items = (await nextActions(p)).items;
  assert.ok(items.some((i) => i.kind === 'RETAKE'));
});

test('missing call analysis: an employee with only training evidence still gets a complete Skill DNA', async () => {
  const p = await makeUser('TRAVEL_AGENT', 'nocalls');
  await addEvidence(p, sk.closing, 75, { daysAgo: 3 });
  const res = await get(p, '/skill-graph');
  assert.equal(res.status, 200);
  assert.match(res.text, /Closing/);
});

// ------------------------------------------------------------------ performance on a realistic dataset
test('performance: ~200 employees x 8 skills with thousands of evidence rows — org and team intelligence stay fast', async () => {
  const big = await prisma.organization.create({ data: { name: 'P3 big org' } });
  const bigAdmin = await makeUser('ADMIN', 'bigAdmin', big.id);
  const skills = [];
  for (let i = 0; i < 8; i += 1) skills.push(await prisma.skill.create({ data: { organizationId: big.id, name: `Big skill ${i}`, roleKey: 'TRAVEL_AGENT', category: i < 4 ? 'Sales' : 'Product' } }));
  const bigSup = await makeUser('SUPERVISOR', 'bigSup', big.id);
  const passwordHash = await hashPassword('Correct-Horse-9!');
  const ids = [];
  for (let i = 0; i < 200; i += 1) {
    const p = await prisma.profile.create({ data: { organizationId: big.id, fullName: `Big ${i}`, username: `p3_big_${i}`, email: `p3_big_${i}@example.invalid`, role: 'TRAVEL_AGENT', status: 'ACTIVE', passwordHash, employmentStartDate: new Date(Date.now() - 100 * DAY) } });
    ids.push(p.id);
    if (i < 40) await prisma.supervisorAssignment.create({ data: { supervisorId: bigSup.id, agentId: p.id, assignedById: bigAdmin.id } });
  }
  await prisma.employeeSkill.createMany({ data: ids.flatMap((profileId, n) => skills.map((s, k) => ({ profileId, skillId: s.id, currentScore: 40 + ((n * 7 + k * 13) % 55), confidence: 65, confidenceLevel: 'MEDIUM', evidenceCount: 6, lastEvidenceAt: new Date(Date.now() - (n % 30) * DAY), lastAssessedAt: new Date() }))) });
  const rows = await prisma.employeeSkill.findMany({ where: { profile: { organizationId: big.id } }, select: { id: true, currentScore: true } });
  const ev = []; const hist = [];
  for (const r of rows) for (let e = 0; e < 5; e += 1) {
    const at = new Date(Date.now() - (e * 20 + 1) * DAY);
    ev.push({ employeeSkillId: r.id, sourceType: 'ASSESSMENT', assessmentType: 'QUIZ', difficulty: 3, scoreImpact: r.currentScore, weight: 1, createdAt: at });
    hist.push({ employeeSkillId: r.id, score: r.currentScore - e, confidence: 65, recordedAt: at });
  }
  for (let i = 0; i < ev.length; i += 2000) { await prisma.skillEvidence.createMany({ data: ev.slice(i, i + 2000) }); await prisma.skillScoreHistory.createMany({ data: hist.slice(i, i + 2000) }); }
  assert.ok(ev.length >= 8000);

  let t = Date.now();
  const intel = await organizationIntelligence(bigAdmin);
  const orgMs = Date.now() - t;
  assert.equal(intel.employees, 201);
  t = Date.now();
  const tint = await teamIntelligence(big.id, ids.slice(0, 40));
  const teamMs = Date.now() - t;
  assert.ok(tint.priority);
  t = Date.now();
  const orgPage = await get(bigAdmin, '/admin/intelligence');
  const pageMs = Date.now() - t;
  assert.equal(orgPage.status, 200);
  t = Date.now();
  const teamPage = await get(bigSup, '/team-skills');
  const teamPageMs = Date.now() - t;
  assert.equal(teamPage.status, 200);
  console.log(`   performance: org ${orgMs}ms, team(40) ${teamMs}ms, org page ${pageMs}ms, team page ${teamPageMs}ms over ${ev.length} evidence rows`);
  assert.ok(orgMs < 4000 && teamMs < 2000 && pageMs < 6000 && teamPageMs < 3000, 'intelligence screens must stay responsive');
});
