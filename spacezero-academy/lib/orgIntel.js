'use strict';

// Organization intelligence for Admins: "How capable is our workforce, where are the gaps, which teams
// need help, which training works?" Built on the cached skill aggregates, so the cost is a handful of
// indexed queries however much evidence exists. Drill-down: organization -> role -> team -> employee -> skill -> evidence.
const { prisma } = require('./prisma');
const { organizationPulse, loadLearning, WEAK } = require('./teamIntel');
const { excludeOtherAdminsTestProfiles } = require('./loginAsScope');

const ANALYZED_ROLES = ['TRAVEL_AGENT', 'FLIGHT_EXPERT', 'SUPERVISOR']; // Admins are management, not part of the competency picture
const avg = (list) => (list.length ? Math.round(list.reduce((n, x) => n + x, 0) / list.length) : null);
const monthKey = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

async function organizationIntelligence(actor, { role = '', teamId = '', now = new Date() } = {}) {
  const organizationId = actor.organizationId;
  const people = await prisma.profile.findMany({
    where: { organizationId, status: 'ACTIVE', role: { in: ANALYZED_ROLES }, ...excludeOtherAdminsTestProfiles(actor) },
    select: { id: true, fullName: true, role: true, employmentStartDate: true, teamMemberships: { select: { team: { select: { id: true, name: true } } } }, supervisedBy: { where: { unassignedAt: null }, select: { supervisor: { select: { id: true, fullName: true } } } } },
    orderBy: { fullName: 'asc' },
  });
  const ids = people.map((p) => p.id);
  const pulse = await organizationPulse(organizationId, ids, { now });
  const learning = await loadLearning(ids, now);
  const aggregates = pulse.aggregates;
  const personById = new Map(people.map((p) => [p.id, p]));
  const byPerson = new Map(ids.map((id) => [id, []]));
  for (const a of aggregates) byPerson.get(a.profileId)?.push(a);
  const teamOf = (p) => (p.teamMemberships[0] ? p.teamMemberships[0].team : null);

  // ---- role groups and their skill maps
  const roleGroups = ANALYZED_ROLES.map((r) => {
    const members = people.filter((p) => p.role === r);
    const rows = aggregates.filter((a) => personById.get(a.profileId)?.role === r);
    const skillMap = new Map();
    for (const a of rows) { const e = skillMap.get(a.skill.id) || { skill: a.skill, scores: [], weak: 0 }; e.scores.push(a.currentScore); if (a.currentScore < WEAK) e.weak += 1; skillMap.set(a.skill.id, e); }
    return {
      role: r, employees: members.length, average: avg(rows.map((a) => a.currentScore)), assessed: rows.length,
      skills: [...skillMap.values()].map((e) => ({ skill: e.skill, average: avg(e.scores), assessed: e.scores.length, weak: e.weak })).sort((a, b) => a.average - b.average),
    };
  });

  // ---- common weaknesses across the organization (people below 70, then lowest average)
  const overall = new Map();
  for (const a of aggregates) { const e = overall.get(a.skill.id) || { skill: a.skill, scores: [], weak: 0 }; e.scores.push(a.currentScore); if (a.currentScore < WEAK) e.weak += 1; overall.set(a.skill.id, e); }
  const weaknesses = [...overall.values()].filter((e) => e.weak > 0).map((e) => ({ skill: e.skill, average: avg(e.scores), assessed: e.scores.length, weak: e.weak })).sort((a, b) => b.weak - a.weak || a.average - b.average).slice(0, 10);

  // ---- team comparison
  const teams = new Map();
  for (const p of people) {
    const t = teamOf(p); if (!t) continue;
    const e = teams.get(t.id) || { team: t, members: [] };
    e.members.push(p.id); teams.set(t.id, e);
  }
  const teamRows = [...teams.values()].map((t) => {
    const set = new Set(t.members);
    const rows = aggregates.filter((a) => set.has(a.profileId));
    const learn = learning.filter((l) => set.has(l.profileId));
    return { team: t.team, employees: t.members.length, average: avg(rows.map((a) => a.currentScore)), weak: rows.filter((a) => a.currentScore < WEAK).length, retakes: learn.filter((l) => l.retake).length, overdue: learn.filter((l) => l.overdue).length, assessed: rows.length };
  }).sort((a, b) => (a.average ?? 101) - (b.average ?? 101));

  // ---- supervisors as learners
  const supervisors = people.filter((p) => p.role === 'SUPERVISOR').map((p) => {
    const learn = learning.filter((l) => l.profileId === p.id);
    const rows = byPerson.get(p.id) || [];
    return { person: p, assigned: learn.length, completed: learn.filter((l) => l.status === 'COMPLETED').length, overdue: learn.filter((l) => l.overdue).length, average: avg(rows.map((a) => a.currentScore)) };
  });

  // ---- improvement trend: average of each skill's last score per month
  const since = new Date(now.getTime() - 200 * 86400000);
  const history = ids.length ? await prisma.skillScoreHistory.findMany({ where: { recordedAt: { gte: since }, employeeSkill: { profileId: { in: ids } } }, select: { employeeSkillId: true, score: true, recordedAt: true }, orderBy: { recordedAt: 'asc' } }) : [];
  const lastPerMonth = new Map();
  for (const h of history) lastPerMonth.set(`${monthKey(h.recordedAt)}|${h.employeeSkillId}`, h.score);
  const perMonth = new Map();
  for (const [key, score] of lastPerMonth) { const m = key.split('|')[0]; const list = perMonth.get(m) || []; list.push(score); perMonth.set(m, list); }
  const trend = [...perMonth.entries()].sort().map(([month, scores]) => ({ month, average: avg(scores), skills: scores.length }));

  // ---- drill-down list (role and/or team) — employees with their skills
  let drill = null;
  if (role || teamId) {
    const wanted = people.filter((p) => (!role || p.role === role) && (!teamId || teamOf(p)?.id === teamId));
    drill = wanted.map((p) => {
      const rows = byPerson.get(p.id) || [];
      const learn = learning.filter((l) => l.profileId === p.id);
      return { person: p, team: teamOf(p), supervisor: p.supervisedBy[0] ? p.supervisedBy[0].supervisor : null, average: avg(rows.map((a) => a.currentScore)), assessed: rows.length, weak: rows.filter((a) => a.currentScore < WEAK).length, retakes: learn.filter((l) => l.retake).length, overdue: learn.filter((l) => l.overdue).length, weakest: [...rows].sort((a, b) => a.currentScore - b.currentScore).slice(0, 2).map((a) => ({ name: a.skill.name, score: Math.round(a.currentScore) })) };
    });
  }

  const { aggregates: _drop, ...pulseNumbers } = pulse;
  return { pulse: pulseNumbers, employees: people.length, roleGroups, weaknesses, teams: teamRows, supervisors, trend, drill, filters: { role, teamId } };
}

module.exports = { organizationIntelligence, ANALYZED_ROLES };
