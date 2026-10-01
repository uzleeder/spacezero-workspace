'use strict';
// Phase 2 completion: guided-creation audience, organization passing minimum, configurable scoring
// and the full evidence trail, customer-call security (signed URLs, access logging, retention) and
// call-derived skill evidence. Gemini is mocked; nothing here calls the real service.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

mock.method(require('../lib/gemini'), 'generateStructured', async () => { throw new Error('Gemini must not be called in these tests'); });
mock.method(require('../lib/aiMedia'), 'withAiMedia', async (_path, _mime, run) => run({ text: 'x' }));

const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { hashPassword } = require('../lib/password');
const { getSetting, setSetting, isValidSetting, DEFAULT_SCORING } = require('../lib/orgSettings');
const { recomputeSkillScore, evidenceWeight } = require('../lib/scoring');
const { recordAssessmentAttempt } = require('../lib/practiceAttempts');
const { signMedia, verifyMedia } = require('../lib/signedUrl');
const { purgeExpiredCalls } = require('../lib/callRetention');
const { resolveStoragePath } = require('../lib/storage');
const app = require('../server');

let org, otherOrg, cookies = {};
let admin, sup, supB, agent, agentB, outsider, team, teamB, foreignTeam, foreignPerson;
const as = (p) => cookies[p.id];
const get = (p, url) => request(app).get(url).set('Cookie', as(p));
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', as(p)).type('form').send(body);
const denied = (res) => [403, 404].includes(res.status);
const audits = (action) => prisma.auditLog.findMany({ where: { organizationId: org.id, action } });
const isoIn = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const modules = JSON.stringify([{ title: 'Notes', contentType: 'NOTE', description: 'Keep the client engaged.' }]);

function wav() {
  const data = Buffer.alloc(44 + 16000); data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(16000, 40);
  return data;
}

before(async () => {
  org = await prisma.organization.create({ data: { name: 'P2 final tests' } });
  otherOrg = await prisma.organization.create({ data: { name: 'P2 other org' } });
  const passwordHash = await hashPassword('Correct-Horse-9!');
  async function user(role, name, organizationId = org.id) {
    const p = await prisma.profile.create({ data: { organizationId, fullName: `P2 ${name}`, username: `p2_${organizationId}_${name}`, email: `p2_${organizationId}_${name}@example.invalid`, role, status: 'ACTIVE', passwordHash, employmentStartDate: new Date() } });
    const token = generateToken();
    await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
    cookies[p.id] = `sz_session=${token.raw}`;
    return p;
  }
  admin = await user('ADMIN', 'admin'); sup = await user('SUPERVISOR', 'sup'); supB = await user('SUPERVISOR', 'supB');
  agent = await user('TRAVEL_AGENT', 'agent'); agentB = await user('TRAVEL_AGENT', 'agentB');
  outsider = await user('ADMIN', 'outsider', otherOrg.id); foreignPerson = await user('TRAVEL_AGENT', 'foreign', otherOrg.id);
  team = await prisma.team.create({ data: { organizationId: org.id, name: 'P2 Team' } });
  teamB = await prisma.team.create({ data: { organizationId: org.id, name: 'P2 Team B' } });
  foreignTeam = await prisma.team.create({ data: { organizationId: otherOrg.id, name: 'P2 Foreign Team' } });
  for (const [t, members] of [[team, [sup, agent]], [teamB, [supB, agentB]]]) for (const m of members) await prisma.teamMembership.create({ data: { teamId: t.id, profileId: m.id } });
  await prisma.supervisorAssignment.create({ data: { supervisorId: sup.id, agentId: agent.id, teamId: team.id, assignedById: admin.id } });
  await prisma.supervisorAssignment.create({ data: { supervisorId: supB.id, agentId: agentB.id, teamId: teamB.id, assignedById: admin.id } });
  for (const supervisor of [sup, supB]) await post(admin, '/admin/supervisor-permissions/' + supervisor.id, { capabilities: ['training.assign'] });
});
after(async () => { mock.restoreAll(); await prisma.$disconnect(); });

