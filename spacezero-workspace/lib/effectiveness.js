'use strict';

// Training effectiveness: did the people who took a training measurably improve on the skills it targets?
// This reports OBSERVED skill change after training from the stored score history. It does not (and must
// not) claim the training caused it: people also practise, get coached and take calls in the meantime.
// The Training Effectiveness Score is an INTERNAL OPERATIONAL INDICATOR built from transparent parts;
// it is not scientifically validated, and every input is shown next to it.
const { prisma } = require('./prisma');

const DAY_MS = 86400000;
const MIN_SAMPLE = 3; // fewer paired observations than this are never presented as a result
const parse = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };

/** Last history point at or before `date` (history sorted ascending by recordedAt). */
function asOf(history, date) {
  let hit = null;
  for (const h of history) { if (h.recordedAt <= date) hit = h; else break; }
  return hit;
}

/**
 * Effectiveness for one course. `now` is injectable for tests.
 * @returns counts, rates, targeted skills, before / immediately-after / later averages (when enough evidence) and the indicator.
 */
async function courseEffectiveness(organizationId, courseId, { now = new Date() } = {}) {
  const course = await prisma.trainingCourse.findFirst({ where: { id: courseId, organizationId }, include: { analysis: true } });
  if (!course) return null;
  const recipients = await prisma.trainingAssignmentRecipient.findMany({
    where: { assignment: { courseId, organizationId }, profile: { status: { not: 'ARCHIVED' } } },
    include: { assignment: { select: { createdAt: true } }, attempts: { select: { status: true, score: true, attemptNumber: true, completedAt: true, createdAt: true } }, profile: { select: { id: true, role: true } } },
  });

  const started = recipients.filter((r) => r.attempts.some((a) => a.status !== 'NOT_STARTED'));
  const finishedAttempts = recipients.flatMap((r) => r.attempts).filter((a) => ['COMPLETED', 'RETAKE_REQUIRED', 'FAILED'].includes(a.status));
  const passedAttempts = finishedAttempts.filter((a) => a.status === 'COMPLETED');
  const scored = finishedAttempts.filter((a) => typeof a.score === 'number');
  const completers = recipients.filter((r) => { const latest = [...r.attempts].sort((a, b) => b.attemptNumber - a.attemptNumber)[0]; return latest && latest.status === 'COMPLETED'; });
  const retakers = recipients.filter((r) => r.attempts.some((a) => a.attemptNumber > 1) || r.attempts.some((a) => a.status === 'RETAKE_REQUIRED'));

  const stats = {
    course: { id: course.id, title: course.title },
    assigned: recipients.length,
    completed: completers.length,
    completionRate: recipients.length ? Math.round((completers.length / recipients.length) * 100) : null,
    passRate: finishedAttempts.length ? Math.round((passedAttempts.length / finishedAttempts.length) * 100) : null,
    averageAttempts: started.length ? Number((started.reduce((n, r) => n + r.attempts.filter((a) => a.status !== 'NOT_STARTED').length, 0) / started.length).toFixed(1)) : null,
    averageScore: scored.length ? Math.round(scored.reduce((n, a) => n + a.score, 0) / scored.length) : null,
    retakeRate: started.length ? Math.round((retakers.length / started.length) * 100) : null,
    repeatedFailures: recipients.filter((r) => r.attempts.filter((a) => a.status === 'RETAKE_REQUIRED' || a.status === 'FAILED').length >= 2).length,
  };

  // ---- skills the training targets (from its approved analysis), matched to real skills of the people who took it
  const names = parse(course.analysis && course.analysis.extractedSkillsJson, []).map((n) => String(n).trim().toLowerCase());
  const skills = names.length ? await prisma.skill.findMany({ where: { organizationId, isActive: true } }) : [];
  const targeted = skills.filter((s) => names.includes(s.name.trim().toLowerCase()));
  stats.skills = [...new Map(targeted.map((s) => [s.name.toLowerCase(), s.name])).values()];

  // ---- before / immediately after / later, per (person, skill), only where each point really exists
  const pairs = [];
  if (targeted.length && completers.length) {
    const rows = await prisma.employeeSkill.findMany({ where: { profileId: { in: completers.map((r) => r.profileId) }, skillId: { in: targeted.map((s) => s.id) }, evidenceCount: { gt: 0 } }, select: { id: true, profileId: true, skillId: true } });
    const history = await prisma.skillScoreHistory.findMany({ where: { employeeSkillId: { in: rows.map((r) => r.id) } }, orderBy: { recordedAt: 'asc' }, select: { employeeSkillId: true, score: true, recordedAt: true } });
    const byRow = new Map();
    for (const h of history) { const list = byRow.get(h.employeeSkillId) || []; list.push(h); byRow.set(h.employeeSkillId, list); }
    for (const r of completers) {
      const done = r.attempts.filter((a) => a.status === 'COMPLETED' && a.completedAt).sort((a, b) => a.completedAt - b.completedAt)[0];
      if (!done) continue;
      const completedAt = done.completedAt;
      for (const row of rows.filter((x) => x.profileId === r.profileId)) {
        const h = byRow.get(row.id) || [];
        const before = asOf(h, new Date(r.assignment.createdAt.getTime() - 1000)); // what we knew before it was assigned
        const after = h.find((x) => x.recordedAt >= new Date(completedAt.getTime() - 3600000) && x.recordedAt <= new Date(completedAt.getTime() + 14 * DAY_MS));
        if (!before || !after) continue;
        const laterDue = now.getTime() >= completedAt.getTime() + 30 * DAY_MS;
        const later = laterDue ? asOf(h, new Date(completedAt.getTime() + 30 * DAY_MS)) : null;
        const laterFresh = later && later.recordedAt >= new Date(completedAt.getTime() + 7 * DAY_MS) ? later : null; // a later point only counts if something was measured later
        pairs.push({ profileId: r.profileId, skillId: row.skillId, before: before.score, after: after.score, later: laterFresh ? laterFresh.score : null });
      }
    }
  }
  const avg = (list) => (list.length ? Math.round(list.reduce((n, x) => n + x, 0) / list.length) : null);
  const enough = pairs.length >= MIN_SAMPLE;
  const laterPairs = pairs.filter((p) => p.later !== null);
  stats.observed = {
    pairs: pairs.length, people: new Set(pairs.map((p) => p.profileId)).size, enough, minimum: MIN_SAMPLE,
    before: enough ? avg(pairs.map((p) => p.before)) : null,
    after: enough ? avg(pairs.map((p) => p.after)) : null,
    later: enough && laterPairs.length >= MIN_SAMPLE ? avg(laterPairs.map((p) => p.later)) : null,
    laterPairs: laterPairs.length,
  };
  stats.observed.change = stats.observed.before !== null ? stats.observed.after - stats.observed.before : null;

  // ---- the internal indicator: transparent parts, missing parts are left out and the weights renormalized
  const parts = [
    { key: 'completion', label: 'Completion', value: stats.completionRate, weight: 25 },
    { key: 'passRate', label: 'Pass rate', value: stats.passRate, weight: 25 },
    { key: 'improvement', label: 'Observed skill change', value: stats.observed.change === null ? null : Math.max(0, Math.min(100, 50 + stats.observed.change * 2.5)), weight: 25, note: '0 points = -20 or worse, 50 = no change, 100 = +20 or better' },
    { key: 'retention', label: 'Held after 30 days', value: stats.observed.later !== null && stats.observed.after !== null ? Math.max(0, Math.min(100, 100 + (stats.observed.later - stats.observed.after) * 5)) : null, weight: 15, note: '100 = held or improved, drops 5 points per point lost' },
    { key: 'failures', label: 'Few repeated failures', value: started.length ? Math.round(100 - (stats.repeatedFailures / started.length) * 100) : null, weight: 10 },
  ];
  const usable = parts.filter((p) => p.value !== null);
  const weightSum = usable.reduce((n, p) => n + p.weight, 0);
  stats.indicator = {
    label: 'Training effectiveness indicator',
    disclaimer: 'An internal operational indicator to help prioritise where to look. It is not scientifically validated and does not prove that the training caused any change.',
    score: recipients.length >= MIN_SAMPLE && weightSum > 0 ? Math.round(usable.reduce((n, p) => n + p.value * p.weight, 0) / weightSum) : null,
    parts: parts.map((p) => ({ ...p, used: p.value !== null, effectiveWeight: p.value !== null && weightSum ? Math.round((p.weight / weightSum) * 100) : 0 })),
    reason: recipients.length < MIN_SAMPLE ? `Needs at least ${MIN_SAMPLE} people who took this training.` : null,
  };
  return stats;
}

/** Effectiveness rows for the organization's published trainings that have been assigned to someone. */
async function organizationEffectiveness(organizationId, { limit = 40, now = new Date() } = {}) {
  const courses = await prisma.trainingCourse.findMany({ where: { organizationId, status: 'PUBLISHED', archivedAt: null, assignments: { some: {} } }, select: { id: true }, orderBy: { createdAt: 'desc' }, take: limit });
  const out = [];
  for (const c of courses) out.push(await courseEffectiveness(organizationId, c.id, { now }));
  return out.filter(Boolean);
}

module.exports = { courseEffectiveness, organizationEffectiveness, MIN_SAMPLE, asOf };
