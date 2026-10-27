'use strict';

// Manage Training -> New Agent Program (Admin): who is in it, how it runs (on or off, calls a day each week, daily
// check-ins, week names), and the plan itself - the items of each day, added, changed or removed here. A change to the
// plan reaches every running program for the days still ahead; today and the past stay as they were
// (lib/newAgentProgram.js). An Admin can also start it for someone already in their first months, at the right day,
// set an agent's working days, and stop a program.
const router = require('express').Router();
const { prisma } = require('../../lib/prisma');
const { requireRole } = require('../../lib/authMiddleware');
const { logAudit } = require('../../lib/audit');
const { excludeOtherAdminsTestProfiles } = require('../../lib/loginAsScope');
const { monthsSince } = require('../../lib/tenure');
const { roleLabel } = require('../../lib/roles');
const { getSetting, setSetting } = require('../../lib/orgSettings');
const { dayKey, windowFor } = require('../../lib/callPractice');
const plans = require('../../lib/newAgentPlan');
const program = require('../../lib/newAgentProgram');

const adminOnly = requireRole('ADMIN');
const notFound = (res) => res.status(404).render('not-found', { layout: false });
const HOME = '/admin/new-agent-program';
const MAX_DAY = 30;
const text = (v, max) => String(v || '').trim().slice(0, max);
const int = (v, lo, hi) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : null; };
const audit = (req, action, targetTable, targetId, metadata) => logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action, targetTable, targetId, metadata });

/** The plan of this organization (made from the ready-made one the first time). */
async function planOf(req) { return plans.ensurePlan(req.profile.organizationId); }

/** A Travel Agent or Flight Expert of this organization the Admin may see, or null. */
async function agentOf(req, id) {
  return prisma.profile.findFirst({ where: { id, organizationId: req.profile.organizationId, role: { in: program.AGENT_ROLES }, archivedAt: null, ...excludeOtherAdminsTestProfiles(req.profile) } });
}

/** A plan item from a form, checked; { error } when something is wrong. */
async function readItem(req, plan) {
  const day = int(req.body.day, 1, MAX_DAY);
  const kind = plans.PLAN_KINDS.includes(req.body.kind) ? req.body.kind : null;
  const title = text(req.body.title, 160);
  if (!day || !kind || title.length < 2) return { error: `An item needs a day (1-${MAX_DAY}), a kind and a title.` };
  const minutes = req.body.minutes === '' || req.body.minutes == null ? null : int(req.body.minutes, 1, 240);
  if (minutes === null && req.body.minutes) return { error: 'Minutes are a whole number from 1 to 240.' };
  let courseId = null;
  if (kind === 'TRAINING' && req.body.courseId) {
    const course = await prisma.trainingCourse.findFirst({ where: { id: String(req.body.courseId), organizationId: plan.organizationId, status: 'PUBLISHED', archivedAt: null }, select: { id: true } });
    if (!course) return { error: 'Choose a training that is in the catalog.' };
    courseId = course.id;
  }
  let standardId = null;
  if (kind === 'READ') {
    const item = req.body.standardId ? await prisma.standardsItem.findFirst({ where: { id: String(req.body.standardId), organizationId: plan.organizationId, archivedAt: null }, select: { id: true } }) : null;
    if (!item) return { error: 'Choose the standard to read.' };
    standardId = item.id;
  }
  return { data: { dayOffset: day, kind, owner: plans.KINDS[kind].owner, title, howTo: text(req.body.howTo, 500) || null, minutes, courseId, standardId, system: text(req.body.system, 40) || null } };
}

