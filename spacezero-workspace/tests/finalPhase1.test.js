'use strict';
// Final Phase 1 correction: AI Practice is Admin-only end to end, the admin review tools, multi-team /
// role-group assignment, the compact View As control, the real Above9 directory and team hierarchy.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Gemini is mocked BEFORE anything that imports it, so no test ever calls the real service.
let aiCalls = [];
let aiFail = false;
let aiAnswer = null;
mock.method(require('../lib/gemini'), 'generateStructured', async (input) => {
  aiCalls.push(input);
  if (aiFail) throw new Error('Provider unavailable');
  return { modelVersion: 'test', data: aiAnswer(input) };
});

const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { hashPassword } = require('../lib/password');
const { applyDirectory, directoryPeople, TEAMS } = require('../prisma/directory');
const { loadSetupForProfiles, ensureDefaultRequirements } = require('../lib/employeeSetup');
const app = require('../server');

let org, otherOrg, cookies = {};
let admin, admin2, supA, supB, agentA, agentB, expertA, outsider, teamA, teamB, course, quiz, roleplay;
const as = (p) => cookies[p.id];
const get = (p, url) => request(app).get(url).set('Cookie', as(p));
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', as(p)).type('form').send(body);
const denied = (res) => [403, 404].includes(res.status);
const q = (assessmentId) => prisma.question.findMany({ where: { assessmentId }, orderBy: { displayOrder: 'asc' } });
const audits = (action) => prisma.auditLog.findMany({ where: { organizationId: org.id, action } });

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Final P1 tests' } });
  otherOrg = await prisma.organization.create({ data: { name: 'Final P1 other org' } });
  const passwordHash = await hashPassword('Correct-Horse-9!');
  async function user(role, name, organizationId = org.id) {
    const p = await prisma.profile.create({ data: { organizationId, fullName: `F1 ${name}`, username: `f1_${organizationId}_${name}`, email: `f1_${organizationId}_${name}@example.invalid`, role, status: 'ACTIVE', passwordHash, employmentStartDate: new Date() } });
    const token = generateToken();
    await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
    cookies[p.id] = `sz_session=${token.raw}`;
    return p;
  }
  admin = await user('ADMIN', 'admin'); admin2 = await user('ADMIN', 'admin2');
  supA = await user('SUPERVISOR', 'supA'); supB = await user('SUPERVISOR', 'supB');
  for (const supervisor of [supA, supB]) await post(admin, '/admin/supervisor-permissions/' + supervisor.id, { capabilities: ['setup.view', 'setup.manage', 'setup.verify', 'training.assign'] });
  agentA = await user('TRAVEL_AGENT', 'agentA'); agentB = await user('TRAVEL_AGENT', 'agentB'); expertA = await user('FLIGHT_EXPERT', 'expertA');
  outsider = await user('ADMIN', 'outsider', otherOrg.id);
  teamA = await prisma.team.create({ data: { organizationId: org.id, name: 'F1 Team A' } });
  teamB = await prisma.team.create({ data: { organizationId: org.id, name: 'F1 Team B' } });
  for (const [team, members] of [[teamA, [supA, agentA]], [teamB, [supB, agentB]]]) for (const m of members) await prisma.teamMembership.create({ data: { teamId: team.id, profileId: m.id } });
  await prisma.supervisorAssignment.create({ data: { supervisorId: supA.id, agentId: agentA.id, teamId: teamA.id, assignedById: admin.id } });
  await prisma.supervisorAssignment.create({ data: { supervisorId: supB.id, agentId: agentB.id, teamId: teamB.id, assignedById: admin.id } });

  course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'F1 course', createdById: admin.id, status: 'DRAFT' } });
  await prisma.trainingAnalysis.create({ data: { courseId: course.id, status: 'APPROVED', criticalKnowledgeJson: '[]', practicalBehaviorsJson: '[]', commonMistakesJson: '[]', extractedSkillsJson: '["Discovery"]' } });
  quiz = await prisma.assessment.create({ data: { organizationId: org.id, courseId: course.id, createdVia: 'AI_TRAINING_ANALYSIS', type: 'QUIZ', title: 'F1 quiz', level: 3, passingScore: 70, status: 'AI_GENERATED', createdById: admin.id } });
  for (const [i, prompt] of ['First question?', 'Second question?', 'Third question?'].entries()) {
    await prisma.question.create({ data: { assessmentId: quiz.id, type: 'MCQ', prompt, optionsJson: JSON.stringify(['Yes', 'No']), correctAnswerJson: JSON.stringify('Yes'), explanation: 'Because.', skillIdsJson: '[]', displayOrder: i } });
  }
  roleplay = await prisma.assessment.create({ data: { organizationId: org.id, courseId: course.id, createdVia: 'AI_TRAINING_ANALYSIS', type: 'ROLEPLAY', title: 'F1 role-play', level: 3, passingScore: 70, status: 'AI_GENERATED', createdById: admin.id, configJson: JSON.stringify({ customerPersonality: 'busy executive', scenarioBrief: 'A client wants a business class fare.', openingLine: 'I only have two minutes.', rubricSkills: ['Opening', 'Discovery', 'Closing'] }) } });
});
after(async () => { mock.restoreAll(); await prisma.$disconnect(); });

