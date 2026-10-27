'use strict';

// The New Agent Program for one agent (the plan they follow is lib/newAgentPlan.js). Everything counts in the agent's
// WORKING days: their own weekly pattern (shifts vary, so each agent has one), minus one-off days off and approved
// vacation. Day 8 is their 8th working day; a task of day 8 is late once day 8 is behind them, so nobody is ever late
// for a day the agent was off.
//   * startProgram  copies the plan into the agent's own tasks (when someone starts mid-month, the earlier days' items
//                   fall due on their first day, so nothing is skipped); the daily calls and check-ins are tasks too.
//   * refresh       ticks what real data shows done (a finished training, the day's calls, a confirmed standard, the
//                   setup checklist, the working days being set), assigns each training on its day, and makes the days
//                   still ahead follow the plan as it is now - today and the past never change.
//   * autoStart     starts it for a new Travel Agent or Flight Expert from their first day.
// The calendar and state functions are pure; the rest reads and writes the database.
const { prisma } = require('./prisma');
const { getSetting } = require('./orgSettings');
const { logAudit } = require('./audit');
const { notifyOnce } = require('./notifications');
const { liveVersion } = require('./courseVersions');
const { isSubmitted, courseAttempt } = require('./trainingCompletion');
const { dayKey } = require('./callPractice');
const plans = require('./newAgentPlan');