/** The plan by week and day, ready for the page. */
function weeksOf(plan, courseTitle, standardTitle) {
  const titles = plans.weekTitles(plan);
  const calls = plans.callsPerWeek(plan);
  const lastDay = Math.max(plan.lengthDays, ...plan.steps.map((s) => s.dayOffset));
  const weeks = [];
  for (let w = 1; (w - 1) * plans.WEEK_DAYS < lastDay; w += 1) {
    const days = [];
    for (let d = (w - 1) * plans.WEEK_DAYS + 1; d <= Math.min(w * plans.WEEK_DAYS, lastDay); d += 1) {
      const steps = plan.steps.filter((s) => s.dayOffset === d).map((s) => ({
        ...s, kindLabel: (plans.KINDS[s.kind] || {}).label || s.kind,
        courseTitle: s.courseId ? courseTitle.get(s.courseId) || 'Training no longer in the catalog' : null,
        standardTitle: s.standardId ? standardTitle.get(s.standardId) || 'Standard no longer available' : null,
      }));
      days.push({ day: d, steps });
    }
    weeks.push({ number: w, title: titles[w - 1] || `Week ${w}`, calls: calls[Math.min(w, calls.length) - 1], days, extra: w * plans.WEEK_DAYS > plan.lengthDays });
  }
  return weeks;
}

router.get('/new-agent-program', adminOnly, async (req, res) => {
  const org = req.profile.organizationId;
  const plan = await planOf(req);
  if (!plan) return notFound(res);
  const now = new Date();
  const [running, courses, standards, window, supervisorEmails] = await Promise.all([
    prisma.agentProgram.findMany({ where: { organizationId: org, status: 'ACTIVE', profile: excludeOtherAdminsTestProfiles(req.profile) }, orderBy: { startDate: 'asc' }, select: { id: true } }),
    prisma.trainingCourse.findMany({ where: { organizationId: org, status: 'PUBLISHED', archivedAt: null }, orderBy: { title: 'asc' }, select: { id: true, title: true } }),
    prisma.standardsItem.findMany({ where: { organizationId: org, archivedAt: null }, orderBy: { title: 'asc' }, select: { id: true, title: true } }),
    windowFor(org),
    getSetting(org, 'program.supervisorEmails'),
  ]);
  // every running program, brought up to date (it ticks what real data shows done)
  const people = [];
  for (const r of running) {
    const state = await program.refresh(r.id, { now });
    const sup = await prisma.supervisorAssignment.findFirst({ where: { agentId: state.program.profileId, unassignedAt: null }, select: { supervisor: { select: { fullName: true } } } });
    people.push({ ...state, supervisor: sup ? sup.supervisor.fullName : null, workDays: program.workDaysLabel(JSON.parse(state.program.workDaysJson || '[]')), nextKey: state.pos.today ? null : program.dateOfDay(state.cal, state.pos.passed + 1) });
  }
  // people in their first months without a program, with the day they would be on now (Monday to Friday)
  const inProgram = await prisma.agentProgram.findMany({ where: { organizationId: org, status: 'ACTIVE' }, select: { profileId: true } });
  const busy = new Set(inProgram.map((p) => p.profileId));
  const candidates = (await prisma.profile.findMany({ where: { organizationId: org, role: { in: program.AGENT_ROLES }, status: { in: program.LIVE_STATUSES }, archivedAt: null, ...excludeOtherAdminsTestProfiles(req.profile) }, orderBy: { fullName: 'asc' }, select: { id: true, fullName: true, role: true, employmentStartDate: true } }))
    .filter((p) => !busy.has(p.id) && p.employmentStartDate && (window.months === null || monthsSince(new Date(p.employmentStartDate)) < window.months))
    .map((p) => {
      const pos = program.positionOn(program.calendarOf({ startDate: dayKey(p.employmentStartDate), startDay: 1, workDaysJson: '[1,2,3,4,5]' }), dayKey(now));
      return { ...p, startKey: dayKey(p.employmentStartDate), suggestedDay: Math.max(1, Math.min(plan.lengthDays, pos.passed + 1)) };
    });
  const notice = ['saved', 'added', 'deleted', 'started', 'stopped', 'days'].find((k) => req.query[k] === '1') || '';
  res.set('Cache-Control', 'private, no-store');
  res.render('admin/new-agent-program/index', {
    title: 'New Agent Program', plan, people, candidates, courses, standards, roleLabel, notice, supervisorEmails, error: typeof req.query.error === 'string' ? req.query.error.slice(0, 200) : '',
    weeks: weeksOf(plan, new Map(courses.map((c) => [c.id, c.title])), new Map(standards.map((s) => [s.id, s.title]))),
    calls: plans.callsPerWeek(plan), weekTitles: plans.weekTitles(plan), KINDS: plans.KINDS, PLAN_KINDS: plans.PLAN_KINDS, SYSTEMS: plans.SYSTEMS, maxDay: MAX_DAY, item: { dayOffset: 1, kind: 'DEMO' },
  });
});