// ------------------------------------------------------------------ AI Practice: Admin only
test('AI Practice is Admin-only across pages, forms and APIs; supervisors, agents and experts are rejected server-side', async () => {
  const batch = await prisma.callBatch.create({ data: { organizationId: org.id, uploadedById: admin.id, mode: 'BEST_PRACTICE', status: 'UPLOADED' } });
  const material = await prisma.practiceMaterial.create({ data: { organizationId: org.id, profileId: admin.id, title: 'F1 upload', materialType: 'NOTE', noteContent: 'x' } });
  const gets = ['/ai-practice', '/ai-practice?section=review', '/ai-practice/new', '/ai-practice/calls', `/ai-practice/calls/${batch.id}`, `/ai-practice/calls/${batch.id}/recordings/none`, '/admin/training/new', `/admin/training/${course.id}/analysis`, `/admin/training/${course.id}/practice-plan`, `/admin/assessments/${quiz.id}`, `/admin/assessments/${quiz.id}/preview`, `/ai-practice/${material.id}/file`];
  const posts = ['/ai-practice', '/ai-practice/calls', `/ai-practice/calls/${batch.id}/retry`, `/ai-practice/calls/${batch.id}/approve`, `/ai-practice/calls/${batch.id}/delete`, '/admin/training/new', `/admin/training/${course.id}/analyze`, `/admin/training/${course.id}/analysis/approve`, `/admin/training/${course.id}/analysis/regenerate`, `/admin/training/${course.id}/practice-plan`, `/admin/training/${course.id}/send-to-training`, `/admin/training/${course.id}/edit`, `/admin/training/${course.id}/publish`, `/admin/assessments/${quiz.id}/approve`, `/admin/assessments/${quiz.id}/update`, `/admin/assessments/${quiz.id}/revise`, `/admin/assessments/${quiz.id}/questions`, `/admin/assessments/${quiz.id}/delete`, `/ai-practice/${material.id}/archive`];
  for (const who of [supA, agentA, expertA]) {
    for (const url of gets) assert.ok(denied(await get(who, url)), `${who.role} GET ${url}`);
    for (const url of posts) assert.ok(denied(await post(who, url)), `${who.role} POST ${url}`);
  }
  assert.equal((await get(admin, '/ai-practice')).status, 200);
  assert.equal((await get(admin, '/ai-practice/new')).status, 200);
  assert.equal((await get(admin, `/admin/assessments/${quiz.id}`)).status, 200);
  assert.equal((await prisma.assessment.findUnique({ where: { id: quiz.id } })).status, 'AI_GENERATED'); // nothing changed
  // another organization's admin cannot reach these objects by ID either
  for (const url of [`/admin/assessments/${quiz.id}`, `/admin/training/${course.id}/analysis`, `/ai-practice/calls/${batch.id}`]) assert.equal((await get(outsider, url)).status, 404, url);
  // navigation offers AI Practice to the admin only
  assert.match((await get(admin, '/dashboard')).text, />AI Practice</);
  for (const who of [supA, agentA, expertA]) assert.doesNotMatch((await get(who, '/dashboard')).text, /href="\/ai-practice"/);
});

