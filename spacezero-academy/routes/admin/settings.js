'use strict';

const express = require('express');
const router = express.Router();

const { prisma } = require('../../lib/prisma');
const { requireAdmin } = require('../../lib/authMiddleware');
const { TenureBandSchema, SkillSchema } = require('../../lib/validation');
const { logAudit } = require('../../lib/audit');
const { roleLabel } = require('../../lib/roles');

async function loadPageData(admin) {
  const [bands, skills] = await Promise.all([
    prisma.tenureBand.findMany({ where: { organizationId: admin.organizationId }, orderBy: { displayOrder: 'asc' } }),
    prisma.skill.findMany({ where: { organizationId: admin.organizationId, isActive: true }, orderBy: [{ roleKey: 'asc' }, { displayOrder: 'asc' }] }),
  ]);
  return { bands, skills };
}

router.get('/settings', requireAdmin, async (req, res) => {
  const { bands, skills } = await loadPageData(req.profile);
  res.render('admin/settings', { title: 'Settings & Security', bands, skills, roleLabel });
});

router.post('/settings/tenure-bands', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const parsed = TenureBandSchema.safeParse({
    label: req.body.label,
    minMonths: req.body.minMonths,
    maxMonths: req.body.maxMonths || undefined,
    displayOrder: req.body.displayOrder || 0,
  });
  if (parsed.success) {
    await prisma.tenureBand.create({
      data: {
        organizationId: admin.organizationId,
        label: parsed.data.label,
        minMonths: parsed.data.minMonths,
        maxMonths: parsed.data.maxMonths ? Number(parsed.data.maxMonths) : null,
        displayOrder: parsed.data.displayOrder,
      },
    });
    await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'settings.tenure_band_created' });
  }
  res.redirect('/admin/settings');
});

router.post('/settings/tenure-bands/:id/delete', requireAdmin, async (req, res) => {
  const admin = req.profile;
  await prisma.tenureBand.deleteMany({ where: { id: req.params.id, organizationId: admin.organizationId } });
  await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'settings.tenure_band_deleted', targetId: req.params.id });
  res.json({ ok: true });
});

router.post('/settings/skills', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const parsed = SkillSchema.safeParse({
    name: req.body.name,
    roleKey: req.body.roleKey || '',
    category: req.body.category || undefined,
  });
  if (parsed.success) {
    await prisma.skill.create({
      data: {
        organizationId: admin.organizationId,
        name: parsed.data.name,
        roleKey: parsed.data.roleKey || null,
        category: parsed.data.category,
      },
    });
    await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'settings.skill_created' });
  }
  res.redirect('/admin/settings');
});

router.post('/settings/skills/:id/deactivate', requireAdmin, async (req, res) => {
  const admin = req.profile;
  await prisma.skill.updateMany({ where: { id: req.params.id, organizationId: admin.organizationId }, data: { isActive: false } });
  res.json({ ok: true });
});

module.exports = router;
