'use strict';

// Team and organization intelligence. Everything here works from the CACHED aggregates (EmployeeSkill),
// the attempts of the given people and a bounded slice of score history — never from raw evidence — so
// it stays fast with hundreds of employees and years of evidence. The caller decides WHICH profile ids
// may be looked at (a Supervisor's own team, or the whole organization for an Admin); nothing here
// widens that set.
const { prisma } = require('./prisma');
const engine = require('./skillEngine');
const { aggregatesFor, historyFor } = require('./skillIntel');
const { trainingStatuses, newestFirst } = require('./trainingCompletion');

const DAY_MS = 86400000;
const WEAK = 70; // the 70% line is used for attention, alongside (not instead of) the configurable status bands

async function loadPeople(organizationId, profileIds) {
  return prisma.profile.findMany({
    where: { id: { in: profileIds }, organizationId, status: 'ACTIVE' },
    select: { id: true, fullName: true, role: true, employmentStartDate: true, teamMemberships: { select: { team: { select: { id: true, name: true } } } }, supervisedBy: { where: { unassignedAt: null }, select: { supervisor: { select: { id: true, fullName: true } } } } },
    orderBy: { fullName: 'asc' },
  });
}

async function loadLearning(profileIds, now) {
  const recipients = await prisma.trainingAssignmentRecipient.findMany({
    where: { profileId: { in: profileIds }, assignment: { course: { status: 'PUBLISHED', archivedAt: null } } },
    include: { attempts: { select: { status: true, attemptNumber: true, score: true, assessmentId: true, createdAt: true, completedAt: true } }, assignment: { select: { dueDate: true, courseId: true, courseVersion: true, assessmentId: true, requiredAttempts: true, minimumScore: true, course: { select: { id: true, title: true, mandatory: true } } } } },
  });
  // The same status My Training shows (lib/trainingCompletion.js), not "the attempt with the highest number".
  const statuses = await trainingStatuses(recipients);
  return recipients.map((r, i) => {
    const latest = [...r.attempts].sort(newestFirst)[0] || null;
    const status = statuses[i];
    const due = r.assignment.dueDate;
    return { profileId: r.profileId, course: r.assignment.course, status, latest, due, overdue: Boolean(due && due < now && status !== 'COMPLETED'), retake: status === 'RETAKE_REQUIRED' || status === 'FAILED' };
  });
}

/**
 * Who needs attention, why, and what improves. `profileIds` must already be authorized by the caller.
 */