// ------------------------------------------------------------------ review before training
test('review: an Admin edits settings, adds, edits and removes questions; the passing-score floor holds; approval needs questions', async () => {
  const bad = await post(admin, `/admin/assessments/${quiz.id}/update`, { title: 'F1 quiz', level: '3', passingScore: '60', instructions: '' });
  assert.equal(bad.status, 400); assert.match(bad.text, /between 70 and 100/);
  assert.equal((await post(admin, `/admin/assessments/${quiz.id}/update`, { title: 'F1 quiz v2', level: '4', passingScore: '80', instructions: 'Read carefully.' })).status, 302);
  let row = await prisma.assessment.findUnique({ where: { id: quiz.id } });
  assert.equal(row.title, 'F1 quiz v2'); assert.equal(row.level, 4); assert.equal(row.passingScore, 80); assert.equal(row.instructions, 'Read carefully.');

  // add: validation, then a good single-choice, true/false and short-answer question
  assert.equal((await post(admin, `/admin/assessments/${quiz.id}/questions`, { type: 'MCQ', prompt: 'Pick', options: 'A\nB', correctAnswer: 'C' })).status, 400);
  assert.equal((await post(admin, `/admin/assessments/${quiz.id}/questions`, { type: 'MCQ', prompt: 'Pick', options: 'A\nA', correctAnswer: 'A' })).status, 400);
  assert.equal((await post(admin, `/admin/assessments/${quiz.id}/questions`, { type: 'MCQ', prompt: 'Which fare class is Business?', options: 'J\nY\nF', correctAnswer: 'j', skills: 'Fare Rules' })).status, 302);
  assert.equal((await post(admin, `/admin/assessments/${quiz.id}/questions`, { type: 'TRUE_FALSE', prompt: 'Upgrades are always free.', correctAnswer: 'False' })).status, 302);
  assert.equal((await post(admin, `/admin/assessments/${quiz.id}/questions`, { type: 'SHORT_ANSWER', prompt: 'Name the IATA code for London Heathrow.', correctAnswer: 'LHR' })).status, 302);
  assert.equal((await post(admin, `/admin/assessments/${quiz.id}/questions`, { type: 'ORDERING', prompt: 'Order', options: 'a\nb', correctAnswer: 'a' })).status, 400); // AI-only structures
  let list = await q(quiz.id);
  assert.equal(list.length, 6);
  const added = list[3];
  assert.equal(JSON.parse(added.correctAnswerJson), 'J'); assert.deepEqual(JSON.parse(added.skillIdsJson), ['Fare Rules']);

  // edit one question: only that row changes, its type never does
  const before2 = list.map((x) => x.prompt);
  assert.equal((await post(admin, `/admin/assessments/${quiz.id}/questions/${added.id}`, { type: 'TRUE_FALSE', prompt: 'Which cabin code is Business?', options: 'J\nY\nF', correctAnswer: 'J' })).status, 302);
  list = await q(quiz.id);
  assert.equal(list[3].prompt, 'Which cabin code is Business?'); assert.equal(list[3].type, 'MCQ');
  assert.deepEqual(list.map((x) => x.prompt).filter((_, i) => i !== 3), before2.filter((_, i) => i !== 3));

  // remove one: the rest are renumbered
  assert.equal((await post(admin, `/admin/assessments/${quiz.id}/questions/${list[0].id}/delete`)).status, 302);
  list = await q(quiz.id);
  assert.equal(list.length, 5); assert.deepEqual(list.map((x) => x.displayOrder), [0, 1, 2, 3, 4]);

  // a question ID from another assessment (or org) is just a missing record
  const otherQuestion = await prisma.question.create({ data: { assessmentId: roleplay.id, type: 'MCQ', prompt: 'Foreign', optionsJson: '["a","b"]', correctAnswerJson: '"a"', displayOrder: 0 } });
  assert.equal((await post(admin, `/admin/assessments/${quiz.id}/questions/${otherQuestion.id}`, { prompt: 'Hijack', options: 'a\nb', correctAnswer: 'a' })).status, 404);
  assert.equal((await post(admin, `/admin/assessments/${quiz.id}/questions/${otherQuestion.id}/delete`)).status, 404);
  assert.equal((await prisma.question.findUnique({ where: { id: otherQuestion.id } })).prompt, 'Foreign');
  await prisma.question.delete({ where: { id: otherQuestion.id } });

  // approval needs at least one question
  const empty = await prisma.assessment.create({ data: { organizationId: org.id, courseId: course.id, createdVia: 'ADMIN_MANUAL', type: 'QUIZ', title: 'Empty', status: 'AI_GENERATED', createdById: admin.id } });
  assert.equal((await post(admin, `/admin/assessments/${empty.id}/approve`)).status, 409);
  assert.equal((await prisma.assessment.findUnique({ where: { id: empty.id } })).status, 'AI_GENERATED');
  for (const action of ['assessment.edited', 'assessment.question_added', 'assessment.question_edited', 'assessment.question_removed']) assert.ok((await audits(action)).length >= 1, action);
});

test('review: replacing one question with the AI touches only that question and passes the Admin instruction', async () => {
  const list = await q(quiz.id);
  const target = list[1];
  aiCalls = [];
  aiAnswer = () => ({ type: 'MCQ', prompt: 'Which baggage rule applies to Business on this route?', options: ['2 x 32kg', '1 x 23kg'], correctAnswer: '2 x 32kg', explanation: 'Per fare rules.', skillNames: ['Fare Rules'] });
  const res = await post(admin, `/admin/assessments/${quiz.id}/questions/${target.id}/regenerate`, { instruction: 'Make it about baggage rules' });
  assert.equal(res.status, 302);
  assert.equal(aiCalls.length, 1); assert.match(aiCalls[0].contents[0].parts[0].text, /Make it about baggage rules/);
  const after2 = await q(quiz.id);
  assert.equal(after2[1].id, target.id); assert.match(after2[1].prompt, /baggage/);
  assert.deepEqual(after2.filter((_, i) => i !== 1).map((x) => x.prompt), list.filter((_, i) => i !== 1).map((x) => x.prompt));
  // an AI failure changes nothing
  aiFail = true;
  const failed = await post(admin, `/admin/assessments/${quiz.id}/questions/${target.id}/regenerate`, { instruction: 'again' });
  aiFail = false;
  assert.equal(failed.status, 502); assert.match(failed.text, /Nothing was changed/);
  assert.match((await q(quiz.id))[1].prompt, /baggage/);
});

