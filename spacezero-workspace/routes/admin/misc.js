'use strict';

const express = require('express');
const router = express.Router();

const { prisma } = require('../../lib/prisma');
const { requireAdmin } = require('../../lib/authMiddleware');
const { requireSystemConfigAccess } = require('../../lib/supervisorCapabilities');
const { roleLabel } = require('../../lib/roles');

const AUDIT_AREAS = ['credential', 'setup', 'leave', 'employee', 'training', 'policy'];

// The Audit Log and org-wide Analytics are "Admin Configuration" (Task 3, System & Security) — not
// day-to-day employee management. Call reviews (below) stay plain Admin-only: routine oversight.
router.get('/audit-logs', requireAdmin, requireSystemConfigAccess, async (req, res) => {
  const admin = req.profile;
  const logs = await prisma.auditLog.findMany({
    where: { organizationId: admin.organizationId, ...(AUDIT_AREAS.includes(req.query.area) ? { action: { startsWith: req.query.area + '.' } } : {}) },
    include: { actor: true },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.render('admin/audit-logs', { title: 'Settings & Security', logs });
});

const ROLES = ['ADMIN', 'SUPERVISOR', 'TRAVEL_AGENT', 'FLIGHT_EXPERT'];

router.get('/analytics', requireAdmin, requireSystemConfigAccess, async (req, res) => {
  const admin = req.profile;
  const orgId = admin.organizationId;

  const byRole = await Promise.all(
    ROLES.map(async (role) => ({
      role,
      count: await prisma.profile.count({ where: { organizationId: orgId, role, status: { not: 'ARCHIVED' } } }),
    }))
  );
  const [totalActive, totalAttempts, completedAttempts, libraryCount, teamCount] = await Promise.all([
    prisma.profile.count({ where: { organizationId: orgId, status: 'ACTIVE' } }),
    prisma.trainingAttempt.count({ where: { profile: { organizationId: orgId } } }),
    prisma.trainingAttempt.count({ where: { profile: { organizationId: orgId }, status: 'COMPLETED' } }),
    prisma.libraryItem.count({ where: { organizationId: orgId, archivedAt: null } }),
    prisma.team.count({ where: { organizationId: orgId, archivedAt: null } }),
  ]);

  const completionRate = totalAttempts > 0 ? Math.round((completedAttempts / totalAttempts) * 100) : 0;
  const maxRoleCount = Math.max(1, ...byRole.map((r) => r.count));

  res.render('admin/analytics', {
    title: 'Settings & Security',
    totalActive,
    teamCount,
    libraryCount,
    completionRate,
    byRole,
    maxRoleCount,
    roleLabel,
  });
});

// Admins can access every call review company-wide.
router.get('/call-reviews', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const reviews = await prisma.callReview.findMany({
    where: { organizationId: admin.organizationId },
    include: { agent: true, supervisor: true },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.render('admin/call-reviews', { title: 'Call reviews', reviews });
});

module.exports = router;
