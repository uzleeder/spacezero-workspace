'use strict';

// Manage Training -> Training emails: an Admin turns the training emails (the "New training" email and the daily
// reminder) off or on for everyone, for a team, or for one training. Off pauses them: nothing is lost, and turning
// it back on resumes them at once (lib/trainingEmails.js re-checks every switch before each email). In-app
// notifications are not affected. Admins only.
const express = require('express');
const router = express.Router();
const { prisma } = require('../../lib/prisma');
const { requireAdmin } = require('../../lib/authMiddleware');
const { logAudit } = require('../../lib/audit');
const { getSetting, setSetting } = require('../../lib/orgSettings');
const trainingEmails = require('../../lib/trainingEmails');

router.get('/training-emails', requireAdmin, async (req, res) => {
  const org = req.profile.organizationId;
  const [allOn, teams, courses, paused] = await Promise.all([
    getSetting(org, 'email.trainingEmails'),
    prisma.team.findMany({ where: { organizationId: org, archivedAt: null }, select: { id: true, name: true, trainingEmailsOff: true, _count: { select: { memberships: true } } }, orderBy: { name: 'asc' } }),
    prisma.trainingCourse.findMany({ where: { organizationId: org, archivedAt: null, status: 'PUBLISHED' }, select: { id: true, title: true, trainingEmailsOff: true, reminderEveryDays: true }, orderBy: { title: 'asc' } }),
    prisma.trainingEmailSchedule.count({ where: { lastError: { startsWith: 'Paused: ' }, nextSendAt: { not: null }, recipient: { assignment: { organizationId: org } } } }),
  ]);
  res.render('admin/training-emails', { title: 'Training emails', allOn, teams, courses, paused, choices: trainingEmails.REMINDER_CHOICES, cadenceText: trainingEmails.cadenceText, notice: String(req.query.notice || '').slice(0, 200) });
});

router.post('/training-emails', requireAdmin, async (req, res) => {
  const org = req.profile.organizationId;
  const on = req.body.on === '1';
  const target = String(req.body.target || '');
  const id = String(req.body.id || '');
  let label;
  if (target === 'all') {
    await setSetting(org, 'email.trainingEmails', on, req.profile.id);
    label = 'everyone';
  } else if (target === 'team') {
    const team = await prisma.team.findFirst({ where: { id, organizationId: org, archivedAt: null }, select: { id: true, name: true } });
    if (!team) return res.status(404).render('not-found', { layout: false });
    await prisma.team.update({ where: { id: team.id }, data: { trainingEmailsOff: !on } });
    label = team.name;
  } else if (target === 'course') {
    const course = await prisma.trainingCourse.findFirst({ where: { id, organizationId: org, archivedAt: null }, select: { id: true, title: true } });
    if (!course) return res.status(404).render('not-found', { layout: false });
    await prisma.trainingCourse.update({ where: { id: course.id }, data: { trainingEmailsOff: !on } });
    label = course.title;
  } else {
    return res.status(400).send('Unknown switch');
  }
  const targetTable = target === 'team' ? 'Team' : target === 'course' ? 'TrainingCourse' : 'Organization';
  await logAudit({ organizationId: org, actorId: req.profile.id, action: on ? 'training_emails.turned_on' : 'training_emails.turned_off', targetTable, targetId: target === 'all' ? org : id, metadata: { target, name: label } });
  if (on) await trainingEmails.resumePaused(org);
  res.redirect('/admin/training-emails?notice=' + encodeURIComponent(`Training emails for ${label} are ${on ? 'on' : 'off'}.`));
});

// How often one training's reminder is sent: every 1, 2, 3 or 7 days.
router.post('/training-emails/frequency', requireAdmin, async (req, res) => {
  const org = req.profile.organizationId;
  const days = Number(req.body.days);
  if (!trainingEmails.REMINDER_CHOICES.includes(days)) return res.status(400).send('Choose every day, every 2 or 3 days, or once a week.');
  const course = await prisma.trainingCourse.findFirst({ where: { id: String(req.body.id || ''), organizationId: org, archivedAt: null }, select: { id: true, title: true } });
  if (!course) return res.status(404).render('not-found', { layout: false });
  await prisma.trainingCourse.update({ where: { id: course.id }, data: { reminderEveryDays: days } });
  await trainingEmails.rescheduleCourse(course.id, days);
  await logAudit({ organizationId: org, actorId: req.profile.id, action: 'training_emails.frequency_changed', targetTable: 'TrainingCourse', targetId: course.id, metadata: { name: course.title, everyDays: days } });
  res.redirect('/admin/training-emails?notice=' + encodeURIComponent(`Reminders for ${course.title}: ${trainingEmails.cadenceText(days)}.`));
});

module.exports = router;
