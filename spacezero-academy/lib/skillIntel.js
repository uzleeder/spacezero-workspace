'use strict';

// Read side of the Skill Graph: turns the cached aggregates (EmployeeSkill), the append-only history
// (SkillScoreHistory) and the evidence counts into what the screens need — Skill DNA, trends, status,
// confidence. It never recalculates scores (that is lib/scoring.js + lib/skillEngine.js) and it only
// ever reads the rows of the profiles it is given, so callers decide WHO may be looked at.
const { prisma } = require('./prisma');
const engine = require('./skillEngine');
const { getSetting } = require('./orgSettings');
const { ensureEmployeeSkills } = require('./skills');

const DAY_MS = 86400000;

async function loadConfig(organizationId) {
  const [bands, scoring] = await Promise.all([getSetting(organizationId, 'skills.statusBands'), getSetting(organizationId, 'scoring.config')]);
  return { bands, scoring };
}

/** Evidence counts per (employeeSkill, kind), in one grouped query. */
async function evidenceKinds(employeeSkillIds) {
  if (!employeeSkillIds.length) return new Map();
  const rows = await prisma.skillEvidence.groupBy({ by: ['employeeSkillId', 'assessmentType', 'sourceType'], where: { employeeSkillId: { in: employeeSkillIds }, scoreImpact: { not: null } }, _count: { _all: true } });
  const out = new Map();
  for (const r of rows) {
    const kinds = out.get(r.employeeSkillId) || {};
    const kind = engine.evidenceKind({ assessmentType: r.assessmentType, sourceType: r.sourceType });
    kinds[kind] = (kinds[kind] || 0) + r._count._all;
    out.set(r.employeeSkillId, kinds);
  }
  return out;
}

/** Score history for many skills at once (bounded window), grouped by employeeSkillId. */
async function historyFor(employeeSkillIds, { sinceDays = 400 } = {}) {
  if (!employeeSkillIds.length) return new Map();
  const rows = await prisma.skillScoreHistory.findMany({
    where: { employeeSkillId: { in: employeeSkillIds }, recordedAt: { gte: new Date(Date.now() - sinceDays * DAY_MS) } },
    orderBy: { recordedAt: 'asc' },
    select: { employeeSkillId: true, score: true, recordedAt: true, confidenceLevel: true, evidenceCount: true },
  });
  const out = new Map();
  for (const r of rows) { const list = out.get(r.employeeSkillId) || []; list.push(r); out.set(r.employeeSkillId, list); }
  return out;
}

/** One presentation row for an EmployeeSkill (with its skill), given its history and evidence kinds. */
function presentRow(es, { bands, history = [], kinds = {}, now = new Date() }) {
  const assessed = es.evidenceCount > 0;
  const score = assessed ? Math.round(es.currentScore) : null;
  const trend = assessed ? engine.trendOf(history, { now }) : { direction: 'new', delta: 0 };
  return {
    id: es.id,
    profileId: es.profileId,
    skill: es.skill,
    category: (es.skill.category || 'Other').trim() || 'Other',
    score,
    status: engine.statusFor(score, bands),
    confidenceLevel: assessed ? es.confidenceLevel : 'NONE',
    evidenceCount: es.evidenceCount,
    kinds,
    basis: engine.describeBasis(kinds),
    practicalCount: Object.entries(kinds).filter(([k]) => engine.isPractical(k)).reduce((n, [, c]) => n + c, 0),
    trend,
    timeline: engine.monthlyTimeline(history),
    lastAssessedAt: es.lastAssessedAt,
    lastEvidenceAt: es.lastEvidenceAt,
    assessed,
  };
}

/** The complete Skill Graph of one employee: only skills that apply to their role, with evidence-based scores. */
async function getSkillRows(profile, { ensure = true, now = new Date() } = {}) {
  if (ensure) await ensureEmployeeSkills(profile.id, profile.organizationId, profile.role);
  const { bands } = await loadConfig(profile.organizationId);
  const list = await prisma.employeeSkill.findMany({
    where: { profileId: profile.id, skill: { isActive: true, organizationId: profile.organizationId, OR: [{ roleKey: profile.role }, { roleKey: null }] } },
    include: { skill: true },
    orderBy: [{ skill: { category: 'asc' } }, { skill: { displayOrder: 'asc' } }],
  });
  const ids = list.map((s) => s.id);
  const [history, kinds] = await Promise.all([historyFor(ids), evidenceKinds(ids)]);
  return list.map((es) => presentRow(es, { bands, history: history.get(es.id) || [], kinds: kinds.get(es.id) || {}, now }));
}

const byScoreDesc = (a, b) => b.score - a.score;

/**
 * Skill DNA sections from a set of rows. Scores are only ever ranked when they have evidence, and the
 * "without enough evidence" list is separate so a lucky single quiz can never look like mastery.
 */
function classifySkills(rows) {
  const assessed = rows.filter((r) => r.assessed);
  const trusted = assessed.filter((r) => r.confidenceLevel !== 'LOW');
  const rank = (r) => r.score + ({ HIGH: 5, MEDIUM: 2, LOW: 0 }[r.confidenceLevel] || 0);
  return {
    strongest: trusted.filter((r) => r.score >= 80).sort((a, b) => rank(b) - rank(a)).slice(0, 5),
    developing: assessed.filter((r) => r.score >= 70 && r.score < 80).sort(byScoreDesc),
    priority: assessed.filter((r) => r.score < 70).sort((a, b) => a.score - b.score),
    improved: assessed.filter((r) => r.trend.direction === 'improving').sort((a, b) => b.trend.delta - a.trend.delta),
    declining: assessed.filter((r) => r.trend.direction === 'declining').sort((a, b) => a.trend.delta - b.trend.delta),
    thin: rows.filter((r) => !r.assessed || r.confidenceLevel === 'LOW'),
  };
}

/** Category summaries (average of assessed skills) for the Skill DNA chart. */
function categorySummary(rows) {
  const groups = new Map();
  for (const r of rows) { const list = groups.get(r.category) || []; list.push(r); groups.set(r.category, list); }
  return [...groups.entries()].map(([category, list]) => {
    const assessed = list.filter((r) => r.assessed);
    return { category, skills: list, average: assessed.length ? Math.round(assessed.reduce((n, r) => n + r.score, 0) / assessed.length) : null, assessedCount: assessed.length };
  });
}

/**
 * Cached aggregates for MANY profiles (team / organization screens). No timelines and no evidence
 * queries: this reads only the EmployeeSkill table, which is what keeps team and organization views
 * fast however much evidence has accumulated.
 */
async function aggregatesFor(profileIds, { onlyAssessed = true } = {}) {
  if (!profileIds.length) return [];
  return prisma.employeeSkill.findMany({
    where: { profileId: { in: profileIds }, ...(onlyAssessed ? { evidenceCount: { gt: 0 } } : {}), skill: { isActive: true } },
    select: { id: true, profileId: true, skillId: true, currentScore: true, confidenceLevel: true, evidenceCount: true, lastEvidenceAt: true, lastAssessedAt: true, skill: { select: { id: true, name: true, category: true, roleKey: true } } },
  });
}

module.exports = { loadConfig, evidenceKinds, historyFor, presentRow, getSkillRows, classifySkills, categorySummary, aggregatesFor };
