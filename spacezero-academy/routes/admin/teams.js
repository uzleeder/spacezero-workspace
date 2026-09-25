'use strict';

const express = require('express');
const router = express.Router();

const { prisma } = require('../../lib/prisma');
const { requireAdmin } = require('../../lib/authMiddleware');
const { TeamSchema } = require('../../lib/validation');
const { logAudit } = require('../../lib/audit');
const { loadSetupForProfiles } = require('../../lib/employeeSetup');

/** Teams with their supervisor and agents, each with setup readiness. The relationships are the ones that drive authorization. */
async function loadHierarchy(admin) {
  const teams = await prisma.team.findMany({
    where: { organizationId: admin.organizationId },
    include: { memberships: { include: { profile: true } } },
    orderBy: [{ archivedAt: 'asc' }, { name: 'asc' }],
  });
  const assignments = await prisma.supervisorAssignment.findMany({ where: { unassignedAt: null, supervisor: { organizationId: admin.organizationId } }, include: { supervisor: true } });
  const supervisorOf = new Map(assignments.map((a) => [a.agentId, a.supervisor]));
  const visible = (m) => !m.profile.testOwnerAdminId || m.profile.testOwnerAdminId === admin.id;
  const everyone = teams.flatMap((t) => t.memberships.filter(visible).map((m) => m.profile));
  const setups = await loadSetupForProfiles(admin.organizationId, [...new Map(everyone.map((p) => [p.id, p])).values()]);
  return {
    setups,
    teams: teams.map((team) => {
      const members = team.memberships.filter(visible).map((m) => m.profile).sort((x, y) => x.fullName.localeCompare(y.fullName));
      return {
        team,
        supervisors: members.filter((p) => p.role === 'SUPERVISOR'),
        agents: members.filter((p) => p.role === 'TRAVEL_AGENT').map((p) => ({ profile: p, supervisor: supervisorOf.get(p.id) || null })),
        others: members.filter((p) => !['SUPERVISOR', 'TRAVEL_AGENT'].includes(p.role)),
      };
    }),
  };
}

router.get('/teams', requireAdmin, async (req, res) => {
  const { teams, setups } = await loadHierarchy(req.profile);
  res.render('admin/teams', { title: 'Employees & Teams', hierarchy: teams, setups, error: null, fieldErrors: {} });
});

router.post('/teams', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const parsed = TeamSchema.safeParse({ name: req.body.name, description: req.body.description || undefined });
  if (!parsed.success) {
    const { teams, setups } = await loadHierarchy(admin);
    return res.status(400).render('admin/teams', { title: 'Employees & Teams', hierarchy: teams, setups, error: null, fieldErrors: parsed.error.flatten().fieldErrors });
  }

  const team = await prisma.team.create({
    data: { organizationId: admin.organizationId, name: parsed.data.name, description: parsed.data.description, createdById: admin.id },
  });
  await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'team.created', targetTable: 'Team', targetId: team.id, metadata: { name: team.name } });

  res.redirect('/admin/teams');
});

router.post('/teams/:id/archive', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const owned = await prisma.team.findFirst({ where: { id: req.params.id, organizationId: admin.organizationId } });
  if (!owned) return res.status(404).json({ error: 'Not found' });
  await prisma.team.update({ where: { id: owned.id }, data: { archivedAt: new Date() } });
  await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'team.archived', targetTable: 'Team', targetId: req.params.id });
  res.json({ ok: true });
});

router.get('/teams/:id', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const team = await prisma.team.findFirst({
    where: { id: req.params.id, organizationId: admin.organizationId },
    include: {
      memberships: { include: { profile: true }, orderBy: { joinedAt: 'asc' } },
      trainingAssignments: { include: { course: true }, orderBy: { createdAt: 'desc' }, take: 10 },
    },
  });
  if (!team) return res.status(404).render('not-found', { layout: false });
  res.render('admin/teams/detail', { title: 'Employees & Teams', team });
});

module.exports = router;
