'use strict';

// Skill evidence from an approved individual-agent call analysis (spec sections 10 and 14). The AI
// never writes a score onto the Skill Graph itself: it produces per-skill observations, an Admin
// reviews and approves the analysis, and only then is each observation stored as CALL_REVIEW
// evidence. The Skill Graph score is then recomputed from ALL evidence by lib/scoring.js.
const { prisma } = require('./prisma');
const { recomputeSkillScore } = require('./scoring');
const { evidenceWeight } = require('./scoring');
const { getSetting } = require('./orgSettings');

async function recordCallEvidence({ batch, report, approver }) {
  if (batch.mode !== 'INDIVIDUAL_AGENT' || !batch.targetAgentId) return { written: 0, unmatched: [] };
  const skills = await prisma.skill.findMany({ where: { organizationId: batch.organizationId } });
  const byName = new Map(skills.map((s) => [s.name.trim().toLowerCase(), s]));
  const config = await getSetting(batch.organizationId, 'scoring.config');
  let written = 0;
  const unmatched = [];
  for (const observation of report.skills) {
    const skill = byName.get(observation.name.trim().toLowerCase());
    if (!skill) { unmatched.push(observation.name); continue; } // shown to the reviewer, never written against a skill that does not exist
    const employeeSkill = await prisma.employeeSkill.upsert({
      where: { profileId_skillId: { profileId: batch.targetAgentId, skillId: skill.id } },
      update: {},
      create: { profileId: batch.targetAgentId, skillId: skill.id },
    });
    await prisma.skillEvidence.create({
      data: {
        employeeSkillId: employeeSkill.id,
        sourceType: 'CALL_REVIEW',
        sourceId: batch.id,
        scoreImpact: Math.max(0, Math.min(100, Math.round(observation.score))),
        notes: `Call analysis (${batch.recordings ? batch.recordings.length : 'several'} call(s)), approved by ${approver.fullName}: ${observation.evidence}`.slice(0, 1000),
        recordedById: approver.id,
        assessmentType: 'CALL_ANALYSIS',
        weight: evidenceWeight({ sourceType: 'CALL_REVIEW', difficulty: null }, config),
      },
    });
    await recomputeSkillScore(employeeSkill.id);
    written += 1;
  }
  return { written, unmatched };
}

module.exports = { recordCallEvidence };