test('review: "give the AI another prompt" rewrites only what changed, revises role-play scenarios, and edits send an approved practice back to review', async () => {
  const list = await q(quiz.id);
  aiCalls = [];
  aiAnswer = () => ({ questions: list.map((row, i) => ({ type: row.type, prompt: i === 2 ? 'Handle the objection: "It is too expensive".' : row.prompt, options: JSON.parse(row.optionsJson || 'null') || undefined, correctAnswer: JSON.parse(row.correctAnswerJson), explanation: row.explanation || undefined, skillNames: [] })) });
  assert.equal((await post(admin, `/admin/assessments/${quiz.id}/revise`, { instruction: 'x' })).status, 400); // too short to be an instruction
  assert.equal((await post(admin, `/admin/assessments/${quiz.id}/revise`, { instruction: 'Add more objection handling.' })).status, 302);
  assert.match(aiCalls[0].contents[0].parts[0].text, /Add more objection handling/);
  const revised = await q(quiz.id);
  assert.match(revised[2].prompt, /objection/);
  assert.deepEqual(revised.filter((_, i) => i !== 2).map((x) => x.id), list.filter((_, i) => i !== 2).map((x) => x.id)); // untouched rows keep their identity
  const meta = JSON.parse((await audits('assessment.revised_with_prompt')).at(-1).metadataJson);
  assert.equal(meta.changed, 1);

  // role-play: revise the scenario, edit rubric by hand, preview the learner view
  aiAnswer = () => ({ customerPersonality: 'sceptical executive who keeps interrupting', scenarioBrief: 'A harder scenario with a price objection.', openingLine: 'Just give me the cheapest.', rubricSkills: ['Objection handling', 'Call control', 'Closing'] });
  assert.equal((await post(admin, `/admin/assessments/${roleplay.id}/revise`, { instruction: 'Make this role-play harder.' })).status, 302);
  let config = JSON.parse((await prisma.assessment.findUnique({ where: { id: roleplay.id } })).configJson);
  assert.match(config.customerPersonality, /sceptical/); assert.deepEqual(config.rubricSkills, ['Objection handling', 'Call control', 'Closing']);
  assert.equal((await post(admin, `/admin/assessments/${roleplay.id}/update`, { title: 'F1 role-play', level: '5', passingScore: '75', scenarioBrief: 'Short', openingLine: 'Hello', customerPersonality: 'calm', rubricSkills: 'Opening\nClosing' })).status, 400); // fewer than three rubric skills
  assert.equal((await post(admin, `/admin/assessments/${roleplay.id}/update`, { title: 'F1 role-play', level: '5', passingScore: '75', scenarioBrief: 'Keep the caller engaged.', openingLine: 'Hello', customerPersonality: 'calm', rubricSkills: 'Opening\nEngagement\nClosing' })).status, 302);
  config = JSON.parse((await prisma.assessment.findUnique({ where: { id: roleplay.id } })).configJson);
  assert.deepEqual(config.rubricSkills, ['Opening', 'Engagement', 'Closing']);
  const preview = await get(admin, `/admin/assessments/${roleplay.id}/preview`);
  assert.equal(preview.status, 200); assert.match(preview.text, /Keep the caller engaged/); assert.match(preview.text, /Nothing you do here is recorded/);
  const quizPreview = await get(admin, `/admin/assessments/${quiz.id}/preview`);
  assert.equal(quizPreview.status, 200); assert.doesNotMatch(quizPreview.text, /Correct answer/); assert.doesNotMatch(quizPreview.text, /Because\./);

  // approve, then any edit reopens review
  assert.equal((await post(admin, `/admin/assessments/${quiz.id}/approve`)).status, 302);
  let row = await prisma.assessment.findUnique({ where: { id: quiz.id } });
  assert.equal(row.status, 'APPROVED'); assert.equal(row.approvedById, admin.id);
  await post(admin, `/admin/assessments/${quiz.id}/update`, { title: 'F1 quiz v3', level: '4', passingScore: '80', instructions: 'Read carefully.' });
  row = await prisma.assessment.findUnique({ where: { id: quiz.id } });
  assert.equal(row.status, 'AI_GENERATED'); assert.equal(row.approvedById, null);
  // approved practice is still a DRAFT-course concern: nothing became assignable
  assert.equal((await prisma.trainingCourse.findUnique({ where: { id: course.id } })).status, 'DRAFT');
});

