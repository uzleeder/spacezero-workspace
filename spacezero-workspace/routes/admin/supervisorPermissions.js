'use strict';

// Settings & Security → Supervisor permissions. Admin only, checked server-side on every request.
// A Supervisor has no management capability by default; an Admin grants each one individually,
// scoped only within that Supervisor's existing team boundary (this never widens WHO a Supervisor
// may act on — lib/employeeAccess.js's team-scope check is unchanged and always still applies).
const express = require('express');
const router = express.Router();

const { prisma } = require('../../lib/prisma');
const { requireAdmin } = require('../../lib/authMiddleware');
const { logAudit } = require('../../lib/audit');
const { CAPABILITIES, CAPABILITY_KEYS, CATEGORIES, capabilitiesFor, requireSystemConfigAccess } = require('../../lib/supervisorCapabilities');

const notFound = (res) => res.status(404).render('not-found', { layout: false });
const asList = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]).map(String);

async function loadSupervisor(admin, id) {
  return prisma.profile.findFirst({ where: { id, organizationId: admin.organizationId, role: 'SUPERVISOR' } });
}

// The full list ("global permission architecture") lives under Admin Configuration and needs
// System Configuration Access. Granting ONE supervisor's permissions (:id below) stays plain
// Admin-only — Task 3's "easy person-level management", conveniently reachable straight from that
// supervisor's own Employees & Teams profile without a trip through Admin Configuration.
router.get('/supervisor-permissions', requireAdmin, requireSystemConfigAccess, async (req, res) => {
  const admin = req.profile;
  const supervisors = await prisma.profile.findMany({ where: { organizationId: admin.organizationId, role: 'SUPERVISOR', status: { not: 'ARCHIVED' } }, orderBy: { fullName: 'asc' } });
  const grants = await prisma.supervisorCapability.findMany({ where: { organizationId: admin.organizationId } });
  const grantsBySupervisor = new Map();
  for (const g of grants) {
    if (!grantsBySupervisor.has(g.supervisorId)) grantsBySupervisor.set(g.supervisorId, new Set());
    grantsBySupervisor.get(g.supervisorId).add(g.key);
  }
  res.render('admin/supervisor-permissions/list', {
    title: 'Supervisor permissions',
    supervisors, grantsBySupervisor, CAPABILITIES,
    saved: req.query.saved === '1',
  });
});

router.get('/supervisor-permissions/:id', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const supervisor = await loadSupervisor(admin, req.params.id);
  if (!supervisor) return notFound(res);
  const granted = await capabilitiesFor(supervisor.id);
  res.render('admin/supervisor-permissions/edit', {
    title: `Permissions — ${supervisor.fullName}`,
    supervisor, granted, CAPABILITIES, CATEGORIES,
  });
});

router.post('/supervisor-permissions/:id', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const supervisor = await loadSupervisor(admin, req.params.id);
  if (!supervisor) return notFound(res);

  const requested = new Set(asList(req.body.capabilities).filter((k) => CAPABILITY_KEYS.includes(k)));
  const before = await capabilitiesFor(supervisor.id);
  const toGrant = [...requested].filter((k) => !before.has(k));
  const toRevoke = [...before].filter((k) => !requested.has(k));

  if (toGrant.length || toRevoke.length) {
    await prisma.$transaction([
      ...(toRevoke.length ? [prisma.supervisorCapability.deleteMany({ where: { organizationId: admin.organizationId, supervisorId: supervisor.id, key: { in: toRevoke } } })] : []),
      ...toGrant.map((key) => prisma.supervisorCapability.create({ data: { organizationId: admin.organizationId, supervisorId: supervisor.id, key, grantedById: admin.id } })),
    ]);
    for (const key of toGrant) await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'supervisor.capability_granted', targetTable: 'Profile', targetId: supervisor.id, metadata: { key } });
    for (const key of toRevoke) await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'supervisor.capability_revoked', targetTable: 'Profile', targetId: supervisor.id, metadata: { key } });
  }

  res.redirect('/admin/supervisor-permissions?saved=1');
});

module.exports = router;