// ------------------------------------------------------------------ settings
test('organization settings are typed: out-of-range and unknown values are refused, bad stored values fall back to the default', async () => {
  assert.equal(await getSetting(org.id, 'training.minPassingScore'), 70);
  assert.equal(await getSetting(org.id, 'calls.retentionDays'), 0);
  assert.deepEqual(await getSetting(org.id, 'scoring.config'), DEFAULT_SCORING);
  await assert.rejects(() => setSetting(org.id, 'training.minPassingScore', 20, admin.id));
  await assert.rejects(() => setSetting(org.id, 'calls.retentionDays', -1, admin.id));
  await assert.rejects(() => setSetting(org.id, 'made.up', 1, admin.id));
  assert.equal(isValidSetting('scoring.config', { ...DEFAULT_SCORING, halfLifeDays: 1 }), false);
  assert.equal(isValidSetting('scoring.config', { ...DEFAULT_SCORING, sourceWeights: { ...DEFAULT_SCORING.sourceWeights, PRACTICE: 9 } }), false);
  await prisma.orgSetting.create({ data: { organizationId: org.id, key: 'training.minPassingScore', valueJson: '"garbage"' } });
  assert.equal(await getSetting(org.id, 'training.minPassingScore'), 70);
  await prisma.orgSetting.deleteMany({ where: { organizationId: org.id, key: 'training.minPassingScore' } });
});

test('the AI/calls/scoring policy form is Admin-only, validates every field before saving anything, and is audited', async () => {
  const body = { minPassingScore: '80', retentionDays: '30', halfLifeDays: '60', ...Object.fromEntries(Object.keys(DEFAULT_SCORING.sourceWeights).map((k) => [`source_${k}`, String(DEFAULT_SCORING.sourceWeights[k])])), ...Object.fromEntries([1, 2, 3, 4, 5].map((k) => [`difficulty_${k}`, String(DEFAULT_SCORING.difficultyWeights[k])])) };
  for (const who of [sup, agent]) assert.ok(denied(await post(who, '/admin/policies/ai', body)));
  assert.ok(denied(await post(sup, '/admin/policies/purge-calls')));
  const bad = await post(admin, '/admin/policies/ai', { ...body, minPassingScore: '40', retentionDays: '99999' });
  assert.equal(bad.status, 400); assert.match(bad.text, /outside its allowed range/);
  assert.match(bad.text, /value="40"/);
  assert.match(bad.text, /value="99999"/);
  assert.match(bad.text, /value="60"/);
  assert.doesNotMatch(bad.text, /Changes saved\./);
  assert.equal(await getSetting(org.id, 'training.minPassingScore'), 70); assert.equal(await getSetting(org.id, 'calls.retentionDays'), 0); // nothing was saved
  assert.equal((await post(admin, '/admin/policies/ai', body)).status, 302);
  assert.equal(await getSetting(org.id, 'training.minPassingScore'), 80);
  assert.equal(await getSetting(org.id, 'calls.retentionDays'), 30);
  assert.equal((await getSetting(org.id, 'scoring.config')).halfLifeDays, 60);
  const change = JSON.parse((await audits('policy.changed')).find((a) => a.targetId === 'training.minPassingScore').metadataJson);
  assert.deepEqual([change.from, change.to], [70, 80]);
  const page = await get(admin, '/admin/policies');
  assert.equal(page.status, 200); assert.match(page.text, /What is sent to the AI service/); assert.match(page.text, /value="80"/);
  assert.ok(denied(await get(sup, '/admin/policies')));
});

