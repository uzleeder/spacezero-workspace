'use strict';

const express = require('express');
const router = express.Router();

const { prisma } = require('../lib/prisma');
const { requireSession } = require('../lib/authMiddleware');
const { getMyTrainingSummary } = require('../lib/training');
const { supervisedProfileIds } = require('../lib/authz');
const { loadSetupForProfile } = require('../lib/employeeSetup');
const { nextActions } = require('../lib/development');
const { classifySkills, categorySummary } = require('../lib/skillIntel');
const { teamIntelligence } = require('../lib/teamIntel');
const { readinessFor } = require('../lib/readiness');
const { attentionFor } = require('../lib/attention');

const REQUIRED_KINDS = ['OVERDUE', 'RETAKE', 'DUE_SOON', 'ASSIGNED', 'IN_PROGRESS'];

/** Everything the learner-facing parts of a dashboard need, for ANY role (supervisors and admins are learners too). */
async function myDevelopment(profile) {
  const dev = await nextActions(profile);
  const [earned, legacy] = await Promise.all([
    prisma.earnedCertification.findMany({ where: { profileId: profile.id, status: 'ACTIVE' }, include: { definition: { select: { name: true, kind: true } } }, orderBy: { issuedAt: 'desc' }, take: 8 }),
    prisma.certificate.findMany({ where: { profileId: profile.id }, orderBy: { issuedAt: 'desc' }, take: 5 }),
  ]);
  const sections = classifySkills(dev.rows);
  return {
    dev,
    next: dev.next,
    required: dev.items.filter((i) => REQUIRED_KINDS.includes(i.kind)).slice(0, 6),
    recommended: dev.items.filter((i) => !REQUIRED_KINDS.includes(i.kind)).slice(0, 5),
    sections,
    categories: categorySummary(dev.rows),
    completed: dev.learning.filter((l) => l.status === 'COMPLETED').slice(0, 5),
    earned,
    legacy,
    overall: (() => { const a = dev.rows.filter((r) => r.assessed); return a.length ? Math.round(a.reduce((n, r) => n + r.score, 0) / a.length) : null; })(),
  };
}

router.get('/dashboard', requireSession, async (req, res) => {
  const profile = req.profile;
  res.set('Cache-Control', 'private, no-store');

  if (profile.role === 'ADMIN') {
    const orgId = profile.organizationId;
    const [employeeCount, teamCount, courseCount, pendingInvites, me] = await Promise.all([
      prisma.profile.count({ where: { organizationId: orgId, status: { not: 'ARCHIVED' } } }),
      prisma.team.count({ where: { organizationId: orgId, archivedAt: null } }),
      prisma.trainingCourse.count({ where: { organizationId: orgId, status: 'PUBLISHED' } }),
      prisma.profile.count({ where: { organizationId: orgId, status: 'INVITED' } }),
      myDevelopment(profile),
    ]);
    return res.render('dashboard/admin', { title: 'Dashboard', employeeCount, teamCount, courseCount, pendingInvites, attention: await attentionFor(profile), me });
  }

  if (profile.role === 'SUPERVISOR') {
    const agentIds = await supervisedProfileIds(profile.id);
    const agents = await prisma.profile.findMany({ where: { id: { in: agentIds }, status: { not: 'ARCHIVED' } } });
    const [intel, me] = await Promise.all([teamIntelligence(profile.organizationId, agentIds, { limit: 5 }), myDevelopment(profile)]);
    return res.render('dashboard/supervisor', { title: 'Dashboard', agents, retakeCount: intel.summary.retakes, attention: await attentionFor(profile), intel, me });
  }

  const [summary, setup, me] = await Promise.all([getMyTrainingSummary(profile.id), loadSetupForProfile(profile.organizationId, profile), myDevelopment(profile)]);
  const readiness = (await readinessFor(profile.organizationId, [profile], { setupMap: new Map([[profile.id, setup]]) })).get(profile.id) || null;
  res.render('dashboard/agent', { title: 'Dashboard', summary, setup, me, readiness, attention: await attentionFor(profile) });
});

module.exports = router;
