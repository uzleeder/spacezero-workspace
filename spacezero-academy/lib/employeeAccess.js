'use strict';

// Server-side authorization for employee records, setup, vacation and the Credential Vault. Every
// route re-checks these; hiding a link in EJS is never the boundary.
const { prisma } = require('./prisma');
const { canViewProfile, isSupervisorOfAgent } = require('./authz');
const { getSetting } = require('./orgSettings');
const { hasCapability } = require('./supervisorCapabilities');

/**
 * Loads an employee the actor is allowed to see (self, admin, or the supervisor assigned to them).
 * Returns { employee, isSelf, manage } or null. `manage` = may verify setup / edit their record.
 */
async function loadEmployeeFor(actor, id) {
  if (!actor || !id) return null;
  if (!await canViewProfile(actor, id)) return null;
  const employee = await prisma.profile.findFirst({
    where: { id, organizationId: actor.organizationId },
    include: { teamMemberships: { include: { team: true } }, supervisedBy: { where: { unassignedAt: null }, include: { supervisor: true } } },
  });
  if (!employee) return null;
  const isSelf = employee.id === actor.id;
  const manage = !isSelf && (actor.role === 'ADMIN' || actor.role === 'SUPERVISOR');
  return { employee, isSelf, manage };
}

async function hasCredentialGrant(ownerId, granteeId) {
  return Boolean(await prisma.credentialGrant.findFirst({ where: { ownerId, granteeId }, select: { id: true } }));
}

/**
 * Credential rules:
 *  - Travel Agent's credentials: the agent (if org policy permits), an Admin, and their assigned
 *    Supervisor ONLY if that Supervisor holds the explicit, Admin-granted 'credentials.view_team'
 *    capability — "Manage Team Setup" never implies this; a Supervisor has no credential access by
 *    default, matching every other Admin-grantable capability in lib/supervisorCapabilities.js.
 *  - Supervisor's / Flight Expert's credentials: the owner (if permitted) and an Admin only.
 *  - Admin's credentials: that admin, plus other admins ONLY through an explicit CredentialGrant.
 *  - Never while impersonating (the impersonator does not know the target's password).
 * `view` = may reveal (after re-authentication); `manage` = may create/update/delete.
 */
async function credentialAccess(actor, owner, { impersonating = false } = {}) {
  const none = { view: false, manage: false };
  if (!actor || !owner || impersonating) return none;
  if (actor.organizationId !== owner.organizationId || actor.status !== 'ACTIVE') return none;

  const ownerCanView = await getSetting(actor.organizationId, 'credentials.ownerCanView');
  const isOwner = actor.id === owner.id;

  if (owner.role === 'ADMIN') {
    if (actor.role !== 'ADMIN') return none;
    if (isOwner) return { view: true, manage: true }; // an admin always controls their own vault
    return (await hasCredentialGrant(owner.id, actor.id)) ? { view: true, manage: true } : none;
  }

  if (actor.role === 'ADMIN') {
    // Admin authority over other roles still respects another admin's private test profiles.
    return (await canViewProfile(actor, owner.id)) ? { view: true, manage: true } : none;
  }

  if (isOwner) return { view: ownerCanView, manage: false };

  if (actor.role === 'SUPERVISOR' && owner.role === 'TRAVEL_AGENT' && await isSupervisorOfAgent(actor.id, owner.id) && await hasCapability(actor, 'credentials.view_team')) {
    return { view: true, manage: true };
  }
  return none;
}

module.exports = { loadEmployeeFor, credentialAccess, hasCredentialGrant };