test('the organization minimum passing score applies to course creation, editing and assignments', async () => {
  // minimum is 80 from the previous test
  const low = await post(admin, '/admin/training/new', { title: 'P2 low', mandatory: '1', passingScore: '75', modulesJson: modules });
  assert.match(low.text, /organization minimum of 80%/); assert.equal(await prisma.trainingCourse.findFirst({ where: { organizationId: org.id, title: 'P2 low' } }), null);
  assert.equal((await post(admin, '/admin/training/new', { title: 'P2 ok', mandatory: '1', passingScore: '85', modulesJson: modules })).status, 302);
  const course = await prisma.trainingCourse.findFirst({ where: { organizationId: org.id, title: 'P2 ok' } });
  assert.equal(course.passingScore, 85);
  const edit = await post(admin, `/admin/training/${course.id}/edit`, { title: 'P2 ok', passingScore: '70', mandatory: ['0', '1'] });
  assert.match(edit.text, /organization minimum of 80%/); assert.equal((await prisma.trainingCourse.findUnique({ where: { id: course.id } })).passingScore, 85);
  await prisma.trainingCourse.update({ where: { id: course.id }, data: { status: 'PUBLISHED', assignPolicy: 'ALL_SUPERVISORS' } });
  const count = () => prisma.trainingAssignment.count({ where: { courseId: course.id } });
  assert.match((await post(admin, '/assignments', { courseId: course.id, scope: 'INDIVIDUAL', targetProfileIds: [agent.id], minimumScore: '75' })).text, /minimum score must be 80/);
  assert.equal(await count(), 0);
  assert.equal((await post(admin, '/assignments', { courseId: course.id, scope: 'INDIVIDUAL', targetProfileIds: [agent.id], minimumScore: '90' })).status, 302);
  assert.equal(await count(), 1);
  await setSetting(org.id, 'training.minPassingScore', 70, admin.id);
});

// ------------------------------------------------------------------ guided creation: audience
test('creation Step 1 stores an intended audience (roles, teams, employees) and a due date, checks every id, and pre-fills the assign form', async () => {
  const res = await post(admin, '/admin/training/new', { title: 'P2 audience', mandatory: '1', passingScore: '70', modulesJson: modules, audienceRoles: ['TRAVEL_AGENT', 'FLIGHT_EXPERT', 'NOT_A_ROLE'], audienceTeamIds: [team.id, foreignTeam.id], audienceProfileIds: [agentB.id, foreignPerson.id], dueDate: isoIn(30) });
  assert.equal(res.status, 302);
  const course = await prisma.trainingCourse.findFirst({ where: { organizationId: org.id, title: 'P2 audience' } });
  const audience = JSON.parse(course.audienceJson);
  assert.deepEqual(audience.roles, ['TRAVEL_AGENT', 'FLIGHT_EXPERT']);            // invalid role dropped
  assert.deepEqual(audience.teamIds, [team.id]);                                  // another organization's team dropped
  assert.deepEqual(audience.profileIds, [agentB.id]);                             // another organization's employee dropped
  assert.equal(course.defaultDueDate.toISOString().slice(0, 10), isoIn(30)); assert.equal(course.roleKey, null); // several roles: no single legacy role
  await prisma.trainingCourse.update({ where: { id: course.id }, data: { status: 'PUBLISHED', publishedVersion: 1 } }); // in Training, so its detail page is the Training one
  const detail = await get(admin, `/admin/training/${course.id}`);
  assert.match(detail.text, /Intended audience/); assert.match(detail.text, /Team: P2 Team/); assert.match(detail.text, /P2 agentB/); assert.doesNotMatch(detail.text, /P2 Foreign Team/);

  assert.match((await post(admin, '/admin/training/new', { title: 'P2 past', mandatory: '1', passingScore: '70', modulesJson: modules, dueDate: '2020-01-01' })).text, /cannot be in the past/);
  assert.match((await post(admin, '/admin/training/new', { title: 'P2 bad date', mandatory: '1', passingScore: '70', modulesJson: modules, dueDate: 'soon' })).text, /valid due date/);
  assert.equal(await prisma.trainingCourse.count({ where: { organizationId: org.id, title: { in: ['P2 past', 'P2 bad date'] } } }), 0);
  const single = await post(admin, '/admin/training/new', { title: 'P2 single role', mandatory: '1', passingScore: '70', modulesJson: modules, audienceRoles: 'FLIGHT_EXPERT' });
  assert.equal(single.status, 302);
  assert.equal((await prisma.trainingCourse.findFirst({ where: { title: 'P2 single role' } })).roleKey, 'FLIGHT_EXPERT');

  // edit the audience later
  await post(admin, `/admin/training/${course.id}/edit`, { title: 'P2 audience', passingScore: '70', mandatory: ['0', '1'], audienceForm: '1', audienceRoles: 'SUPERVISOR' });
  assert.deepEqual(JSON.parse((await prisma.trainingCourse.findUnique({ where: { id: course.id } })).audienceJson), { roles: ['SUPERVISOR'], teamIds: [], profileIds: [] });
  await post(admin, `/admin/training/${course.id}/edit`, { title: 'P2 audience', passingScore: '70', mandatory: ['0', '1'], audienceForm: '1', audienceRoles: ['TRAVEL_AGENT'], audienceTeamIds: team.id, dueDate: isoIn(20) });

  // the assign form starts from the audience and due date, and can pre-select an employee
  await prisma.trainingCourse.update({ where: { id: course.id }, data: { status: 'PUBLISHED', assignPolicy: 'ALL_SUPERVISORS' } });
  const form = await get(admin, `/assignments?courseId=${course.id}&personId=${agent.id}`);
  assert.match(form.text, /Intended audience:/); assert.match(form.text, new RegExp(`value="${isoIn(20)}"`));
  assert.match(form.text, new RegExp(`value="${agent.id}"\\s+checked`));
  // a supervisor cannot pre-select someone outside their own team
  const supForm = await get(sup, `/assignments?courseId=${course.id}&personId=${agentB.id}`);
  assert.equal(supForm.status, 200); assert.doesNotMatch(supForm.text, new RegExp(`value="${agentB.id}"`));
  assert.ok(denied(await post(sup, `/admin/training/${course.id}/edit`, { title: 'hijack', passingScore: '70' }))); // supervisors cannot edit training
});

