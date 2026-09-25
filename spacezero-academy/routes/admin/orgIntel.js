'use strict';

// Admin organization intelligence and training effectiveness. Admin only, organization-scoped.
const express = require('express');
const router = express.Router();
const { prisma } = require('../../lib/prisma');
const { requireAdmin } = require('../../lib/authMiddleware');
const { organizationIntelligence, ANALYZED_ROLES } = require('../../lib/orgIntel');
const { organizationEffectiveness, courseEffectiveness } = require('../../lib/effectiveness');
const { roleLabel } = require('../../lib/roles');
const { WEAK } = require('../../lib/teamIntel');

router.get('/intelligence', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const role = ANALYZED_ROLES.includes(req.query.role) ? req.query.role : '';
  const teamId = typeof req.query.teamId === 'string' ? req.query.teamId : '';
  const team = teamId ? await prisma.team.findFirst({ where: { id: teamId, organizationId: admin.organizationId } }) : null;
  const intel = await organizationIntelligence(admin, { role, teamId: team ? team.id : '' });
  res.set('Cache-Control', 'private, no-store');
  res.render('admin/intelligence', { title: 'Organization intelligence', intel, roleLabel, WEAK, role, team, ANALYZED_ROLES });
});

router.get('/intelligence/training', requireAdmin, async (req, res) => {
  const rows = await organizationEffectiveness(req.profile.organizationId);
  res.render('admin/effectiveness', { title: 'Training effectiveness', rows, detail: null });
});

router.get('/intelligence/training/:id', requireAdmin, async (req, res) => {
  const detail = await courseEffectiveness(req.profile.organizationId, req.params.id);
  if (!detail) return res.status(404).render('not-found', { layout: false });
  res.render('admin/effectiveness', { title: `Effectiveness — ${detail.course.title}`, rows: [], detail });
});

module.exports = router;