async function teamIntelligence(organizationId, profileIds, { now = new Date(), limit = 30 } = {}) {
  const people = await loadPeople(organizationId, profileIds);
  const ids = people.map((p) => p.id);
  const [aggregates, learning] = await Promise.all([aggregatesFor(ids), loadLearning(ids, now)]);

  // Trend inputs: only skills touched recently, so history stays a small slice of the table.
  const recent = aggregates.filter((a) => a.lastEvidenceAt && now - a.lastEvidenceAt < 120 * DAY_MS);
  const history = await historyFor(recent.map((a) => a.id), { sinceDays: 200 });
  const trendOf = new Map(recent.map((a) => [a.id, engine.trendOf(history.get(a.id) || [], { now })]));

  const byPerson = new Map(ids.map((id) => [id, { skills: [], learning: [] }]));
  for (const a of aggregates) byPerson.get(a.profileId)?.skills.push(a);
  for (const l of learning) byPerson.get(l.profileId)?.learning.push(l);

  const attention = []; const improving = [];
  for (const person of people) {
    const data = byPerson.get(person.id);
    const reasons = [];
    const weak = data.skills.filter((s) => s.currentScore < WEAK).sort((a, b) => a.currentScore - b.currentScore);
    const failed = data.learning.filter((l) => l.latest && l.retake);
    const overdue = data.learning.filter((l) => l.overdue);
    const declining = data.skills.filter((s) => trendOf.get(s.id)?.direction === 'declining');
    const improved = data.skills.filter((s) => trendOf.get(s.id)?.direction === 'improving' && trendOf.get(s.id).delta >= 10);
    let priority = 0;
    for (const l of failed) { reasons.push({ type: 'RETAKE', text: `${l.latest.score !== null ? `Scored ${Math.round(l.latest.score)}% on` : 'Failed'} ${l.course.title} — retake required` }); priority += 90; }
    for (const l of overdue) { reasons.push({ type: 'OVERDUE', text: `${l.course.title} is overdue (due ${l.due.toISOString().slice(0, 10)})` }); priority += 70; }
    for (const s of weak.slice(0, 3)) { reasons.push({ type: 'WEAK_SKILL', text: `${s.skill.name} — ${Math.round(s.currentScore)}% (${s.confidenceLevel.toLowerCase()} evidence confidence)` }); priority += 40 + Math.min(30, 70 - s.currentScore); }
    for (const s of declining.slice(0, 2)) { reasons.push({ type: 'DECLINING', text: `${s.skill.name} is declining (${trendOf.get(s.id).delta} points)` }); priority += 35; }
    if (reasons.length) attention.push({ person, reasons, priority, weakSkills: weak.map((s) => ({ id: s.skill.id, name: s.skill.name, score: Math.round(s.currentScore) })) });
    if (improved.length) improving.push({ person, skills: improved.map((s) => ({ name: s.skill.name, delta: trendOf.get(s.id).delta, score: Math.round(s.currentScore) })), best: Math.max(...improved.map((s) => trendOf.get(s.id).delta)) });
  }
  attention.sort((a, b) => b.priority - a.priority);
  improving.sort((a, b) => b.best - a.best);

  // Team skill map: average of ASSESSED scores per skill, and how many people fall below 70.
  const skillMap = new Map();
  for (const a of aggregates) {
    const entry = skillMap.get(a.skill.id) || { skill: a.skill, scores: [], weakIds: [], people: new Set() };
    entry.scores.push(a.currentScore); entry.people.add(a.profileId);
    if (a.currentScore < WEAK) entry.weakIds.push(a.profileId);
    skillMap.set(a.skill.id, entry);
  }
  const skills = [...skillMap.values()].map((e) => ({
    skill: e.skill,
    average: Math.round(e.scores.reduce((n, s) => n + s, 0) / e.scores.length),
    assessed: e.people.size,
    weakCount: e.weakIds.length,
    weakIds: e.weakIds,
    lowConfidence: aggregates.filter((a) => a.skill.id === e.skill.id && a.confidenceLevel === 'LOW').length,
  })).sort((a, b) => a.average - b.average);
  // A team priority needs more than a single person's data.
  const priority = skills.find((s) => s.assessed >= Math.min(2, people.length) && s.average < 80) || null;

  const summary = {
    employees: people.length,
    withAttention: attention.length,
    retakes: learning.filter((l) => l.retake).length,
    overdue: learning.filter((l) => l.overdue).length,
    weakEmployees: attention.filter((a) => a.reasons.some((r) => r.type === 'WEAK_SKILL')).length,
    improving: improving.length,
    teamAverage: aggregates.length ? Math.round(aggregates.reduce((n, a) => n + a.currentScore, 0) / aggregates.length) : null,
  };
  return { people, attention: attention.slice(0, limit), improving: improving.slice(0, 10), skills, priority, summary, learning };
}

/** Everyone in scope who is below `max` (and at or above `min`) on one skill — for "select the affected employees". */
async function peopleBelow(profileIds, skillId, { max = WEAK, min = 0 } = {}) {
  if (!profileIds.length) return [];
  return prisma.employeeSkill.findMany({
    where: { skillId, profileId: { in: profileIds }, evidenceCount: { gt: 0 }, currentScore: { gte: min, lt: max } },
    include: { profile: { select: { id: true, fullName: true, role: true } } },
    orderBy: { currentScore: 'asc' },
  });
}

/** Organization-wide numbers for Admin: rates from attempts, average competency from aggregates. */
async function organizationPulse(organizationId, profileIds, { now = new Date() } = {}) {
  const [aggregates, learning] = await Promise.all([aggregatesFor(profileIds), loadLearning(profileIds, now)]);
  const completed = learning.filter((l) => l.status === 'COMPLETED').length;
  const failedNow = learning.filter((l) => l.retake).length;
  const attempts = await prisma.trainingAttempt.findMany({ where: { profileId: { in: profileIds }, assessmentId: { not: null }, status: { in: ['COMPLETED', 'RETAKE_REQUIRED', 'FAILED'] } }, select: { status: true, recipientId: true, attemptNumber: true } });
  const passed = attempts.filter((a) => a.status === 'COMPLETED').length;
  const failed = attempts.length - passed;
  const retaken = new Set(attempts.filter((a) => a.attemptNumber > 1).map((a) => a.recipientId)).size;
  return {
    assignments: learning.length, completed, completionRate: learning.length ? Math.round((completed / learning.length) * 100) : null,
    attempts: attempts.length, passRate: attempts.length ? Math.round((passed / attempts.length) * 100) : null, failRate: attempts.length ? Math.round((failed / attempts.length) * 100) : null,
    retakeRate: learning.length ? Math.round((retaken / learning.length) * 100) : null, awaitingRetake: failedNow,
    overdue: learning.filter((l) => l.overdue).length,
    averageCompetency: aggregates.length ? Math.round(aggregates.reduce((n, a) => n + a.currentScore, 0) / aggregates.length) : null,
    assessedSkills: aggregates.length,
    aggregates,
  };
}

module.exports = { teamIntelligence, peopleBelow, organizationPulse, loadPeople, loadLearning, WEAK };