// ------------------------------------------------------------------ scoring
test('every practice attempt stores the full evidence trail, and the Skill Graph score follows the configurable weights', async () => {
  const skill = await prisma.skill.create({ data: { organizationId: org.id, name: 'Objection Handling', category: 'Sales', roleKey: 'TRAVEL_AGENT' } });
  const course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'P2 scoring', createdById: admin.id, status: 'PUBLISHED' } });
  const assessment = await prisma.assessment.create({ data: { organizationId: org.id, courseId: course.id, createdVia: 'ADMIN_MANUAL', type: 'ROLEPLAY', title: 'P2 role-play', level: 5, status: 'APPROVED', createdById: admin.id, modelVersion: 'test-model' } });
  const assignment = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.id, scope: 'INDIVIDUAL' } });
  const recipient = await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: assignment.id, profileId: agent.id } });

  const first = await recordAssessmentAttempt({ actor: agent, assessment, recipientId: recipient.id, score: 69, passed: false, skillBreakdown: { 'Objection Handling': 40 }, sourceType: 'PRACTICE' });
  assert.equal(first.status, 'RETAKE_REQUIRED'); assert.equal(first.attemptNumber, 1);
  const second = await recordAssessmentAttempt({ actor: agent, assessment, recipientId: recipient.id, score: 82, passed: true, skillBreakdown: { 'Objection Handling': 90 }, sourceType: 'PRACTICE' });
  assert.equal(second.attemptNumber, 2); assert.equal(second.status, 'COMPLETED');
  assert.equal(await prisma.trainingAttempt.count({ where: { recipientId: recipient.id } }), 2); // both attempts are kept

  const es = await prisma.employeeSkill.findFirst({ where: { profileId: agent.id, skillId: skill.id } });
  const evidence = await prisma.skillEvidence.findMany({ where: { employeeSkillId: es.id }, orderBy: { createdAt: 'asc' } });
  assert.equal(evidence.length, 2);
  for (const e of evidence) {
    assert.equal(e.assessmentId, assessment.id); assert.equal(e.assessmentType, 'ROLEPLAY'); assert.equal(e.difficulty, 5); assert.equal(e.sourceType, 'PRACTICE');
    assert.equal(e.weight, evidenceWeight({ sourceType: 'PRACTICE', assessmentType: 'ROLEPLAY', difficulty: 5 })); assert.equal(e.weight, 1.69); // 1.3 (role-play) x 1.3 (level 5)
  }
  assert.deepEqual(evidence.map((e) => e.attemptNumber), [1, 2]); assert.deepEqual(evidence.map((e) => e.scoreImpact), [40, 90]);

  // the score is a transparent weighted average of ALL evidence — never overwritten by the AI
  const equalWeights = (await recomputeSkillScore(es.id)).currentScore;
  assert.ok(equalWeights > 40 && equalWeights < 90); assert.equal(equalWeights, 65); // equal weights and (almost) equal age
  // an old failed attempt matters less once the half-life is short
  await prisma.skillEvidence.update({ where: { id: evidence[0].id }, data: { createdAt: new Date(Date.now() - 120 * 86400000) } });
  const longHalfLife = (await recomputeSkillScore(es.id)).currentScore;
  await setSetting(org.id, 'scoring.config', { ...DEFAULT_SCORING, halfLifeDays: 7 }, admin.id);
  const shortHalfLife = (await recomputeSkillScore(es.id)).currentScore;
  assert.ok(shortHalfLife > longHalfLife, `${shortHalfLife} should exceed ${longHalfLife}`);
  // a heavier practice weight moves the score toward practical evidence
  await prisma.skillEvidence.create({ data: { employeeSkillId: es.id, sourceType: 'ASSESSMENT', scoreImpact: 20, notes: 'quiz', difficulty: 1 } });
  const withQuiz = (await recomputeSkillScore(es.id)).currentScore;
  await setSetting(org.id, 'scoring.config', { ...DEFAULT_SCORING, halfLifeDays: 7, sourceWeights: { ...DEFAULT_SCORING.sourceWeights, ASSESSMENT: 3 } }, admin.id);
  assert.ok((await recomputeSkillScore(es.id)).currentScore < withQuiz);
  await setSetting(org.id, 'scoring.config', DEFAULT_SCORING, admin.id);
  assert.equal(evidenceWeight({ sourceType: 'CALL_REVIEW', difficulty: null }), 1.3); assert.equal(evidenceWeight({ sourceType: 'ASSESSMENT', difficulty: 1 }), 0.8);
  // supervisors see weak skills with a way to assign practice; the learner does not get the manager link
  await prisma.employeeSkill.update({ where: { id: es.id }, data: { currentScore: 40, evidenceCount: 3 } });
  const managerView = await get(sup, `/employees/${agent.id}/skills`);
  assert.match(managerView.text, /Priority improvement/); assert.match(managerView.text, new RegExp(`/assignments\\?personId=${agent.id}`)); assert.match(managerView.text, /Critical/);
  assert.doesNotMatch((await get(agent, `/employees/${agent.id}/skills`)).text, /Priority improvement/);
  assert.ok(denied(await get(supB, `/employees/${agent.id}/skills`)));
  assert.match((await get(sup, '/team-skills')).text, /Assign practice/);
});

