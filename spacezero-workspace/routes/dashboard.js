'use strict';

// The Dashboard, one per role, each counted live (nothing is stored) and refreshed in place by
// public/js/dashboard-live.js from GET /dashboard/live:
//   Admin       three lanes: Urgent / Decision needed / Up next, health rings, falling behind (lib/adminDashboard.js)
//   Supervisor  their team as faces, their list in Late / Today / This week (lib/supervisorDashboard.js)
//   Agent       the next step of My Training, Call Practice while a call waits, and the rest of what is theirs to do
//               (lib/agentDashboard.js) - the same page for every agent, new or not
const express = require('express');
const router = express.Router();

const { requireSession } = require('../lib/authMiddleware');
const { adminDashboard } = require('../lib/adminDashboard');
const { supervisorDashboard } = require('../lib/supervisorDashboard');
const { agentDashboard } = require('../lib/agentDashboard');

/** The greeting and today's date, in Tashkent time. */
function hello(profile, now) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', hourCycle: 'h23' }).format(now));
  const part = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  return { greeting: `Good ${part}, ${profile.fullName.split(' ')[0]}.`, today: new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', weekday: 'long', day: 'numeric', month: 'long' }).format(now) };
}

/** The view and the data of this person's dashboard. */
async function boardFor(profile, now = new Date()) {
  if (profile.role === 'ADMIN') return { view: 'admin', data: { dash: await adminDashboard(profile, { now }), ...hello(profile, now) } };
  if (profile.role === 'SUPERVISOR') return { view: 'supervisor', data: { sdash: await supervisorDashboard(profile, { now }), ...hello(profile, now) } };
  // like My Training: anything already done is marked finished first, so the next step is the same one (not while viewing as someone)
  if (!require('../lib/requestContext').readOnly()) await require('../lib/trainingCompletion').autoFinishForProfile(profile.id).catch((err) => console.error('auto-finish failed', err.message));
  return { view: 'agent', data: { adash: await agentDashboard(profile, { now }), ...hello(profile, now) } };
}

// The inside of this person's dashboard on its own, for public/js/dashboard-live.js to refresh it in place.
router.get('/dashboard/live', requireSession, async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const { view, data } = await boardFor(req.profile);
  res.render(`dashboard/${view}-board`, { layout: false, ...data });
});

router.get('/dashboard', requireSession, async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const { view, data } = await boardFor(req.profile);
  res.render(`dashboard/${view}`, { title: 'Dashboard', ...data });
});

// The dashboard's "SpaceZero standard" card. By default its globe turns in the sidebar logo; the small button on that
// globe brings the card onto the dashboard for this person (hidden=0), and the card's X sends it back (hidden=1).
// While an Admin is viewing as someone, the app's read-only guard refuses this like any other change.
router.post('/dashboard/hero', requireSession, async (req, res) => {
  const hidden = req.body.hidden === '1';
  await require('../lib/prisma').prisma.profile.update({ where: { id: req.profile.id }, data: { heroShown: !hidden } });
  if (req.get('X-Requested-With') === 'fetch') return res.json({ ok: true, hidden });
  res.redirect('/dashboard');
});

module.exports = router;