// ------------------------------------------------------------------ assignment: teams / role groups
test('an Admin assigns to several teams or a whole role group; supervisors stay inside their own team and cannot use role groups', async () => {
  const published = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'F1 published', createdById: admin.id, status: 'PUBLISHED', assignPolicy: 'ALL_SUPERVISORS' } });
  const count = () => prisma.trainingAssignment.count({ where: { courseId: published.id } });
  const recipients = () => prisma.trainingAssignmentRecipient.findMany({ where: { assignment: { courseId: published.id } } });

  const both = await post(admin, '/assignments', { courseId: published.id, scope: 'TEAM', targetTeamIds: [teamA.id, teamB.id] });
  assert.equal(both.status, 302);
  assert.equal(await count(), 2);
  assert.deepEqual((await recipients()).map((r) => r.profileId).sort(), [supA.id, agentA.id, supB.id, agentB.id].sort());

  const role = await post(admin, '/assignments', { courseId: published.id, scope: 'ROLE', targetRole: 'FLIGHT_EXPERT' });
  assert.equal(role.status, 302);
  const roleAssignment = await prisma.trainingAssignment.findFirst({ where: { courseId: published.id, scope: 'ROLE' } });
  assert.equal(roleAssignment.targetRole, 'FLIGHT_EXPERT');
  assert.deepEqual((await prisma.trainingAssignmentRecipient.findMany({ where: { assignmentId: roleAssignment.id } })).map((r) => r.profileId), [expertA.id]);
  assert.equal((await post(admin, '/assignments', { courseId: published.id, scope: 'ROLE' })).text.includes('Choose a role group'), true);

  // supervisors: own team only, no role group, no company-wide, no foreign team IDs
  const before2 = await count();
  assert.ok(denied(await post(supA, '/assignments', { courseId: published.id, scope: 'ROLE', targetRole: 'TRAVEL_AGENT' })));
  assert.ok(denied(await post(supA, '/assignments', { courseId: published.id, scope: 'COMPANY' })));
  assert.ok(denied(await post(supA, '/assignments', { courseId: published.id, scope: 'TEAM', targetTeamIds: [teamA.id, teamB.id] })));
  assert.ok(denied(await post(supA, '/assignments', { courseId: published.id, scope: 'TEAM', targetTeamId: teamB.id })));
  assert.ok(denied(await post(supA, '/assignments', { courseId: published.id, scope: 'INDIVIDUAL', targetProfileIds: [agentB.id] })));
  assert.equal(await count(), before2);
  assert.equal((await post(supA, '/assignments', { courseId: published.id, scope: 'TEAM', targetTeamIds: [teamA.id] })).status, 302);
  assert.equal(await count(), before2 + 1);
  assert.ok(denied(await post(outsider, '/assignments', { courseId: published.id, scope: 'TEAM', targetTeamIds: [teamA.id] })));
  assert.match((await get(admin, '/assignments')).text, /A role group/);
  assert.doesNotMatch((await get(supA, '/assignments')).text, /A role group/);
});

// ------------------------------------------------------------------ View As
test('View As is one compact dropdown with four roles; only admins can use it and no one can elevate themselves', async () => {
  const page = await get(admin, '/dashboard');
  assert.match(page.text, /data-viewas/); assert.doesNotMatch(page.text, /sidebar-loginas-link/);
  for (const label of ['Admin', 'Supervisor', 'Travel Agent', 'Flight Expert']) assert.match(page.text, new RegExp(`<a role="menuitem" href="/admin/login-as\\?role=[A-Z_]+"><span>${label}</span>`));
  for (const who of [supA, agentA, expertA]) {
    assert.doesNotMatch((await get(who, '/dashboard')).text, /data-viewas/);
    for (const role of ['ADMIN', 'SUPERVISOR', 'TRAVEL_AGENT', 'FLIGHT_EXPERT']) assert.ok(denied(await get(who, `/admin/login-as?role=${role}`)));
    assert.ok(denied(await post(who, `/admin/login-as/${admin2.id}`)));
    assert.ok(denied(await post(who, `/admin/login-as/${supA.id}`)));
  }
  assert.ok(denied(await post(admin, `/admin/login-as/${admin2.id}`))); // an admin can never "become" another admin
  assert.ok(denied(await post(outsider, `/admin/login-as/${agentA.id}`))); // nor reach another organization
  const before2 = await prisma.session.count({ where: { profileId: { in: [supA.id, agentA.id] } } });
  // while viewing as a supervisor the session is the supervisor's: admin powers are gone
  const adminRaw = cookies[admin.id].replace('sz_session=', '');
  const asSupervisor = `${cookies[supA.id]}; sz_admin_session=${adminRaw}`;
  assert.ok(denied(await request(app).get('/admin/setup-requirements').set('Cookie', asSupervisor)));
  assert.ok(denied(await request(app).post(`/admin/login-as/${admin2.id}`).set('Cookie', asSupervisor).type('form').send({})));
  assert.equal(await prisma.session.count({ where: { profileId: { in: [supA.id, agentA.id] } } }), before2);
});

