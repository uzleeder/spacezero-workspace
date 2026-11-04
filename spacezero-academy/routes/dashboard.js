'use strict';

const express = require('express');
const router = express.Router();

const { prisma } = require('../lib/prisma');
const { requireSession, requireRole } = require('../lib/authMiddleware');
const { adminDashboard } = require('../lib/adminDashboard');
const { supervisorDashboard } = require('../lib/supervisorDashboard');
const { getMyTrainingSummary } = require('../lib/training');
const { loadSetupForProfile } = require('../lib/employeeSetup');
const { nextActions } = require('../lib/development');
const { classifySkills, categorySummary } = require('../lib/skillIntel');
const { readinessFor } = require('../lib/readiness');
const { attentionFor } = require('../lib/attention');

const REQUIRED_KINDS = ['PATH', 'OVERDUE', 'RETAKE', 'DUE_SOON', 'ASSIGNED', 'IN_PROGRESS']; // PATH = the current step of My Training

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

/** The greeting and today's date, in Tashkent time. */
function hello(profile, now) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', hourCycle: 'h23' }).format(now));
  const part = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  return { greeting: `Good ${part}, ${profile.fullName.split(' ')[0]}.`, today: new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', weekday: 'long', day: 'numeric', month: 'long' }).format(now) };
}
/** The Admin dashboard's data (lib/adminDashboard.js). */
async function adminBoard(profile, now = new Date()) {
  return { dash: await adminDashboard(profile, { now }), ...hello(profile, now) };
}
/** The Supervisor dashboard's data (lib/supervisorDashboard.js): their own team only. */
async function supervisorBoard(profile, now = new Date()) {
  return { sdash: await supervisorDashboard(profile, { now }), ...hello(profile, now) };
}

// The inside of the Admin or Supervisor dashboard on its own, for public/js/dashboard-live.js to refresh it in place.
router.get('/dashboard/live', requireRole('ADMIN', 'SUPERVISOR'), async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  if (req.profile.role === 'ADMIN') return res.render('dashboard/admin-board', { layout: false, ...(await adminBoard(req.profile)) });
  res.render('dashboard/supervisor-board', { layout: false, ...(await supervisorBoard(req.profile)) });
});

router.get('/dashboard', requireSession, async (req, res) => {
  const profile = req.profile;
  res.set('Cache-Control', 'private, no-store');

  if (profile.role === 'ADMIN') return res.render('dashboard/admin', { title: 'Dashboard', ...(await adminBoard(profile)) });

  if (profile.role === 'SUPERVISOR') return res.render('dashboard/supervisor', { title: 'Dashboard', ...(await supervisorBoard(profile)) });

  const [summary, setup, me, attention] = await Promise.all([getMyTrainingSummary(profile.id), loadSetupForProfile(profile.organizationId, profile), myDevelopment(profile), attentionFor(profile)]);
  const readiness = (await readinessFor(profile.organizationId, [profile], { setupMap: new Map([[profile.id, setup]]) })).get(profile.id) || null;
  res.render('dashboard/agent', { title: 'Dashboard', summary, setup, me, readiness, attention });
});

module.exports = router;