// On or off, Call Practice calls a day in each week, the daily check-in and the week names.
router.post('/new-agent-program/settings', adminOnly, async (req, res) => {
  const plan = await planOf(req);
  if (!plan) return notFound(res);
  const weeks = Math.ceil(plan.lengthDays / plans.WEEK_DAYS);
  const calls = Array.from({ length: weeks }, (_, i) => int(req.body[`calls${i + 1}`], 1, 5));
  if (calls.some((c) => c === null)) return res.redirect(`${HOME}?error=${encodeURIComponent('Calls a day are a number from 1 to 5 for each week.')}`);
  const titles = Array.from({ length: weeks }, (_, i) => text(req.body[`week${i + 1}`], 60) || plans.weekTitles(plan)[i] || `Week ${i + 1}`);
  await prisma.developmentPath.update({ where: { id: plan.id }, data: { isActive: req.body.isActive === '1', dailyCheckIn: req.body.dailyCheckIn === '1', callsPerWeekJson: JSON.stringify(calls), weekTitlesJson: JSON.stringify(titles) } });
  await setSetting(req.profile.organizationId, 'program.supervisorEmails', req.body.supervisorEmails === '1', req.profile.id);
  await audit(req, 'program.settings_changed', 'DevelopmentPath', plan.id, { isActive: req.body.isActive === '1', calls, dailyCheckIn: req.body.dailyCheckIn === '1', supervisorEmails: req.body.supervisorEmails === '1' });
  res.redirect(`${HOME}?saved=1`);
});

router.post('/new-agent-program/items', adminOnly, async (req, res) => {
  const plan = await planOf(req);
  if (!plan) return notFound(res);
  const { data, error } = await readItem(req, plan);
  if (error) return res.redirect(`${HOME}?error=${encodeURIComponent(error)}#add-item`);
  const last = await prisma.developmentPathStep.aggregate({ where: { pathId: plan.id }, _max: { displayOrder: true } });
  const step = await prisma.developmentPathStep.create({ data: { ...data, pathId: plan.id, displayOrder: (last._max.displayOrder || 0) + 1 } });
  await audit(req, 'program.item_added', 'DevelopmentPathStep', step.id, { day: data.dayOffset, kind: data.kind, title: data.title });
  res.redirect(`${HOME}?added=1#day-${data.dayOffset}`);
});

async function stepOf(req) {
  const plan = await planOf(req);
  const step = plan ? plan.steps.find((s) => s.id === req.params.id) : null;
  return step ? { plan, step } : null;
}

router.get('/new-agent-program/items/:id', adminOnly, async (req, res) => {
  const found = await stepOf(req);
  if (!found) return notFound(res);
  const org = req.profile.organizationId;
  const [courses, standards] = await Promise.all([
    prisma.trainingCourse.findMany({ where: { organizationId: org, status: 'PUBLISHED', archivedAt: null }, orderBy: { title: 'asc' }, select: { id: true, title: true } }),
    prisma.standardsItem.findMany({ where: { organizationId: org, archivedAt: null }, orderBy: { title: 'asc' }, select: { id: true, title: true } }),
  ]);
  res.render('admin/new-agent-program/item', { title: found.step.title, item: found.step, courses, standards, KINDS: plans.KINDS, PLAN_KINDS: plans.PLAN_KINDS, SYSTEMS: plans.SYSTEMS, maxDay: MAX_DAY, error: typeof req.query.error === 'string' ? req.query.error.slice(0, 200) : '' });
});