// ------------------------------------------------------------------ real directory
test('the real Above9 directory: 3 admins, 5 supervisors, 3 flight experts, 34 agents, exact e-mails and teams, no duplicates, idempotent', async () => {
  const dirOrg = await prisma.organization.create({ data: { name: 'Directory tests' } });
  // Pre-existing state the import must reconcile without duplicating anyone:
  //  - Joe Godwin already exists with a different e-mail; Luis Smith sits in the wrong team under the wrong supervisor.
  const joe = await prisma.profile.create({ data: { organizationId: dirOrg.id, fullName: 'Joe Godwin', username: 'joe-existing', email: 'joe.godwin@above9.travel', role: 'ADMIN', status: 'ACTIVE', passwordHash: 'x', employmentStartDate: new Date() } });
  const teamDavid = await prisma.team.create({ data: { organizationId: dirOrg.id, name: 'Team David' } });
  const luis = await prisma.profile.create({ data: { organizationId: dirOrg.id, fullName: 'Luis Smith', username: 'luis-existing', email: 'luis.smith@above9.travel', role: 'TRAVEL_AGENT', status: 'INVITED', employmentStartDate: new Date() } });
  await prisma.teamMembership.create({ data: { teamId: teamDavid.id, profileId: luis.id } });
  const david = await prisma.profile.create({ data: { organizationId: dirOrg.id, fullName: 'David Nelson', username: 'david-existing', email: 'david.nelson@above9.travel', role: 'SUPERVISOR', status: 'ACTIVE', passwordHash: 'x', employmentStartDate: new Date() } });
  await prisma.supervisorAssignment.create({ data: { supervisorId: david.id, agentId: luis.id, teamId: teamDavid.id } });

  const dry = await applyDirectory(prisma, dirOrg.id, { dryRun: true });
  assert.equal(await prisma.profile.count({ where: { organizationId: dirOrg.id } }), 3); // dry run wrote nothing
  assert.equal(dry.created.length, 45 - 3);

  const report = await applyDirectory(prisma, dirOrg.id);
  assert.equal(report.created.length, 42); assert.equal(report.conflicts.length, 0);
  assert.deepEqual(report.emailFixed, ['Joe Godwin: joe.godwin@above9.travel → joe.goodwin@above9.travel']);
  const people = await prisma.profile.findMany({ where: { organizationId: dirOrg.id } });
  const by = (role) => people.filter((p) => p.role === role);
  assert.equal(by('ADMIN').length, 3); assert.equal(by('SUPERVISOR').length, 5); assert.equal(by('FLIGHT_EXPERT').length, 3); assert.equal(by('TRAVEL_AGENT').length, 34);
  assert.equal(people.length, 45); assert.equal(directoryPeople().length, 45);
  assert.equal(new Set(people.map((p) => p.email)).size, 45); assert.equal(new Set(people.map((p) => p.fullName)).size, 45); // no duplicate accounts
  assert.equal((await prisma.profile.findUnique({ where: { id: joe.id } })).email, 'joe.goodwin@above9.travel'); // the same account, corrected

  const email = (name) => people.find((p) => p.fullName === name).email;
  assert.equal(email('Ali Ahmed'), 'ali@above9.travel');            // exception (Ali@above9.travel, stored lowercase)
  assert.equal(email('Zak Johnson'), 'zak@above9.travel');          // exception
  assert.equal(email('Ashley Taylor'), 'ashley.taylor@above9.travel');
  assert.equal(email('Joe Godwin'), 'joe.goodwin@above9.travel'); assert.equal(email('Tom Allen'), 'tom.allen@above9.travel'); assert.equal(email('Oscar Ian'), 'oscar.ian@above9.travel');
  assert.ok(people.every((p) => p.email === p.email.toLowerCase() && p.email.endsWith('@above9.travel')));

  // nothing invented: new people are invited without passwords, invitations, phones, addresses, credentials, setup ticks
  const created = people.filter((p) => p.id !== joe.id && p.id !== luis.id && p.id !== david.id);
  assert.ok(created.every((p) => p.status === 'INVITED' && p.passwordHash === null && p.localPhone === null && p.currentAddressEnc === null));
  assert.equal(await prisma.invitation.count({ where: { profile: { organizationId: dirOrg.id } } }), 0);
  assert.equal(await prisma.credential.count({ where: { organizationId: dirOrg.id } }), 0);
  assert.equal(await prisma.employeeSetupItem.count({ where: { profile: { organizationId: dirOrg.id } } }), 0);

  // teams: exact supervisor -> agents mapping
  const roster = {};
  for (const sup of by('SUPERVISOR')) {
    const assigned = await prisma.supervisorAssignment.findMany({ where: { supervisorId: sup.id, unassignedAt: null }, include: { agent: true } });
    roster[sup.fullName] = assigned.map((a) => a.agent.fullName).sort();
    assert.ok(assigned.every((a) => a.agent.role === 'TRAVEL_AGENT'));
  }
  for (const team of TEAMS) {
    const supName = people.find((p) => p.email === team.supervisor).fullName;
    assert.deepEqual(roster[supName], team.agents.map((a) => a.fullName).sort(), supName);
  }
  assert.deepEqual(Object.values(roster).map((r) => r.length).sort(), [4, 6, 8, 8, 8]);
  assert.ok(roster['Charlie Young'].includes('Luis Smith')); assert.ok(!roster['David Nelson'].includes('Luis Smith'));
  const luisMemberships = await prisma.teamMembership.findMany({ where: { profileId: luis.id }, include: { team: true } });
  assert.deepEqual(luisMemberships.map((m) => m.team.name), ['Team Charlie']);
  assert.equal(await prisma.supervisorAssignment.count({ where: { agentId: luis.id, unassignedAt: null } }), 1);
  assert.ok(report.moved.some((m) => m.startsWith('Luis Smith')) && report.supervisorFixed.some((m) => m.startsWith('Luis Smith')));
  // flight experts are not in any agent team and have no supervisor assignment
  for (const fe of by('FLIGHT_EXPERT')) {
    assert.equal(await prisma.teamMembership.count({ where: { profileId: fe.id } }), 0);
    assert.equal(await prisma.supervisorAssignment.count({ where: { agentId: fe.id } }), 0);
  }
  assert.equal(await prisma.team.count({ where: { organizationId: dirOrg.id } }), 5);

  // a second run changes nothing
  const again = await applyDirectory(prisma, dirOrg.id);
  assert.deepEqual([again.created.length, again.emailFixed.length, again.moved.length, again.supervisorFixed.length, again.teamsCreated.length, again.unchanged], [0, 0, 0, 0, 0, 45]);
  assert.equal(await prisma.profile.count({ where: { organizationId: dirOrg.id } }), 45);

  // every employee has a setup checklist with the 19 default requirements (18 + Passport Details); not-yet-activated people are "Setup Not Started"
  const setups = await loadSetupForProfiles(dirOrg.id, people);
  assert.ok(people.every((p) => setups.get(p.id).rows.length === 19));
  assert.ok(created.every((p) => setups.get(p.id).notStarted && setups.get(p.id).label === 'Setup Not Started'));
  assert.equal(setups.get(joe.id).notStarted, false); assert.equal(setups.get(joe.id).percent, 0); // active, nothing verified yet: unknown stays "not set up"
  assert.match(setups.get(joe.id).label, /Setup Required/);
});