// ------------------------------------------------------------------ call security
async function uploadCall(mode = 'BEST_PRACTICE', extra = {}) {
  const res = await request(app).post('/ai-practice/calls').set('Cookie', as(admin)).attach('calls', wav(), { filename: `${Math.random()}.wav`, contentType: 'audio/wav' });
  assert.equal(res.status, 302, res.text);
  const id = new URL(res.headers.location, 'http://x').searchParams.get('saved');
  const started = await post(admin, `/ai-practice/calls/${id}/analyze`, { purpose: mode === 'INDIVIDUAL_AGENT' ? 'INDIVIDUAL' : 'BEST_PRACTICE', authorized: 'yes', ...(extra.targetAgentId ? { targetAgentId: extra.targetAgentId } : {}) });
  assert.equal(started.status, 302);
  return id;
}

test('call playback uses short-lived signed links bound to the person and the recording; views and plays are audit-logged', async () => {
  const id = await uploadCall();
  const batch = await prisma.callBatch.findUnique({ where: { id }, include: { recordings: true } });
  const recording = batch.recordings[0];
  const page = await get(admin, `/ai-practice/calls/${id}`);
  assert.equal(page.status, 200); assert.match(page.headers['cache-control'], /no-store/);
  const link = page.text.match(/src="([^"]*\/recordings\/[^"]+)"/)[1].replace(/&amp;/g, '&');
  assert.match(link, /exp=\d+&sig=/);
  assert.ok((await audits('calls.viewed')).some((a) => a.targetId === id));

  const path = `/ai-practice/calls/${id}/recordings/${recording.id}`;
  assert.equal((await get(admin, path)).status, 403);                                   // no signature at all
  assert.equal((await get(admin, `${path}?exp=1&sig=abc`)).status, 403);                // forged / expired
  const ok = await get(admin, link);
  assert.equal(ok.status, 200); assert.match(ok.headers['cache-control'], /no-store/);
  assert.ok((await audits('calls.played')).some((a) => a.targetId === recording.id));
  // someone else cannot reuse it, even holding the link and a valid session
  assert.ok(denied(await request(app).get(link).set('Cookie', as(sup))));
  assert.ok(denied(await request(app).get(link).set('Cookie', as(agent))));
  assert.equal((await request(app).get(link)).status === 200, false);                   // and it needs a session
  assert.ok(denied(await request(app).get(link).set('Cookie', as(outsider))));
  // signatures are bound to one recording and one person, and they expire
  assert.equal(verifyMedia('call-recording', recording.id, admin.id, Object.fromEntries(new URLSearchParams(signMedia('call-recording', recording.id, admin.id)))), true);
  const q = (s) => Object.fromEntries(new URLSearchParams(s));
  assert.equal(verifyMedia('call-recording', 'other-recording', admin.id, q(signMedia('call-recording', recording.id, admin.id))), false);
  assert.equal(verifyMedia('call-recording', recording.id, sup.id, q(signMedia('call-recording', recording.id, admin.id))), false);
  assert.equal(verifyMedia('call-recording', recording.id, admin.id, q(signMedia('call-recording', recording.id, admin.id, 300, Date.now() - 400000))), false);
  assert.equal(verifyMedia('other-purpose', recording.id, admin.id, q(signMedia('call-recording', recording.id, admin.id))), false);
  assert.ok(!page.text.includes(recording.storagePath)); // the private storage path is never exposed
});

