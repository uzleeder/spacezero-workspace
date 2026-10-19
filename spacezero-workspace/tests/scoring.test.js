'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { prisma } = require('../lib/prisma');
const { recomputeSkillScore, competencyLabel } = require('../lib/scoring');

const ORG_ID = 'test_org_scoring';
let profile, skill, employeeSkill;

before(async () => {
  await prisma.organization.upsert({ where: { id: ORG_ID }, update: {}, create: { id: ORG_ID, name: 'Test Org Scoring' } });
  profile = await prisma.profile.create({
    data: {
      organizationId: ORG_ID,
      fullName: 'Scoring Test Agent',
      username: `scoring_agent_${randomUUID()}`,
      email: `scoring_agent_${randomUUID()}@example.invalid`,
      role: 'TRAVEL_AGENT',
      status: 'ACTIVE',
      employmentStartDate: new Date('2025-01-01'),
    },
  });
  skill = await prisma.skill.create({ data: { organizationId: ORG_ID, name: 'Objection Handling', category: 'Sales' } });
  employeeSkill = await prisma.employeeSkill.create({ data: { profileId: profile.id, skillId: skill.id } });
});

after(async () => {
  await prisma.skillScoreHistory.deleteMany({ where: { employeeSkillId: employeeSkill.id } });
  await prisma.skillEvidence.deleteMany({ where: { employeeSkillId: employeeSkill.id } });
  await prisma.employeeSkill.deleteMany({ where: { profileId: profile.id } });
  await prisma.skill.deleteMany({ where: { id: skill.id } });
  await prisma.profile.deleteMany({ where: { id: profile.id } });
  await prisma.organization.deleteMany({ where: { id: ORG_ID } });
  await prisma.$disconnect();
});

test('recomputeSkillScore returns null with no scored evidence', async () => {
  const result = await recomputeSkillScore(employeeSkill.id);
  assert.equal(result, null);
});

test('recomputeSkillScore averages scoreImpact and updates EmployeeSkill', async () => {
  await prisma.skillEvidence.create({
    data: { employeeSkillId: employeeSkill.id, sourceType: 'ASSESSMENT', scoreImpact: 80, notes: 'Quiz attempt' },
  });
  await prisma.skillEvidence.create({
    data: { employeeSkillId: employeeSkill.id, sourceType: 'ASSESSMENT', scoreImpact: 60, notes: 'Quiz attempt 2' },
  });

  const result = await recomputeSkillScore(employeeSkill.id);
  assert.ok(result.currentScore >= 60 && result.currentScore <= 80, `expected score between 60-80, got ${result.currentScore}`);

  const updated = await prisma.employeeSkill.findUnique({ where: { id: employeeSkill.id } });
  assert.equal(updated.currentScore, result.currentScore);
  assert.equal(updated.evidenceCount, 2);
  assert.ok(updated.lastAssessedAt);
  // Regression: confidence is stored 0-100 (not a 0-1 fraction) — views/skill-graph.ejs and
  // views/partials/profile-overview.ejs render it directly as a percentage with no scaling.
  // Phase 3: confidence is a LEVEL derived from amount, practical-ness, diversity and consistency of evidence.
  // Two theoretical observations and nothing practical can never be more than LOW confidence.
  assert.equal(updated.confidenceLevel, 'LOW');
  assert.equal(updated.confidence, 35);
  assert.equal(updated.engineVersion, 2);

  const history = await prisma.skillScoreHistory.findMany({ where: { employeeSkillId: employeeSkill.id } });
  assert.equal(history.length, 1);
  assert.equal(history[0].score, result.currentScore);
});

test('practical evidence (CALL_REVIEW) is weighted higher than recall (ASSESSMENT)', async () => {
  // Two equally-recent, opposite-direction pieces of evidence: a low ASSESSMENT score and a
  // high CALL_REVIEW score of the same magnitude of difference from 70. Because CALL_REVIEW
  // carries a higher SOURCE_WEIGHT, the blended score should land above the simple average.
  // Uses a fresh EmployeeSkill (on a new Skill) to avoid interfering with the previous test.
  const skill2 = await prisma.skill.create({ data: { organizationId: ORG_ID, name: 'Closing', category: 'Sales' } });
  const es2 = await prisma.employeeSkill.create({ data: { profileId: profile.id, skillId: skill2.id } });

  await prisma.skillEvidence.create({ data: { employeeSkillId: es2.id, sourceType: 'ASSESSMENT', scoreImpact: 50 } });
  await prisma.skillEvidence.create({ data: { employeeSkillId: es2.id, sourceType: 'CALL_REVIEW', scoreImpact: 90 } });

  const result = await recomputeSkillScore(es2.id);
  const simpleAverage = (50 + 90) / 2; // 70
  assert.ok(result.currentScore > simpleAverage, `expected weighted score above simple average ${simpleAverage}, got ${result.currentScore}`);

  await prisma.skillEvidence.deleteMany({ where: { employeeSkillId: es2.id } });
  await prisma.skillScoreHistory.deleteMany({ where: { employeeSkillId: es2.id } });
  await prisma.employeeSkill.deleteMany({ where: { id: es2.id } });
  await prisma.skill.deleteMany({ where: { id: skill2.id } });
});

test('competencyLabel matches the spec\'s bands', () => {
  assert.equal(competencyLabel(69), 'Retake Required');
  assert.equal(competencyLabel(70), 'Passed / Needs Improvement');
  assert.equal(competencyLabel(79), 'Passed / Needs Improvement');
  assert.equal(competencyLabel(80), 'Proficient');
  assert.equal(competencyLabel(89), 'Proficient');
  assert.equal(competencyLabel(90), 'Strong Mastery');
  assert.equal(competencyLabel(100), 'Strong Mastery');
});