router.post('/new-agent-program/items/:id', adminOnly, async (req, res) => {
  const found = await stepOf(req);
  if (!found) return notFound(res);
  const { data, error } = await readItem(req, found.plan);
  if (error) return res.redirect(`${HOME}/items/${found.step.id}?error=${encodeURIComponent(error)}`);
  await prisma.developmentPathStep.update({ where: { id: found.step.id }, data });
  await audit(req, 'program.item_changed', 'DevelopmentPathStep', found.step.id, { day: data.dayOffset, kind: data.kind, courseId: data.courseId });
  res.redirect(`${HOME}?saved=1#day-${data.dayOffset}`);
});

router.post('/new-agent-program/items/:id/delete', adminOnly, async (req, res) => {
  const found = await stepOf(req);
  if (!found) return notFound(res);
  await prisma.developmentPathStep.delete({ where: { id: found.step.id } });
  await audit(req, 'program.item_deleted', 'DevelopmentPathStep', found.step.id, { title: found.step.title, day: found.step.dayOffset });
  res.redirect(`${HOME}?deleted=1#day-${found.step.dayOffset}`);
});

// Start it for someone already in their first months, today, as program day N (earlier items fall due today).
router.post('/new-agent-program/start', adminOnly, async (req, res) => {
  const plan = await planOf(req);
  const person = plan ? await agentOf(req, String(req.body.profileId || '')) : null;
  if (!person) return res.redirect(`${HOME}?error=${encodeURIComponent('Choose who to start it for.')}`);
  const startDay = int(req.body.startDay, 1, plan.lengthDays);
  if (!startDay) return res.redirect(`${HOME}?error=${encodeURIComponent(`The first day is a number from 1 to ${plan.lengthDays}.`)}`);
  const current = await prisma.agentProgram.findUnique({ where: { profileId: person.id }, select: { status: true } });
  if (current && current.status === 'ACTIVE') return res.redirect(`${HOME}?error=${encodeURIComponent(`${person.fullName} is already in the program.`)}`);
  await program.startProgram(person, { startKey: dayKey(new Date()), startDay, actorId: req.profile.id, plan });
  res.redirect(`${HOME}?started=1`);
});

async function runningFor(req) {
  const person = await agentOf(req, req.params.profileId);
  const row = person ? await prisma.agentProgram.findUnique({ where: { profileId: person.id } }) : null;
  return row && row.status === 'ACTIVE' ? { person, row } : null;
}

// The agent's working days (shifts vary): day numbers, due dates and reminders follow them.
router.get('/new-agent-program/agents/:profileId/days', adminOnly, async (req, res) => {
  const found = await runningFor(req);
  if (!found) return notFound(res);
  res.render('admin/new-agent-program/days', { title: `${found.person.fullName} · working days`, person: found.person, workDays: program.cleanWorkDays(JSON.parse(found.row.workDaysJson || '[]')), confirmed: Boolean(found.row.workDaysConfirmedAt), WEEKDAY_NAMES: program.WEEKDAY_NAMES, error: req.query.error === 'none' });
});

router.post('/new-agent-program/agents/:profileId/days', adminOnly, async (req, res) => {
  const found = await runningFor(req);
  if (!found) return notFound(res);
  const days = program.cleanWorkDays(req.body.days == null ? [] : req.body.days);
  if (!days.length) return res.redirect(`${HOME}/agents/${found.person.id}/days?error=none`);
  await prisma.agentProgram.update({ where: { id: found.row.id }, data: { workDaysJson: JSON.stringify(days), workDaysConfirmedAt: found.row.workDaysConfirmedAt || new Date() } });
  await program.refresh(found.row.id);
  await audit(req, 'program.work_days_set', 'AgentProgram', found.row.id, { employeeId: found.person.id, days });
  res.redirect(`${HOME}?days=1`);
});

router.post('/new-agent-program/agents/:profileId/stop', adminOnly, async (req, res) => {
  const found = await runningFor(req);
  if (!found) return notFound(res);
  await prisma.agentProgram.update({ where: { id: found.row.id }, data: { status: 'STOPPED', stoppedAt: new Date() } });
  await audit(req, 'program.stopped', 'AgentProgram', found.row.id, { employeeId: found.person.id });
  res.redirect(`${HOME}?stopped=1`);
});

module.exports = router;