test('customer-call retention deletes only finished batches older than the configured period, removes the files, and is audited', async () => {
  const oldId = await uploadCall(); const freshId = await uploadCall(); const busyId = await uploadCall();
  const old = await prisma.callBatch.findUnique({ where: { id: oldId }, include: { recordings: true } });
  const oldFile = resolveStoragePath(old.recordings[0].storagePath);
  assert.ok(fs.existsSync(oldFile));
  await prisma.callBatch.updateMany({ where: { id: { in: [oldId, busyId] } }, data: { createdAt: new Date(Date.now() - 100 * 86400000) } });
  await prisma.callBatch.updateMany({ where: { id: { in: [oldId, freshId] } }, data: { status: 'READY_FOR_REVIEW' } });
  await prisma.callBatch.update({ where: { id: busyId }, data: { status: 'TRANSCRIBING' } });

  await setSetting(org.id, 'calls.retentionDays', 0, admin.id);
  assert.equal(await purgeExpiredCalls(org.id), 0); assert.ok(await prisma.callBatch.findUnique({ where: { id: oldId } })); // 0 = keep
  await setSetting(org.id, 'calls.retentionDays', 30, admin.id);
  assert.equal(await purgeExpiredCalls(org.id, { actorId: admin.id }), 1);
  assert.equal(await prisma.callBatch.findUnique({ where: { id: oldId } }), null); assert.equal(fs.existsSync(oldFile), false);
  assert.ok(await prisma.callBatch.findUnique({ where: { id: freshId } }));   // younger than the period
  assert.ok(await prisma.callBatch.findUnique({ where: { id: busyId } }));    // still processing: never purged mid-flight
  assert.deepEqual(JSON.parse((await audits('calls.retention_purged')).at(-1).metadataJson), { count: 1, retentionDays: 30 });
  await prisma.callBatch.update({ where: { id: freshId }, data: { createdAt: new Date(Date.now() - 100 * 86400000) } });
  assert.ok(denied(await post(sup, '/admin/policies/purge-calls')));
  assert.equal((await post(admin, '/admin/policies/purge-calls')).headers.location, '/admin/policies?purged=1'); // the Admin can run it on demand
  assert.equal(await prisma.callBatch.findUnique({ where: { id: freshId } }), null);
  await setSetting(org.id, 'calls.retentionDays', 0, admin.id);
});

