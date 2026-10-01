'use strict';

// Admin Configuration. The former standalone hub page now lives inside Settings → Advanced
// (routes/admin/settings.js renders lib/adminConfigurationSections.js there) — this route just
// redirects old bookmarks/links to it, so nothing that pointed at /admin/configuration breaks.
// System Configuration Access grant/revoke stays its own page, linked from the Advanced tab.
// Every route here still needs the explicit System Configuration Access capability, checked
// server-side — a 403 for an unauthorized Admin happens before the redirect ever runs.
const express = require('express');
const router = express.Router();

const { prisma } = require('../../lib/prisma');
const { requireAdmin } = require('../../lib/authMiddleware');
const { logAudit } = require('../../lib/audit');
const { SYSTEM_CONFIG_KEY, requireSystemConfigAccess } = require('../../lib/supervisorCapabilities');

const advanced = [requireAdmin, requireSystemConfigAccess];

router.get('/configuration', advanced, (req, res) => {
  res.redirect('/admin/settings?tab=advanced');
});

// ------------------------------------------------------------------ System Configuration Access
router.get('/configuration/system-access', advanced, async (req, res) => {
  const admin = req.profile;
  const admins = await prisma.profile.findMany({ where: { organizationId: admin.organizationId, role: 'ADMIN', status: { not: 'ARCHIVED' } }, orderBy: { fullName: 'asc' } });
  const grants = await prisma.supervisorCapability.findMany({ where: { organizationId: admin.organizationId, key: SYSTEM_CONFIG_KEY }, select: { supervisorId: true } });
  const grantedIds = new Set(grants.map((g) => g.supervisorId));
  res.render('admin/configuration/system-access', {
    title: 'System Configuration Access',
    admins, grantedIds, selfId: admin.id,
    saved: req.query.saved === '1',
  });
});

router.post('/configuration/system-access/:id', advanced, async (req, res) => {
  const admin = req.profile;
  const target = await prisma.profile.findFirst({ where: { id: req.params.id, organizationId: admin.organizationId, role: 'ADMIN' } });
  if (!target) return res.status(404).render('not-found', { layout: false });

  const grant = req.body.access === '1';
  const existing = await prisma.supervisorCapability.findUnique({ where: { organizationId_supervisorId_key: { organizationId: admin.organizationId, supervisorId: target.id, key: SYSTEM_CONFIG_KEY } } });

  if (grant && !existing) {
    await prisma.supervisorCapability.create({ data: { organizationId: admin.organizationId, supervisorId: target.id, key: SYSTEM_CONFIG_KEY, grantedById: admin.id } });
    await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'admin.system_config_access_granted', targetTable: 'Profile', targetId: target.id, metadata: { target: target.fullName } });
  } else if (!grant && existing) {
    await prisma.supervisorCapability.delete({ where: { id: existing.id } });
    await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'admin.system_config_access_revoked', targetTable: 'Profile', targetId: target.id, metadata: { target: target.fullName } });
  }
  res.redirect('/admin/configuration/system-access?saved=1');
});

module.exports = router;