const DAY_MS = 86400000;
const AGENT_ROLES = ['TRAVEL_AGENT', 'FLIGHT_EXPERT'];
const LIVE_STATUSES = ['ACTIVE', 'INVITED'];
const AUTO_START_DAYS = 7; // a first day up to a week ago still starts by itself (from that day); older: an Admin starts it
const MAX_SCAN = 800; // the calendar never walks further than this many days
const WEEKDAYS = [null, 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAY_NAMES = [null, 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const parse = (v, fallback) => { try { const x = v ? JSON.parse(v) : null; return x ?? fallback; } catch { return fallback; } };
const addDays = (key, n) => { const d = new Date(`${key}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
/** ISO weekday of a YYYY-MM-DD day: 1 = Monday ... 7 = Sunday. */
const weekday = (key) => new Date(`${key}T00:00:00Z`).getUTCDay() || 7;
/** The end of a Tashkent calendar day, as a moment (a due date). */
const endOfDay = (key) => new Date(`${key}T23:59:59+05:00`);

/** Valid weekdays from a form or JSON: unique integers 1-7, in order. */
function cleanWorkDays(list) {
  return [...new Set((Array.isArray(list) ? list : [list]).map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort((a, b) => a - b);
}

/** "Mon–Fri", "Tue–Sat", "Mon, Wed, Fri". */
function workDaysLabel(days) {
  const d = cleanWorkDays(days);
  if (!d.length) return 'No working days';
  const run = d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  return run && d.length >= 3 ? `${WEEKDAYS[d[0]]}–${WEEKDAYS[d[d.length - 1]]}` : d.map((x) => WEEKDAYS[x]).join(', ');
}

/** The agent's calendar: where the program starts, which weekdays they work, the one-off days off and vacation days. */
function calendarOf(program, leaveKeys = []) {
  const workDays = cleanWorkDays(parse(program.workDaysJson, [1, 2, 3, 4, 5]));
  return { startKey: program.startDate, startDay: program.startDay || 1, workDays: workDays.length ? workDays : [1, 2, 3, 4, 5], daysOff: new Set(parse(program.daysOffJson, [])), leave: new Set(leaveKeys) };
}
const isWorking = (cal, key) => cal.workDays.includes(weekday(key)) && !cal.daysOff.has(key) && !cal.leave.has(key);

/**
 * Where the agent stands on a calendar day: passed = the program days fully behind them (before that day); today =
 * that day's program day, or null when they do not work that day (or the program has not started yet).
 */
function positionOn(cal, todayKey) {
  let passed = cal.startDay - 1;
  if (todayKey < cal.startKey) return { passed, today: null, started: false };
  let key = cal.startKey;
  for (let i = 0; key < todayKey && i < MAX_SCAN; i += 1, key = addDays(key, 1)) if (isWorking(cal, key)) passed += 1;
  return { passed, today: isWorking(cal, todayKey) ? passed + 1 : null, started: true };
}

/** The calendar day of program day n (a forecast for days ahead: a new day off moves it), or null. */
function dateOfDay(cal, n) {
  if (n < cal.startDay) return null;
  let count = cal.startDay - 1;
  let key = cal.startKey;
  for (let i = 0; i < MAX_SCAN; i += 1, key = addDays(key, 1)) {
    if (isWorking(cal, key) && (count += 1) === n) return key;
  }
  return null;
}

/** The furthest day that has begun: today when they work today, else the last day behind them. */
const horizonOf = (pos) => (pos.today ?? pos.passed);

/**
 * The agent's tasks from the plan: each step on its day (never before startDay - earlier ones fall due on the first
 * day), then for every program day the day's calls and, when no check-in or review is planned that day, a check-in.
 */
function tasksFromPlan(plan, { startDay = 1, extraDays = 0 } = {}) {
  const length = plan.lengthDays + extraDays;
  const tasks = [];
  for (const step of plan.steps) {
    const kind = plans.KINDS[step.kind];
    if (!kind || kind.daily) continue;
    tasks.push({
      key: `step:${step.id}`, stepId: step.id, day: Math.max(step.dayOffset, startDay), owner: kind.owner, kind: step.kind, title: step.title,
      howTo: step.howTo || null, minutes: step.minutes ?? null, courseId: step.kind === 'TRAINING' ? step.courseId || null : null,
      standardId: step.kind === 'READ' ? step.standardId || null : null, system: step.system || null, target: null,
    });
  }
  const meetingDays = new Set(tasks.filter((t) => t.kind === 'CHECK_IN' || t.kind === 'REVIEW').map((t) => t.day));
  for (let day = startDay; day <= length; day += 1) {
    const calls = plans.callsOn(plan, day);
    tasks.push({ key: `calls:${day}`, stepId: null, day, owner: 'AGENT', kind: 'CALLS', title: `Call Practice: ${calls} call${calls === 1 ? '' : 's'}`, howTo: null, minutes: null, courseId: null, standardId: null, system: null, target: calls });
    if (plan.dailyCheckIn && !meetingDays.has(day)) {
      tasks.push({ key: `checkin:${day}`, stepId: null, day, owner: 'SUPERVISOR', kind: 'CHECK_IN', title: 'Daily check-in', howTo: 'Five minutes: how yesterday went, what is in the way, what comes next today.', minutes: 5, courseId: null, standardId: null, system: null, target: null });
    }
  }
  return tasks;
}

/** DONE, WAITING (a training video not made yet: the supervisor's demo covers it), LATE, TODAY or UPCOMING. */
function stateOf(task, pos) {
  if (task.doneAt) return 'DONE';
  if (task.kind === 'TRAINING' && !task.courseId) return 'WAITING';
  if (task.day <= pos.passed) return 'LATE';
  if (pos.today === task.day) return 'TODAY';
  return 'UPCOMING';
}
/** How many of the agent's working days a task is late. */
const daysLate = (task, pos) => Math.max(0, pos.passed - task.day + 1);

/** The numbers an overview shows for one program. */
function summarize(program, tasks, pos, plan) {
  const length = (plan ? plan.lengthDays : 4 * plans.WEEK_DAYS) + (program.extraDays || 0);
  const states = tasks.map((t) => stateOf(t, pos));
  const count = (s) => states.filter((x) => x === s).length;
  const day = pos.today ?? (pos.started ? pos.passed : null);
  return { day, today: pos.today, passed: pos.passed, started: pos.started, length, week: day ? plans.weekOf(day) : 1, done: count('DONE'), late: count('LATE'), dueToday: count('TODAY'), waiting: count('WAITING'), total: tasks.length - count('WAITING'), finished: pos.passed >= length };
}

// ---------------------------------------------------------------------------------------------- database

/** Every calendar day of the agent's approved vacation (leave days are stored as UTC midnights). */
async function leaveKeysFor(profileId) {
  const rows = await prisma.leaveRequest.findMany({ where: { profileId, status: 'APPROVED' }, select: { startDate: true, endDate: true } });
  const keys = [];
  for (const r of rows) {
    const end = r.endDate.toISOString().slice(0, 10);
    for (let key = r.startDate.toISOString().slice(0, 10), i = 0; key <= end && i < 400; key = addDays(key, 1), i += 1) keys.push(key);
  }
  return keys;
}

const withPlan = { path: { include: { steps: { orderBy: [{ dayOffset: 'asc' }, { displayOrder: 'asc' }] } } } };

/** Starts (or restarts) the program for one person. startKey = the calendar day of startDay. */
async function startProgram(profile, { startKey, startDay = 1, actorId = null, plan = null } = {}) {
  const thePlan = plan || await plans.ensurePlan(profile.organizationId);
  if (!thePlan) return null;
  const day = Math.max(1, Math.min(thePlan.lengthDays, Math.floor(Number(startDay)) || 1));
  const program = await prisma.$transaction(async (tx) => {
    const existing = await tx.agentProgram.findUnique({ where: { profileId: profile.id } });
    const data = { organizationId: profile.organizationId, pathId: thePlan.id, startDate: startKey, startDay: day, status: 'ACTIVE', startedById: actorId, stoppedAt: null, extraDays: 0, daysOffJson: '[]' };
    const row = existing ? await tx.agentProgram.update({ where: { id: existing.id }, data }) : await tx.agentProgram.create({ data: { ...data, profileId: profile.id } });
    await tx.agentProgramTask.deleteMany({ where: { programId: row.id } });
    await tx.agentProgramTask.createMany({ data: tasksFromPlan(thePlan, { startDay: day }).map((t) => ({ ...t, programId: row.id })) });
    return row;
  });
  await logAudit({ organizationId: profile.organizationId, actorId, action: 'program.started', targetTable: 'AgentProgram', targetId: program.id, metadata: { employeeId: profile.id, startDate: startKey, startDay: day, automatic: !actorId } });
  return program;
}

/** Starts it for a new Travel Agent or Flight Expert whose first day is at most a week ago (or still ahead). */
async function autoStart(profile, { now = new Date() } = {}) {
  if (!profile || !AGENT_ROLES.includes(profile.role) || !LIVE_STATUSES.includes(profile.status) || profile.testOwnerAdminId || profile.archivedAt || !profile.employmentStartDate) return null;
  const startKey = dayKey(profile.employmentStartDate);
  if (startKey < dayKey(new Date(now.getTime() - AUTO_START_DAYS * DAY_MS))) return null;
  if (await prisma.agentProgram.findUnique({ where: { profileId: profile.id }, select: { id: true } })) return null;
  const plan = await plans.ensurePlan(profile.organizationId);
  if (!plan || !plan.isActive || (plan.roleKey && plan.roleKey !== profile.role)) return null;
  return startProgram(profile, { startKey, plan });
}

/** The days still ahead follow the plan as it is now: new items appear, removed ones go, changed ones change. */
async function syncAhead(program, plan, horizon) {
  const desired = tasksFromPlan(plan, { startDay: program.startDay, extraDays: program.extraDays }).filter((t) => t.day > horizon);
  const existing = await prisma.agentProgramTask.findMany({ where: { programId: program.id } });
  const byKey = new Map(existing.map((t) => [t.key, t]));
  const fields = ['day', 'owner', 'kind', 'title', 'howTo', 'minutes', 'courseId', 'standardId', 'system', 'target', 'stepId'];
  for (const d of desired) {
    const e = byKey.get(d.key);
    if (!e) await prisma.agentProgramTask.create({ data: { ...d, programId: program.id } });
    else if (e.day > horizon && !e.doneAt && fields.some((f) => (e[f] ?? null) !== (d[f] ?? null))) await prisma.agentProgramTask.update({ where: { id: e.id }, data: Object.fromEntries(fields.map((f) => [f, d[f]])) });
  }
  const keep = new Set(desired.map((d) => d.key));
  const gone = existing.filter((e) => e.day > horizon && !e.doneAt && !keep.has(e.key)).map((e) => e.id);
  if (gone.length) await prisma.agentProgramTask.deleteMany({ where: { id: { in: gone } } });
}

/** A training reaches the agent's My Training on its day, due at the end of that day. Already assigned: that counts. */
async function assignTraining(program, task, cal, plan, now) {
  const course = await prisma.trainingCourse.findFirst({ where: { id: task.courseId, organizationId: program.organizationId, status: 'PUBLISHED', archivedAt: null } });
  if (!course) return;
  if (await prisma.trainingAssignmentRecipient.findFirst({ where: { profileId: program.profileId, assignment: { courseId: course.id } }, select: { id: true } })) return;
  const key = dateOfDay(cal, task.day) || dayKey(now);
  const floor = await getSetting(program.organizationId, 'training.minPassingScore');
  const trainingEmails = require('./trainingEmails');
  const assignment = await prisma.$transaction(async (tx) => {
    const a = await tx.trainingAssignment.create({ data: { organizationId: program.organizationId, courseId: course.id, courseVersion: liveVersion(course), assignedById: plan.createdById, scope: 'INDIVIDUAL', dueDate: endOfDay(key), notes: `New Agent Program · day ${task.day}`, minimumScore: Math.max(floor, course.passingScore) } });
    const r = await tx.trainingAssignmentRecipient.create({ data: { assignmentId: a.id, profileId: program.profileId } });
    await tx.trainingAttempt.create({ data: { recipientId: r.id, profileId: program.profileId, status: 'NOT_STARTED', attemptNumber: 1 } });
    await trainingEmails.enqueueAssignment(tx, r.id);
    return a;
  });
  trainingEmails.kick();
  await notifyOnce(program.profileId, `program-training:${task.id}`, { type: 'training.assigned', title: 'New training assigned', body: `"${course.title}" is part of your first month (due ${key}).`, link: '/training' });
  await logAudit({ organizationId: program.organizationId, actorId: null, action: 'program.training_assigned', targetTable: 'TrainingAssignment', targetId: assignment.id, metadata: { programId: program.id, courseId: course.id, day: task.day } });
}

/** When each open task was really done, from the data that proves it: Map(taskId -> moment). */
async function evidence(program, tasks, cal, pos) {
  const open = tasks.filter((t) => !t.doneAt);
  const ticks = new Map();
  const horizon = horizonOf(pos);

  const calls = open.filter((t) => t.kind === 'CALLS' && t.day <= horizon && t.target);
  if (calls.length) {
    const subs = await prisma.practiceCallTranscript.findMany({ where: { profileId: program.profileId, submittedAt: { not: null } }, select: { submittedAt: true }, orderBy: { submittedAt: 'asc' } });
    const byDay = new Map();
    for (const s of subs) { const k = dayKey(s.submittedAt); byDay.set(k, [...(byDay.get(k) || []), s.submittedAt]); }
    for (const t of calls) {
      const list = byDay.get(dateOfDay(cal, t.day)) || [];
      if (list.length >= t.target) ticks.set(t.id, list[t.target - 1]);
    }
  }

  const trainings = open.filter((t) => t.kind === 'TRAINING' && t.courseId);
  if (trainings.length) {
    const recipients = await prisma.trainingAssignmentRecipient.findMany({
      where: { profileId: program.profileId, assignment: { courseId: { in: trainings.map((t) => t.courseId) } } },
      include: { assignment: { select: { courseId: true } }, attempts: { select: { status: true, assessmentId: true, attemptNumber: true, createdAt: true, completedAt: true } } },
    });
    for (const t of trainings) {
      const done = recipients.find((r) => r.assignment.courseId === t.courseId && isSubmitted(r.attempts));
      if (done) ticks.set(t.id, courseAttempt(done.attempts).completedAt || new Date());
    }
  }

  const reads = open.filter((t) => t.kind === 'READ' && t.standardId);
  if (reads.length) {
    const acks = await prisma.standardsAcknowledgement.findMany({ where: { profileId: program.profileId, itemId: { in: reads.map((t) => t.standardId) } }, orderBy: { acceptedAt: 'asc' } });
    for (const t of reads) { const a = acks.find((x) => x.itemId === t.standardId); if (a) ticks.set(t.id, a.acceptedAt); }
  }

  const setup = open.filter((t) => t.kind === 'SETUP');
  if (setup.length) {
    const profile = program.profile || await prisma.profile.findUnique({ where: { id: program.profileId } });
    const state = await require('./employeeSetup').loadSetupForProfile(program.organizationId, profile);
    if (state && state.fullySetUp) for (const t of setup) ticks.set(t.id, new Date());
  }

  if (program.workDaysConfirmedAt) for (const t of open.filter((x) => x.kind === 'SCHEDULE')) ticks.set(t.id, program.workDaysConfirmedAt);
  return ticks;
}

/**
 * Brings one program up to date (see the top of this file) and returns { program, tasks, cal, pos, plan, summary }.
 * A program that is not ACTIVE is only read.
 */
async function refresh(programId, { now = new Date() } = {}) {
  let program = await prisma.agentProgram.findUnique({ where: { id: programId }, include: { profile: true, ...withPlan } });
  if (!program) return null;
  const plan = program.path;
  const cal = calendarOf(program, await leaveKeysFor(program.profileId));
  const pos = positionOn(cal, dayKey(now));
  if (program.status === 'ACTIVE') {
    if (plan) await syncAhead(program, plan, horizonOf(pos));
    const tasks = await prisma.agentProgramTask.findMany({ where: { programId } });
    if (plan && pos.started) for (const t of tasks) if (t.kind === 'TRAINING' && t.courseId && !t.doneAt && t.day <= horizonOf(pos)) await assignTraining(program, t, cal, plan, now);
    for (const [id, doneAt] of await evidence(program, tasks, cal, pos)) await prisma.agentProgramTask.updateMany({ where: { id, doneAt: null }, data: { doneAt } });
  }
  const tasks = await prisma.agentProgramTask.findMany({ where: { programId }, orderBy: [{ day: 'asc' }, { createdAt: 'asc' }] });
  return { program, tasks, cal, pos, plan, summary: summarize(program, tasks, pos, plan) };
}

/** Today's Call Practice calls for someone in the program (the week's number), or null: the organization's setting applies. */
async function callsQuota(profile, now = new Date()) {
  const program = await prisma.agentProgram.findUnique({ where: { profileId: profile.id }, include: { path: true } });
  if (!program || program.status !== 'ACTIVE' || !program.path) return null;
  const pos = positionOn(calendarOf(program, await leaveKeysFor(profile.id)), dayKey(now));
  if (!pos.today || pos.today > program.path.lengthDays + program.extraDays) return null;
  return plans.callsOn(program.path, pos.today);
}

/** The automation's pass: start it for new agents, stop it for people who left, bring every running one up to date. */
async function runPrograms(organizationId, { now = new Date() } = {}) {
  const out = { started: 0, stopped: 0, refreshed: 0 };
  const since = new Date(now.getTime() - (AUTO_START_DAYS + 1) * DAY_MS);
  const fresh = await prisma.profile.findMany({ where: { organizationId, role: { in: AGENT_ROLES }, status: { in: LIVE_STATUSES }, testOwnerAdminId: null, archivedAt: null, employmentStartDate: { gte: since }, agentProgram: null } });
  for (const p of fresh) if (await autoStart(p, { now })) out.started += 1;
  const running = await prisma.agentProgram.findMany({ where: { organizationId, status: 'ACTIVE' }, include: { profile: { select: { role: true, status: true, archivedAt: true } } } });
  for (const r of running) {
    if (!LIVE_STATUSES.includes(r.profile.status) || r.profile.archivedAt || !AGENT_ROLES.includes(r.profile.role)) {
      await prisma.agentProgram.update({ where: { id: r.id }, data: { status: 'STOPPED', stoppedAt: now } });
      out.stopped += 1;
      continue;
    }
    await refresh(r.id, { now });
    out.refreshed += 1;
  }
  return out;
}

module.exports = {
  AGENT_ROLES, LIVE_STATUSES, AUTO_START_DAYS, WEEKDAYS, WEEKDAY_NAMES,
  addDays, weekday, cleanWorkDays, workDaysLabel, calendarOf, isWorking, positionOn, dateOfDay, horizonOf, tasksFromPlan, stateOf, daysLate, summarize,
  leaveKeysFor, startProgram, autoStart, refresh, callsQuota, runPrograms,
};