// ------------------------------------------------------------------ call analysis -> skill evidence
const report = { title: 'Coaching from calls', summary: 'Repeated: price objections are met with discounts.', strengths: ['Discovery'], weaknesses: ['Objection handling'], objectives: ['Hold price with value'], skills: [{ name: 'Objection Handling', score: 35, evidence: 'Discounted in 3 of 4 calls' }, { name: 'Discovery Questions', score: 88, evidence: 'Asked about flexibility every call' }, { name: 'Not A Real Skill', score: 10, evidence: 'x' }], moments: [], practices: ['ROLEPLAY'] };

test('an approved individual-agent call analysis is stored as CALL_REVIEW evidence for the coached agent only; best-practice calls write none', async () => {
  const objection = await prisma.skill.findFirst({ where: { organizationId: org.id, name: 'Objection Handling' } });
  await prisma.skill.create({ data: { organizationId: org.id, name: 'Discovery Questions', category: 'Sales', roleKey: 'TRAVEL_AGENT' } });
  const make = async (mode, target) => {
    const id = await uploadCall(mode, target ? { targetAgentId: target } : {});
    await prisma.callBatch.update({ where: { id }, data: { status: 'READY_FOR_REVIEW', aggregatedAnalysisJson: JSON.stringify(report) } });
    return id;
  };
  const individual = await make('INDIVIDUAL_AGENT', agent.id);
  assert.ok(denied(await post(sup, `/ai-practice/calls/${individual}/approve`, { methods: 'ROLEPLAY' })));
  assert.equal(await prisma.skillEvidence.count({ where: { sourceId: individual } }), 0); // nothing before a human approves
  const before = await prisma.employeeSkill.findFirst({ where: { profileId: agent.id, skillId: objection.id } });
  assert.equal((await post(admin, `/ai-practice/calls/${individual}/approve`, { methods: 'ROLEPLAY' })).status, 302);
  const evidence = await prisma.skillEvidence.findMany({ where: { sourceId: individual }, include: { employeeSkill: { include: { skill: true, profile: true } } } });
  assert.deepEqual(evidence.map((e) => e.employeeSkill.skill.name).sort(), ['Discovery Questions', 'Objection Handling']); // the made-up skill is not written
  assert.ok(evidence.every((e) => e.sourceType === 'CALL_REVIEW' && e.employeeSkill.profile.id === agent.id && e.recordedById === admin.id && e.assessmentType === 'CALL_ANALYSIS' && e.weight === 1.3));
  assert.match(evidence.find((e) => e.employeeSkill.skill.name === 'Objection Handling').notes, /Discounted in 3 of 4 calls/);
  const after = await prisma.employeeSkill.findFirst({ where: { profileId: agent.id, skillId: objection.id } });
  assert.ok(after.evidenceCount > (before ? before.evidenceCount : 0)); assert.equal(await prisma.skillEvidence.count({ where: { employeeSkillId: after.id, sourceType: 'CALL_REVIEW' } }), 1);
  assert.equal(JSON.parse((await audits('calls.approved')).at(-1).metadataJson).evidenceWritten, 2);
  assert.equal((await prisma.callBatch.findUnique({ where: { id: individual } })).status, 'APPROVED');
  assert.equal((await post(admin, `/ai-practice/calls/${individual}/approve`, { methods: 'ROLEPLAY' })).status, 409); // approving twice cannot double-count

  const best = await make('BEST_PRACTICE', null);
  assert.equal((await post(admin, `/ai-practice/calls/${best}/approve`, { methods: 'ROLEPLAY' })).status, 302);
  assert.equal(await prisma.skillEvidence.count({ where: { sourceId: best } }), 0);
  assert.equal(await prisma.skillEvidence.count({ where: { employeeSkill: { profileId: agentB.id }, sourceType: 'CALL_REVIEW' } }), 0);
});
