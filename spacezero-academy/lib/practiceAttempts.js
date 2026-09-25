'use strict';

// Wires a completed practice/assessment attempt into the real Skill Graph (spec section 14):
// writes SkillEvidence for every skill the attempt touched (matched by name against the
// organization's existing Skill rows — unmatched AI-suggested skill names are still shown to
// the learner/reviewer but don't write evidence against a skill that doesn't exist), then
// recomputes EmployeeSkill.currentScore via lib/scoring.js's transparent weighting.
const { prisma } = require('./prisma');
const { recomputeSkillScore, evidenceWeight } = require('./scoring');
const { getSetting } = require('./orgSettings');
const { createNotification } = require('./notifications');

async function findMatchingSkillId(organizationId, skillName) {
  const skill = await prisma.skill.findFirst({ where: { organizationId, name: { equals: skillName } } });
  return skill ? skill.id : null;
}

/**
 * Records one TrainingAttempt against an Assessment for a learner who already has a
 * TrainingAssignmentRecipient (course-linked practice) and writes Skill Graph evidence.
 */
async function recordAssessmentAttempt({ actor, assessment, recipientId, score, passed, answersJson, transcriptJson, skillBreakdown, sourceType = 'ASSESSMENT' }) {
  const priorCount = await prisma.trainingAttempt.count({ where: { recipientId, assessmentId: assessment.id } });

  const attempt = await prisma.trainingAttempt.create({
    data: {
      recipientId,
      profileId: actor.id,
      assessmentId: assessment.id,
      status: passed ? 'COMPLETED' : 'RETAKE_REQUIRED',
      score,
      attemptNumber: priorCount + 1,
      startedAt: new Date(),
      completedAt: new Date(),
      answersJson: answersJson ? JSON.stringify(answersJson) : null,
      transcriptJson: transcriptJson ? JSON.stringify(transcriptJson) : null,
      skillBreakdownJson: JSON.stringify(skillBreakdown || {}),
      level: assessment.level,
      aiModelVersion: assessment.modelVersion,
    },
  });

  for (const [skillName, skillScore] of Object.entries(skillBreakdown || {})) {
    const skillId = await findMatchingSkillId(assessment.organizationId, skillName);
    if (!skillId) continue;
    const employeeSkill = await prisma.employeeSkill.upsert({
      where: { profileId_skillId: { profileId: actor.id, skillId } },
      update: {},
      create: { profileId: actor.id, skillId },
    });
    await prisma.skillEvidence.create({
      data: {
        employeeSkillId: employeeSkill.id,
        sourceType,
        sourceId: attempt.id,
        scoreImpact: skillScore,
        notes: `${assessment.type.replace(/_/g, ' ')} practice: "${assessment.title}"`,
        // The full evidence trail: which assessment, of what kind, how hard, which attempt, and the weight applied.
        assessmentId: assessment.id,
        assessmentType: assessment.type,
        difficulty: assessment.level,
        attemptNumber: attempt.attemptNumber,
        weight: evidenceWeight({ sourceType, assessmentType: assessment.type, difficulty: assessment.level }, await getSetting(assessment.organizationId, 'scoring.config')),
      },
    });
    await recomputeSkillScore(employeeSkill.id);
  }

  await createNotification({
    profileId: actor.id,
    type: passed ? 'practice.passed' : 'practice.retake_required',
    title: passed ? 'Practice completed' : 'Retake required',
    body: passed
      ? `You scored ${score}% on "${assessment.title}".`
      : `You scored ${score}% on "${assessment.title}" — below the ${assessment.passingScore}% passing threshold. A retake is recommended.`,
    link: '/training',
  }).catch(() => undefined);

  return attempt;
}

module.exports = { recordAssessmentAttempt };
