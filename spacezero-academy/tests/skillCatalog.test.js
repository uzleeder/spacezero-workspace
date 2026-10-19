'use strict';
// Practice results reach the Skill Graph: the AI is given the organization's skill catalog to tag questions,
// role-plays and simulations with (its names are saved in the catalog's spelling), and a result is matched to a
// catalog skill ignoring case and spacing, within the learner's own role - a name two roles share ("Aircraft
// Knowledge") lands on the learner's one, and a skill of another role is never written.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const gemini = require('../lib/gemini');
const calls = []; let reply = null;
mock.method(gemini, 'generateStructured', async (input) => { calls.push(input); return { modelVersion: 'test', data: reply }; });
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { generateQuestionAssessment, generateRoleplayAssessment } = require('../lib/practiceEngine');
const { recordCallEvidence } = require('../lib/callEvidence');
const app = require('../server');

let org, admin, course; const cookies = {}; const skill = {}; let n = 0;
async function person(role) {
  n += 1;
  const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `Skills ${n}`, username: `sk_${org.id}_${n}`, email: `sk_${org.id}_${n}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
  const t = generateToken(); await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookies[p.id] = `sz_session=${t.raw}`;
  return p;
}
const evidenceOf = async (profile) => (await prisma.skillEvidence.findMany({ where: { employeeSkill: { profileId: profile.id } }, include: { employeeSkill: { include: { skill: true } } } }))
  .map((e) => `${e.employeeSkill.skill.roleKey || 'ANY'}:${e.employeeSkill.skill.name}`).sort();

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Skill catalog tests' } });
  admin = await person('ADMIN');
  for (const [name, roleKey] of [['Aircraft Knowledge', 'TRAVEL_AGENT'], ['Objection Handling', 'TRAVEL_AGENT'], ['Aircraft Knowledge', 'FLIGHT_EXPERT'], ['Fare Rules', 'FLIGHT_EXPERT'], ['Professionalism', null]]) {
    skill[`${roleKey}:${name}`] = await prisma.skill.create({ data: { organizationId: org.id, roleKey, name, category: 'Test' } });
  }
  await prisma.skill.create({ data: { organizationId: org.id, roleKey: 'TRAVEL_AGENT', name: 'Retired skill', isActive: false } });
  course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Skill course', createdById: admin.id, status: 'PUBLISHED', passingScore: 70, publishedVersion: 1, audienceJson: JSON.stringify({ roles: ['TRAVEL_AGENT'], teamIds: [], profileIds: [] }) } });
});
after(async () => { mock.restoreAll(); await prisma.$disconnect(); });

async function passQuizAs(role, skillNames) {
  const learner = await person(role);
  const quiz = await prisma.assessment.create({ data: { organizationId: org.id, courseId: course.id, createdVia: 'ADMIN_MANUAL', type: 'QUIZ', title: `Quiz ${++n}`, status: 'APPROVED', level: 2, passingScore: 70, createdById: admin.id, version: 1 } });
  const q = await prisma.question.create({ data: { assessmentId: quiz.id, type: 'MCQ', prompt: 'Pick', optionsJson: JSON.stringify(['Right', 'Wrong']), correctAnswerJson: JSON.stringify('Right'), skillIdsJson: JSON.stringify(skillNames) } });
  const assignment = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.id, scope: 'INDIVIDUAL' } });
  await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: assignment.id, profileId: learner.id } });
  const res = await request(app).post(`/assessments/${quiz.id}/submit`).set('Cookie', cookies[learner.id]).type('form').send({ [`q_${q.id}`]: 'Right' });
  assert.equal(res.status, 200);
  return learner;
}

test('a result is matched ignoring case and spacing, to the catalog skills of the learner\'s own role', async () => {
  const tags = ['aircraft knowledge', ' Objection  handling ', 'PROFESSIONALISM', 'Fare Rules', 'A made-up skill', 'Retired skill'];
  assert.deepEqual(await evidenceOf(await passQuizAs('TRAVEL_AGENT', tags)), ['ANY:Professionalism', 'TRAVEL_AGENT:Aircraft Knowledge', 'TRAVEL_AGENT:Objection Handling']);
  assert.deepEqual(await evidenceOf(await passQuizAs('FLIGHT_EXPERT', tags)), ['ANY:Professionalism', 'FLIGHT_EXPERT:Aircraft Knowledge', 'FLIGHT_EXPERT:Fare Rules']);
});

test('call evidence uses the coached employee\'s role for a shared skill name', async () => {
  const expert = await person('FLIGHT_EXPERT');
  const batch = { id: 'batch-1', organizationId: org.id, mode: 'INDIVIDUAL_AGENT', targetAgentId: expert.id, recordings: [] };
  const out = await recordCallEvidence({ batch, report: { skills: [{ name: 'aircraft knowledge', score: 80, evidence: 'Knew the cabins.' }, { name: 'Objection Handling', score: 60, evidence: 'x' }] }, approver: admin });
  assert.equal(out.written, 1);
  assert.deepEqual(out.unmatched, ['Objection Handling']);
  assert.deepEqual(await evidenceOf(expert), ['FLIGHT_EXPERT:Aircraft Knowledge']);
});

const analysis = { extractedSkillsJson: '["Handling objections"]', criticalKnowledgeJson: '[]', practicalBehaviorsJson: '[]', commonMistakesJson: '[]', sourceReferencesJson: '{}' };

test('the AI writes questions with the catalog of the course audience, and its tags are saved in the catalog\'s spelling', async () => {
  reply = { questions: Array.from({ length: 3 }, (_, i) => ({ type: 'MCQ', prompt: `Q${i}`, options: ['Yes', 'No'], correctAnswer: 'Yes', skillNames: ['objection handling', 'Something else'] })) };
  const made = await generateQuestionAssessment({ course, analysis, actor: admin, type: 'QUIZ', questionCount: 3 });
  const prompt = calls.at(-1).contents[0].parts[0].text;
  assert.deepEqual(JSON.parse(/tag questions only with these exact names\): (\[[^\]]*\])/.exec(prompt)[1]).sort(), ['Aircraft Knowledge', 'Objection Handling', 'Professionalism']);
  assert.doesNotMatch(prompt, /Fare Rules/, 'a Flight Expert skill is not offered for a Travel Agent course');
  assert.doesNotMatch(prompt, /Retired skill/);
  assert.match(prompt, /Skills the material teaches: \["Handling objections"\]/);
  const saved = await prisma.question.findFirst({ where: { assessmentId: made.id } });
  assert.deepEqual(JSON.parse(saved.skillIdsJson), ['Objection Handling', 'Something else']);
});

test('a role-play rubric is chosen from the catalog and saved in its spelling', async () => {
  reply = { customerPersonality: 'busy', scenarioBrief: 'A client', openingLine: 'Hi', rubricSkills: ['objection handling', 'professionalism', 'Closing'] };
  const made = await generateRoleplayAssessment({ course, analysis, actor: admin });
  assert.deepEqual(JSON.parse(/rubricSkills = 3-6 skills copied exactly from this skill catalog: (\[[^\]]*\])/.exec(calls.at(-1).systemInstruction)[1]).sort(), ['Aircraft Knowledge', 'Objection Handling', 'Professionalism']);
  assert.deepEqual(JSON.parse(made.configJson).rubricSkills, ['Objection Handling', 'Professionalism', 'Closing']);
});

test('Admin review points out skill tags that are not in the catalog', async () => {
  const quiz = await prisma.assessment.create({ data: { organizationId: org.id, courseId: course.id, createdVia: 'ADMIN_MANUAL', type: 'QUIZ', title: 'Review quiz', status: 'AI_GENERATED', level: 2, passingScore: 70, createdById: admin.id, version: 1 } });
  await prisma.question.create({ data: { assessmentId: quiz.id, type: 'MCQ', prompt: 'Pick', optionsJson: JSON.stringify(['Right', 'Wrong']), correctAnswerJson: JSON.stringify('Right'), skillIdsJson: JSON.stringify(['Objection Handling', 'Handling objections']) } });
  const page = await request(app).get(`/admin/assessments/${quiz.id}`).set('Cookie', cookies[admin.id]);
  assert.equal(page.status, 200);
  assert.match(page.text, /Not in your skill catalog, so results for it do not reach the Skill Graph: Handling objections</);
});
