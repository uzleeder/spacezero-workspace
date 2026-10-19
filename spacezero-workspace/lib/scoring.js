'use strict';

// Skill Graph aggregation. Evidence (SkillEvidence) is the source of truth; EmployeeSkill holds the
// CACHED aggregate (score, confidence, status inputs) so dashboards and analytics never have to read
// an employee's whole history. The maths lives in lib/skillEngine.js (pure, deterministic, versioned);
// this file loads evidence, calls the engine, and stores the result plus a history row.
const { prisma } = require('./prisma');
const { getSetting, DEFAULT_SCORING } = require('./orgSettings');
const engine = require('./skillEngine');

// The weights live in Settings & Security → Policies (scoring.config) and default to DEFAULT_SCORING.
const SOURCE_WEIGHT = DEFAULT_SCORING.sourceWeights;
const RECENCY_HALF_LIFE_DAYS = DEFAULT_SCORING.halfLifeDays;
const LEGACY_CONFIDENCE = { NONE: 0, LOW: 35, MEDIUM: 65, HIGH: 90 };

function recencyWeight(createdAt, now = new Date(), halfLifeDays = RECENCY_HALF_LIFE_DAYS) {
  return engine.recency(createdAt, now, halfLifeDays);
}

/** The weight one piece of evidence carries before recency: kind reliability x difficulty. */
function evidenceWeight(evidence, config = DEFAULT_SCORING) {
  return Number(engine.baseWeight(evidence, { ...engine.DEFAULT_ENGINE, ...config }).toFixed(3));
}

/**
 * Recomputes EmployeeSkill's cached aggregate from ALL of its evidence and appends a history row.
 * Call after any code path writes new SkillEvidence. History is append-only: nothing is overwritten.
 */
async function recomputeSkillScore(employeeSkillId, { note = null, now = new Date() } = {}) {
  const evidence = await prisma.skillEvidence.findMany({ where: { employeeSkillId, scoreImpact: { not: null } }, orderBy: { createdAt: 'desc' } });
  if (evidence.length === 0) return null;

  const owner = await prisma.employeeSkill.findUnique({ where: { id: employeeSkillId }, select: { profile: { select: { organizationId: true } } } });
  const config = owner ? await getSetting(owner.profile.organizationId, 'scoring.config') : DEFAULT_SCORING;
  const result = engine.computeSkill(evidence, { ...engine.DEFAULT_ENGINE, ...config }, now);

  const currentScore = result.score;
  const confidence = LEGACY_CONFIDENCE[result.confidence.level];
  await prisma.$transaction([
    prisma.employeeSkill.update({
      where: { id: employeeSkillId },
      data: { currentScore, confidence, confidenceLevel: result.confidence.level, engineVersion: engine.ENGINE_VERSION, evidenceCount: evidence.length, lastAssessedAt: now, lastEvidenceAt: result.lastEvidenceAt },
    }),
    prisma.skillScoreHistory.create({
      data: { employeeSkillId, score: currentScore, confidence, confidenceLevel: result.confidence.level, evidenceCount: evidence.length, engineVersion: engine.ENGINE_VERSION, note: note || `Recomputed from ${evidence.length} evidence item(s) (engine v${engine.ENGINE_VERSION}).`, recordedAt: now },
    }),
  ]);
  return { currentScore, confidence, confidenceLevel: result.confidence.level };
}

/** Recomputes every skill of an organization that has evidence (after a scoring-configuration change). */
async function recomputeOrganization(organizationId, note = 'Recalculated after a scoring configuration change.') {
  let count = 0;
  const rows = await prisma.employeeSkill.findMany({ where: { evidenceCount: { gt: 0 }, profile: { organizationId } }, select: { id: true } });
  for (const row of rows) { if (await recomputeSkillScore(row.id, { note })) count += 1; }
  return count;
}

// Training-pass bands from Phase 2 (kept for the quiz result pages). Skill STATUS bands are separate and configurable.
const COMPETENCY_LABELS = [
  { max: 69, label: 'Retake Required' },
  { max: 79, label: 'Passed / Needs Improvement' },
  { max: 89, label: 'Proficient' },
  { max: 100, label: 'Strong Mastery' },
];

function competencyLabel(score) {
  const band = COMPETENCY_LABELS.find((b) => score <= b.max);
  return band ? band.label : COMPETENCY_LABELS[COMPETENCY_LABELS.length - 1].label;
}

module.exports = { recomputeSkillScore, recomputeOrganization, competencyLabel, evidenceWeight, recencyWeight, SOURCE_WEIGHT, RECENCY_HALF_LIFE_DAYS };
