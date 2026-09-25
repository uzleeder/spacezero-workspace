'use strict';

// Advanced employee search filters shared by the Admin employee list and the Supervisor team list:
// skill + score range, training status, retake outstanding, overdue, and start-date range. The caller
// has ALREADY restricted the candidate set (organization / assigned team); filters only narrow it.
const { prisma } = require('./prisma');
const { loadLearning } = require('./teamIntel');

const { KEYS: READINESS_KEYS } = require('./readiness');
const TRAINING_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'RETAKE_REQUIRED'];
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const num = (v) => { const n = Number(str(v)); return str(v) !== '' && Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null; };
const day = (v) => { const s = str(v); if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null; const d = new Date(`${s}T00:00:00.000Z`); return Number.isNaN(d.getTime()) ? null : d; };

/** Normalizes the query string into the filter values shown back in the form. */
function parseFilters(query) {
  const trainingStatus = TRAINING_STATUSES.includes(str(query.trainingStatus)) ? str(query.trainingStatus) : '';
  return {
    skillId: str(query.skill),
    min: num(query.min),
    max: num(query.max),
    trainingStatus,
    retake: str(query.retake) === '1',
    overdue: str(query.overdue) === '1',
    startFrom: str(query.startFrom),
    startTo: str(query.startTo),
    readiness: READINESS_KEYS.includes(str(query.readiness)) ? str(query.readiness) : '',
  };
}

/** Prisma `where` fragment for the filters the database can evaluate. The skill must belong to the organization. */
async function whereFor(organizationId, f) {
  const where = {};
  const from = day(f.startFrom); const to = day(f.startTo);
  if (from || to) where.employmentStartDate = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  if (f.skillId) {
    const skill = await prisma.skill.findFirst({ where: { id: f.skillId, organizationId }, select: { id: true } });
    if (!skill) return { ...where, id: { in: [] } }; // a skill from elsewhere matches nobody rather than leaking anything
    const range = { ...(f.min !== null ? { gte: f.min } : {}), ...(f.max !== null ? { lte: f.max } : {}) };
    where.employeeSkills = { some: { skillId: skill.id, evidenceCount: { gt: 0 }, ...(Object.keys(range).length ? { currentScore: range } : {}) } };
  }
  return where;
}

/** Filters that need attempts (training status, retake, overdue), applied to already-loaded profiles. */
async function applyLearningFilters(profiles, f, now = new Date()) {
  if (!f.trainingStatus && !f.retake && !f.overdue) return profiles;
  const learning = await loadLearning(profiles.map((p) => p.id), now);
  const by = new Map();
  for (const l of learning) { const list = by.get(l.profileId) || []; list.push(l); by.set(l.profileId, list); }
  return profiles.filter((p) => {
    const list = by.get(p.id) || [];
    if (f.trainingStatus && !list.some((l) => l.status === f.trainingStatus)) return false;
    if (f.retake && !list.some((l) => l.retake)) return false;
    if (f.overdue && !list.some((l) => l.overdue)) return false;
    return true;
  });
}

/** Keeps only the people whose readiness status was asked for (readiness is computed by the caller). */
const byReadiness = (profiles, map, f) => (f.readiness ? profiles.filter((p) => map.get(p.id) && map.get(p.id).key === f.readiness) : profiles);

const isActive = (f) => Boolean(f.readiness || f.skillId || f.min !== null || f.max !== null || f.trainingStatus || f.retake || f.overdue || f.startFrom || f.startTo);

module.exports = { parseFilters, whereFor, applyLearningFilters, byReadiness, isActive, TRAINING_STATUSES };
