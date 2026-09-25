'use strict';

const { prisma } = require('./prisma');

// Lazily makes sure a profile has an EmployeeSkill row (score 0, confidence
// 0) for every active skill that applies to their role. Called whenever a
// skill graph is rendered, instead of maintaining fragile creation-time
// triggers — this way adding a new Skill later automatically reaches every
// relevant employee's graph the next time they open it.
const inflight = new Map(); // one ensure per person at a time: a page asks for the skill graph from several panels at once
async function ensureEmployeeSkills(profileId, organizationId, role) {
  const key = `${profileId}|${role}`;
  if (inflight.has(key)) return inflight.get(key);
  const run = ensureRows(profileId, organizationId, role).finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

async function ensureRows(profileId, organizationId, role) {
  const applicableSkills = await prisma.skill.findMany({
    where: { organizationId, isActive: true, OR: [{ roleKey: role }, { roleKey: null }] },
    select: { id: true },
  });

  const existing = await prisma.employeeSkill.findMany({
    where: { profileId, skillId: { in: applicableSkills.map((s) => s.id) } },
    select: { skillId: true },
  });
  const existingIds = new Set(existing.map((e) => e.skillId));
  const missing = applicableSkills.filter((s) => !existingIds.has(s.id));

  if (missing.length > 0) {
    try {
      await prisma.employeeSkill.createMany({ data: missing.map((s) => ({ profileId, skillId: s.id })) });
    } catch (err) {
      // Two requests for the same person (a page loads several panels at once) can race; whoever loses simply finds the rows there.
      if (!err || err.code !== 'P2002') throw err;
      for (const s of missing) {
        try { await prisma.employeeSkill.create({ data: { profileId, skillId: s.id } }); } catch (e) { if (!e || e.code !== 'P2002') throw e; }
      }
    }
  }
}

async function getSkillGraph(profileId) {
  return prisma.employeeSkill.findMany({
    where: { profileId },
    include: { skill: true },
    orderBy: [{ skill: { category: 'asc' } }, { skill: { displayOrder: 'asc' } }],
  });
}

// Phase 1 records coaching observations without manufacturing competency scores.
async function recordSkillEvidence({ employeeSkillId, recordedById, notes }) {
  if (!notes || !notes.trim()) throw new Error('Evidence notes are required');
  await prisma.$transaction([
    prisma.employeeSkill.update({ where: { id: employeeSkillId }, data: { evidenceCount: { increment: 1 } } }),
    prisma.skillEvidence.create({ data: { employeeSkillId, recordedById, sourceType: 'MANUAL_ADJUSTMENT', notes, scoreImpact: null } }),
  ]);
}

module.exports = { ensureEmployeeSkills, getSkillGraph, recordSkillEvidence };
