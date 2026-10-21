'use strict';

// The organization's skill catalog (Settings → Skills) as practice uses it. The AI is given the catalog names to
// tag questions, role-plays and simulations with, and a result is written to the Skill Graph only against a
// skill of the learner's own role (or one that applies to every role), matched ignoring case and spacing - so
// practice results actually reach the Skill Graph, and a name two roles share ("Aircraft Knowledge") lands on
// the learner's one. Names that match no skill are still shown, they just write no evidence.
const { prisma } = require('./prisma');
const { parseAudience } = require('./courseAudience');

const key = (name) => String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** The roles a course is meant for (its audience), or null when it is meant for everyone. */
function courseRoles(course) {
  const roles = new Set(parseAudience(course).roles || []);
  if (course.roleKey) roles.add(course.roleKey);
  return roles.size ? [...roles] : null;
}

/** The active catalog skill names for a course's audience, each name once (several roles may share one). */
async function catalogNamesFor(course) {
  if (!course || !course.organizationId) return [];
  const roles = courseRoles(course);
  const skills = await prisma.skill.findMany({
    where: { organizationId: course.organizationId, isActive: true, ...(roles ? { OR: [{ roleKey: { in: roles } }, { roleKey: null }] } : {}) },
    orderBy: [{ roleKey: 'asc' }, { displayOrder: 'asc' }],
    select: { name: true },
  });
  const byKey = new Map();
  for (const s of skills) if (!byKey.has(key(s.name))) byKey.set(key(s.name), s.name);
  return [...byKey.values()];
}

/** AI-written skill names in the catalog's exact spelling where they match one; any other name is kept as written. */
function toCatalog(names, catalog) {
  const byKey = new Map((catalog || []).map((n) => [key(n), n]));
  return [...new Set((names || []).map((n) => byKey.get(key(n)) || String(n).trim()).filter(Boolean))];
}

/** For one learner: skill name -> id of the catalog skill of their role (else one for every role), or null. */
async function skillMatcher(organizationId, role) {
  const skills = await prisma.skill.findMany({ where: { organizationId, isActive: true, OR: role ? [{ roleKey: role }, { roleKey: null }] : [{ roleKey: null }] }, select: { id: true, name: true, roleKey: true } });
  const byKey = new Map();
  for (const s of [...skills].sort((a, b) => (a.roleKey ? 0 : 1) - (b.roleKey ? 0 : 1))) if (!byKey.has(key(s.name))) byKey.set(key(s.name), s.id);
  return (name) => byKey.get(key(name)) || null;
}

module.exports = { key, courseRoles, catalogNamesFor, toCatalog, skillMatcher };