test('no default or shared password exists in the seed or directory scripts', () => {
  const root = path.join(__dirname, '..');
  for (const file of ['prisma/seed.js', 'prisma/directory.js', 'scripts/seed-directory.cjs']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(source, /bcrypt/i, file);
    assert.doesNotMatch(source, /passwordHash\s*[:=]\s*['"`]?[A-Za-z0-9$]/, file);
    assert.doesNotMatch(source, /Above9Admin/, file);
  }
});

// ------------------------------------------------------------------ hierarchy, overview, WhatsApp/Telegram, cross-team
test('Employees & Teams shows the team hierarchy, role filters, and address/phone markers without any address text', async () => {
  const address = '9 Secret Lane, Nowhere';
  const { encryptText } = require('../lib/credentialCrypto');
  await prisma.profile.update({ where: { id: agentA.id }, data: { currentAddressEnc: encryptText(address, `address:${agentA.id}`), localPhone: '+998 90 111 22 33' } });
  const teams = await get(admin, '/admin/teams');
  assert.equal(teams.status, 200);
  assert.match(teams.text, /F1 Team A/); assert.match(teams.text, /F1 supA/); assert.match(teams.text, /→ F1 agentA/);
  const idxA = teams.text.indexOf('F1 Team A'); const idxB = teams.text.indexOf('F1 Team B');
  assert.ok(teams.text.indexOf('F1 agentA') > idxA && (idxB < 0 || teams.text.indexOf('F1 agentB') > idxB)); // agents sit under their own team
  const list = await get(admin, '/admin/employees?role=TRAVEL_AGENT');
  assert.match(list.text, /Address ✓/); assert.match(list.text, /Address missing/); assert.match(list.text, /Travel Agents/);
  assert.doesNotMatch(list.text, /Secret Lane/);
  for (const [who, url] of [[admin, '/dashboard'], [supA, '/team'], [admin, '/admin/teams'], [admin, `/admin/employees/${agentA.id}`], [supA, `/team/${agentA.id}`]]) assert.doesNotMatch((await get(who, url)).text, /Secret Lane/, url);
  const overview = await get(admin, `/admin/employees/${agentA.id}`);
  assert.match(overview.text, /Setup &amp; availability/); assert.match(overview.text, /Address ✓/); assert.match(overview.text, /\+998 90 111 22 33/);
  assert.match((await get(admin, `/employees/${agentA.id}/setup`)).text, /Secret Lane/); // only the authorized profile view shows it
  // an admin of another organization cannot archive our team by ID
  assert.equal((await post(outsider, `/admin/teams/${teamA.id}/archive`)).status, 404);
  assert.equal((await prisma.team.findUnique({ where: { id: teamA.id } })).archivedAt, null);
  assert.ok(denied(await get(supA, '/admin/teams')));
});

test('WhatsApp and Telegram record the company number and confirmation, never in the audit log', async () => {
  await ensureDefaultRequirements(org.id); // the default checklist includes company-controlled WhatsApp and Telegram
  const wa = await prisma.setupRequirement.findFirst({ where: { organizationId: org.id, key: 'whatsapp' } });
  const bad = await post(supA, `/employees/${agentA.id}/setup/${wa.id}`, { status: 'COMPLETED', companyControlConfirmed: '1', companyNumber: '<script>' });
  assert.match(bad.text, /Enter the company number/);
  assert.equal((await post(supA, `/employees/${agentA.id}/setup/${wa.id}`, { status: 'COMPLETED', companyControlConfirmed: '1', companyNumber: '+998 71 200 30 40' })).status, 302);
  const item = await prisma.employeeSetupItem.findFirst({ where: { profileId: agentA.id, requirementId: wa.id } });
  assert.equal(item.companyNumber, '+998 71 200 30 40'); assert.equal(item.companyControlConfirmed, true); assert.equal(item.verifiedById, supA.id); assert.ok(item.verifiedAt);
  assert.match((await get(supA, `/employees/${agentA.id}/setup`)).text, /Company number\/account: \+998 71 200 30 40/);
  assert.ok(denied(await post(supB, `/employees/${agentA.id}/setup/${wa.id}`, { status: 'COMPLETED', companyNumber: '+1' })));
  assert.doesNotMatch(JSON.stringify(await prisma.auditLog.findMany({ where: { organizationId: org.id } })), /998 71 200/);
});

test('cross-team and cross-employee access is rejected on the server for profiles, setup, address, credentials, leave and teams', async () => {
  const cred = await prisma.credential.create({ data: { organizationId: org.id, ownerId: agentB.id, system: 'Gmail', systemKey: null, payloadEnc: 'v1.x', createdById: admin.id } });
  const leave = await prisma.leaveRequest.create({ data: { organizationId: org.id, profileId: agentB.id, teamId: teamB.id, supervisorId: supB.id, leaveType: 'VACATION', startDate: new Date(Date.now() + 864e6), endDate: new Date(Date.now() + 865e6), days: 2 } });
  for (const url of [`/employees/${agentB.id}/setup`, `/employees/${agentB.id}/credentials`, `/employees/${agentB.id}/leave`, `/employees/${agentB.id}/training`, `/employees/${agentB.id}/skills`, `/employees/${agentB.id}/activity`, `/team/${agentB.id}`, `/admin/employees/${agentB.id}`, `/admin/teams/${teamB.id}`]) {
    for (const who of [agentA, supA, expertA]) assert.ok(denied(await get(who, url)), `${who.role} GET ${url}`);
  }
  for (const who of [agentA, supA, expertA]) {
    assert.ok(denied(await post(who, `/employees/${agentB.id}/contact`, { currentAddress: 'nope' })));
    assert.ok(denied(await post(who, `/credentials/${cred.id}/reveal`, { password: 'Correct-Horse-9!' })));
    assert.ok(denied(await post(who, `/credentials/${cred.id}/update`, { password: 'x' })));
    assert.ok(denied(await post(who, `/credentials/${cred.id}/delete`)));
    assert.ok(denied(await get(who, `/leave/${leave.id}`)));
    assert.ok(denied(await post(who, `/leave/${leave.id}/review`, { action: 'approve' })));
  }
  assert.equal((await prisma.leaveRequest.findUnique({ where: { id: leave.id } })).status, 'PENDING');
  assert.ok(await prisma.credential.findUnique({ where: { id: cred.id } }));
  assert.equal((await get(supB, `/team/${agentB.id}`)).status, 200);          // their own agent
  assert.equal((await get(supB, `/leave/${leave.id}`)).status, 200);
  assert.doesNotMatch((await get(supA, '/leave')).text, /F1 agentB/);          // vacation list is team-scoped
  assert.doesNotMatch((await get(supA, '/team')).text, /F1 agentB/);
});
