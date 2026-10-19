'use strict';

// "Who is this material relevant to?" — a RECOMMENDATION built from Phase 3 skill data, shown after analysis.
// It never assigns anything: the Admin assigns through Training. Only cached skill aggregates are read
// (EmployeeSkill), never raw evidence, and only for active employees of the Admin's own organization.
const { prisma } = require('./prisma');
const { excludeOtherAdminsTestProfiles } = require('./loginAsScope');
const { roleLabel } = require('./roles');

const WEAK = 70;
const ROLES = ['TRAVEL_AGENT', 'FLIGHT_EXPERT', 'SUPERVISOR'];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function relevanceFor(actor, { skills = [], audienceRoles = [] } = {}) {
  const names = skills.map((s) => String(s.name || s).trim().toLowerCase()).filter(Boolean);
  if (!names.length) return { available: false, lines: [], skills: [], teams: [], roles: [] };
  const roles = (audienceRoles || []).filter((r) => ROLES.includes(r));
  const orgSkills = (await prisma.skill.findMany({ where: { organizationId: actor.organizationId, isActive: true }, select: { id: true, name: true, roleKey: true } })).filter((s) => names.includes(s.name.trim().toLowerCase()));
  if (!orgSkills.length) return { available: true, lines: [], skills: [], teams: [], roles, note: 'None of the detected skills are in the Skill Graph yet, so team relevance cannot be measured.' };

  const rows = await prisma.employeeSkill.findMany({
    where: { skillId: { in: orgSkills.map((s) => s.id) }, evidenceCount: { gt: 0 }, currentScore: { lt: WEAK }, profile: { organizationId: actor.organizationId, status: 'ACTIVE', role: { in: roles.length ? roles : ROLES }, ...excludeOtherAdminsTestProfiles(actor) } },
    select: { skillId: true, profileId: true, currentScore: true, profile: { select: { role: true, supervisedBy: { where: { unassignedAt: null }, select: { supervisor: { select: { id: true, fullName: true } } } } } } },
  });

  const skillName = new Map(orgSkills.map((s) => [s.id, s.name]));
  const bySkill = new Map();
  for (const r of rows) { const e = bySkill.get(r.skillId) || new Set(); e.add(r.profileId); bySkill.set(r.skillId, e); }
  const skillRows = [...bySkill.entries()].map(([id, set]) => ({ name: skillName.get(id), weak: set.size })).sort((a, b) => b.weak - a.weak);

  const byRole = new Map();
  for (const r of rows) { const e = byRole.get(r.profile.role) || new Set(); e.add(r.profileId); byRole.set(r.profile.role, e); }
  const roleRows = [...byRole.entries()].map(([role, set]) => ({ role, count: set.size })).sort((a, b) => b.count - a.count);

  const bySupervisor = new Map();
  for (const r of rows) for (const link of r.profile.supervisedBy) {
    const e = bySupervisor.get(link.supervisor.id) || { name: link.supervisor.fullName, people: new Set(), skills: new Map() };
    e.people.add(r.profileId); e.skills.set(r.skillId, (e.skills.get(r.skillId) || 0) + 1);
    bySupervisor.set(link.supervisor.id, e);
  }
  const teams = [...bySupervisor.values()].map((e) => { const [topId, n] = [...e.skills.entries()].sort((a, b) => b[1] - a[1])[0]; return { supervisor: e.name, people: e.people.size, skill: skillName.get(topId), skillCount: n }; }).sort((a, b) => b.people - a.people).slice(0, 5);

  const lines = [];
  for (const t of teams.slice(0, 3)) lines.push(`${plural(t.skillCount, 'member')} of ${t.supervisor}'s team ${t.skillCount === 1 ? 'has' : 'have'} ${t.skill} below ${WEAK}%.`);
  for (const r of roleRows.slice(0, 2)) lines.push(`Relevant to ${plural(r.count, roleLabel(r.role))} with a gap in a skill this material covers.`);
  return { available: true, lines, skills: skillRows, teams, roles: roleRows, threshold: WEAK };
}

module.exports = { relevanceFor, WEAK };
