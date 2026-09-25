'use strict';

const { prisma } = require('./prisma');

// Central place for "can actor X act on target Y" checks. Every mutating
// route re-checks these server-side; the UI hides controls the user can't
// use, but that is convenience, not the security boundary.

async function isSupervisorOfAgent(supervisorId, agentId) {
  const supervisor = await prisma.profile.findUnique({ where: { id: supervisorId } });
  if (!supervisor || supervisor.role !== 'SUPERVISOR' || supervisor.status !== 'ACTIVE') return false;
  const assignment = await prisma.supervisorAssignment.findFirst({
    where: { supervisorId, agentId, unassignedAt: null, agent: { organizationId: supervisor.organizationId, role: { in: ['TRAVEL_AGENT', 'FLIGHT_EXPERT'] }, archivedAt: null } },
    select: { id: true },
  });
  return assignment !== null;
}

async function supervisedProfileIds(supervisorId) {
  const supervisor = await prisma.profile.findUnique({ where: { id: supervisorId } });
  if (!supervisor || supervisor.role !== 'SUPERVISOR' || supervisor.status !== 'ACTIVE') return [];
  const rows = await prisma.supervisorAssignment.findMany({
    where: { supervisorId, unassignedAt: null, agent: { organizationId: supervisor.organizationId, role: { in: ['TRAVEL_AGENT', 'FLIGHT_EXPERT'] }, archivedAt: null } },
    select: { agentId: true },
  });
  return rows.map((r) => r.agentId);
}

async function canViewProfile(actor, targetId) {
  if (!actor || actor.status !== 'ACTIVE') return false;
  const target = await prisma.profile.findFirst({ where: { id: targetId, organizationId: actor.organizationId } });
  if (!target) return false;
  if (actor.id === targetId) return true;
  // Another admin's private test account (testOwnerAdminId) is invisible to
  // everyone but its owner, regardless of role.
  if (target.testOwnerAdminId && target.testOwnerAdminId !== actor.id) return false;
  if (actor.role === 'ADMIN') return true;
  if (actor.role === 'SUPERVISOR') return isSupervisorOfAgent(actor.id, targetId);
  return false;
}

async function teamIdsForSupervisor(supervisorId) {
  const supervisor = await prisma.profile.findUnique({ where: { id: supervisorId } });
  if (!supervisor || supervisor.role !== 'SUPERVISOR' || supervisor.status !== 'ACTIVE') return [];
  const memberships = await prisma.teamMembership.findMany({
    where: { profileId: supervisorId, team: { organizationId: supervisor.organizationId, archivedAt: null } },
    select: { teamId: true },
  });
  return memberships.map((m) => m.teamId);
}

module.exports = { isSupervisorOfAgent, supervisedProfileIds, canViewProfile, teamIdsForSupervisor };
