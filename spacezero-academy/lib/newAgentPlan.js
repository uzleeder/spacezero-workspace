'use strict';

// The New Agent Program PLAN: the same 4 weeks every new agent goes through (Manage Training -> New Agent Program).
// It is a DevelopmentPath marked program = true; each step falls on the agent's Nth working day (dayOffset) and has a
// kind (KINDS) that says who does it and whether it ticks itself from real data. On top of the steps, every working
// day carries the day's Call Practice calls (callsPerWeek ramps them week by week) and, unless a check-in or review is
// already planned that day, a 5-minute supervisor check-in. A ready-made plan is created once per organization and the
// Admin edits it from there. How an agent runs through it is lib/newAgentProgram.js.
// New Travel Agents also get (lib/newAgentProgram.js onTravelPath): "Before day 1" items on day 0, owned by an Admin
// (accounts tick themselves once the login is in the credential vault); a ramp of rampWeeks weeks after the 4 weeks
// (rampCallsPerDay calls a day and a weekly review); and the "Ready for solo live calls" gate (readyAccuracy % and
// readyWpm words a minute over the last readyCalls calls).
// For now it is Month 1 only (SWITCHES.ramp off): no ramp, and the gate is checked at the end of Month 1. An Admin's
// "Extend a week" at the end still gives one extra week of Call Practice and a review. rampWeeks is kept, not used.
const { prisma } = require('./prisma');

const WEEK_DAYS = 5; // a program week is 5 of the agent's working days
const SWITCHES = { ramp: false }; // the ramp after Month 1: off for now (tests switch it on to keep it working)
const CALLS_DEFAULT = [2, 3, 4, 5];
const WEEK_TITLES_DEFAULT = ['Set up and listen', 'Systems hands-on', 'Practice', 'Supervised live calls'];
const SYSTEMS = ['CRM', 'EGF', 'Ovago', 'Cockpit', 'GDS', 'Dialpad', 'Gmail', 'Google Flights'];
const PRESTART_DAY = 0; // "Before day 1": due PRESTART_LEAD of the agent's working days before their first day
const PRESTART_LEAD = 2;

// auto: it ticks itself from real data (a finished training, the day's calls, a confirmed standard, the setup
// checklist, the working days being set, a login saved in the vault). The others are ticked by their owner.
// prestart: only on "Before day 1", and nowhere else.
const KINDS = {
  TRAINING: { owner: 'AGENT', label: 'Training video', auto: true },
  READ: { owner: 'AGENT', label: 'Read a standard', auto: true },
  SETUP: { owner: 'AGENT', label: 'Setup checklist', auto: true },
  AGENT_TASK: { owner: 'AGENT', label: 'Task', auto: false },
  SCHEDULE: { owner: 'SUPERVISOR', label: 'Set working days', auto: true },
  CHECK_IN: { owner: 'SUPERVISOR', label: 'Check-in', auto: false },
  DEMO: { owner: 'SUPERVISOR', label: 'Demo', auto: false },
  SIGN_OFF: { owner: 'SUPERVISOR', label: 'Sign-off', auto: false },
  REVIEW: { owner: 'SUPERVISOR', label: 'Review', auto: false },
  SUPERVISOR_TASK: { owner: 'SUPERVISOR', label: 'Task', auto: false },
  ACCOUNT: { owner: 'ADMIN', label: 'Account', auto: true, prestart: true },
  ADMIN_TASK: { owner: 'ADMIN', label: 'Admin task', auto: false, prestart: true },
  // the daily ones, never a plan step
  CALLS: { owner: 'AGENT', label: 'Call Practice', auto: true, daily: true },
};
const PLAN_KINDS = Object.keys(KINDS).filter((k) => !KINDS[k].daily);

const parse = (v, fallback) => { try { const x = v ? JSON.parse(v) : null; return x ?? fallback; } catch { return fallback; } };
const callsPerWeek = (plan) => { const v = parse(plan && plan.callsPerWeekJson, CALLS_DEFAULT); return Array.isArray(v) && v.length ? v : CALLS_DEFAULT; };
const weekTitles = (plan) => { const v = parse(plan && plan.weekTitlesJson, WEEK_TITLES_DEFAULT); return Array.isArray(v) ? v : WEEK_TITLES_DEFAULT; };
const weekOf = (day) => Math.max(1, Math.ceil(day / WEEK_DAYS));
/** Calls a day on program day `day`: that week's number; past the last week, the last one. */
const callsOn = (plan, day) => { const list = callsPerWeek(plan); return list[Math.min(weekOf(day), list.length) - 1]; };
/** The gate's numbers, from the plan (defaults when an older plan has none). */
const readyOf = (plan) => ({ accuracy: plan.readyAccuracy ?? 90, calls: plan.readyCalls ?? 10, wpm: plan.readyWpm ?? 35, rampWeeks: SWITCHES.ramp ? plan.rampWeeks ?? 8 : 0, rampCalls: plan.rampCallsPerDay ?? 5 });

// The ready-made plan: [day, kind, title, minutes, system, how-to]. Training videos start without a course ("video
// coming"): the Admin attaches each one when it is made, and the supervisor's demo covers it until then.
const DEFAULT_STEPS = [
  [1, 'SCHEDULE', 'Set their working days', 5, null, 'Pick the days they work. Day numbers, due dates and reminders follow these days.'],
  [1, 'CHECK_IN', 'Welcome 1:1 and introduce them to the team', 30, null, 'Walk through the 4 weeks together, show where things are and who to ask.'],
  [1, 'SUPERVISOR_TASK', 'Check every login works', 15, null, 'CRM, EGF, Ovago, Cockpit, GDS, Dialpad and Gmail. Fix anything missing on their Setup checklist.'],
  [1, 'SETUP', 'Finish the Setup checklist', null, null, null],
  [1, 'TRAINING', 'Gmail training video', null, 'Gmail', null],
  [2, 'DEMO', 'How to listen to a call', 30, null, 'Play one good call together and stop at each part: greeting, questions, offer, objections, close.'],
  [2, 'TRAINING', 'CRM training video', null, 'CRM', null],
  [3, 'DEMO', 'CRM: a lead from the first call to the booking', 30, 'CRM', 'Show it on a real lead, then let them log a call themselves.'],
  [3, 'DEMO', 'Dialpad: answer, hold, transfer and voicemail', 20, 'Dialpad', 'Show each one on a test call, then let them try.'],
  [4, 'SIGN_OFF', 'Sign off Dialpad: hold, transfer, voicemail', 15, 'Dialpad', 'Watch them do each one on a test call. Sign off only what you saw.'],
  [4, 'SIGN_OFF', 'Sign off CRM: create a lead and log a call', 15, 'CRM', 'Watch them do it on their own. Sign off only what you saw.'],
  [5, 'TRAINING', 'Google Flights training video', null, 'Google Flights', null],
  [5, 'REVIEW', 'Week 1 review', 10, null, 'How the week went, what to repeat, and whether they are on track.'],
  [6, 'TRAINING', 'EGF training video', null, 'EGF', null],
  [6, 'DEMO', 'EGF: search, compare fares and send a quote', 30, 'EGF', 'Do one together, then let them do one while you watch.'],
  [7, 'TRAINING', 'Ovago training video', null, 'Ovago', null],
  [7, 'DEMO', 'Ovago: show it, then let them try', 30, 'Ovago', null],
  [7, 'SIGN_OFF', 'Sign off EGF: search, compare and send a quote', 20, 'EGF', 'Watch them do it on their own. Sign off only what you saw.'],
  [8, 'TRAINING', 'Cockpit training video', null, 'Cockpit', null],
  [8, 'DEMO', 'Cockpit: make a test booking together', 30, 'Cockpit', null],
  [8, 'SIGN_OFF', 'Sign off Ovago', 15, 'Ovago', 'Watch them do it on their own. Sign off only what you saw.'],
  [9, 'TRAINING', 'GDS training video', null, 'GDS', null],
  [9, 'DEMO', 'GDS basics', 30, 'GDS', null],
  [9, 'SIGN_OFF', 'Sign off Cockpit: a test booking on their own', 20, 'Cockpit', 'Watch them do it on their own. Sign off only what you saw.'],
  [10, 'SIGN_OFF', 'Sign off GDS', 15, 'GDS', 'Watch them do it on their own. Sign off only what you saw.'],
  [10, 'AGENT_TASK', 'Listen in on 3 live calls', null, null, 'Sit with a senior agent and note the greeting, the questions and the close.'],
  [10, 'REVIEW', 'Week 2 review', 10, null, 'How the week went, what to repeat, and whether they are on track.'],
  [11, 'AGENT_TASK', 'Listen in on 3 more live calls and note what worked', null, null, null],
  [12, 'DEMO', 'Role-play: a new booking request', 30, null, 'You are the client. Swap roles once.'],
  [13, 'DEMO', 'Role-play: changing a booking', 30, null, 'You are the client. Swap roles once.'],
  [14, 'DEMO', 'Mock call from start to finish', 30, null, 'A full call with you as the client. Note 2 strengths and 1 thing to fix.'],
  [15, 'REVIEW', 'Week 3 review', 10, null, 'How the week went, what to repeat, and whether they are on track.'],
  [16, 'AGENT_TASK', 'First live calls with your supervisor listening', null, null, null],
  [17, 'SUPERVISOR_TASK', 'Listen to 3 of their live calls and give feedback', 30, null, 'Two things they did well, one thing to change on the next call.'],
  [19, 'SUPERVISOR_TASK', 'Read this month’s transcripts and note the patterns', 15, null, 'Which words they still miss, and what that says about their listening.'],
  [20, 'REVIEW', 'Final review: ready for live calls, or extend a week', 20, null, 'Go through the 4 weeks together. Every sign-off should be done.'],
];

// The ready-made "Before day 1" items for a new Travel Agent: [kind, title, system, how-to]. An account ticks itself
// once its login is saved in the agent's credential vault; the Admin ticks the rest.
const PRESTART_STEPS = [
  ...['Gmail', 'Dialpad', 'CRM', 'EGF', 'Ovago', 'Cockpit', 'GDS'].map((system) => ['ACCOUNT', `${system} account`, system, `Create it and save the login in their credential vault. It ticks itself then.`]),
  ['ADMIN_TASK', 'PC and headset ready at their desk', null, 'Switched on, signed in to Windows, headset tested.'],
  ['ADMIN_TASK', 'Employment documents signed', null, 'Contract and the documents HR needs, signed and filed.'],
];
const prestartData = (offset = 0) => PRESTART_STEPS.map(([kind, title, system, howTo], i) => ({ dayOffset: PRESTART_DAY, kind, owner: KINDS[kind].owner, title, system, howTo, displayOrder: offset + i }));

/** The organization's program plan with its steps in order, or null. */
function findPlan(organizationId) {
  return prisma.developmentPath.findFirst({ where: { organizationId, program: true }, orderBy: { createdAt: 'asc' }, include: { steps: { orderBy: [{ dayOffset: 'asc' }, { displayOrder: 'asc' }] } } });
}

/** The plan, created from the ready-made one the first time (needs an active Admin to own it). */
async function ensurePlan(organizationId) {
  const found = await findPlan(organizationId);
  if (found && found.prestartSeeded) return found;
  if (found) { // a plan made before "Before day 1" existed: its ready-made items are added once (an Admin may remove them)
    const claimed = await prisma.developmentPath.updateMany({ where: { id: found.id, prestartSeeded: false }, data: { prestartSeeded: true } });
    if (claimed.count && !found.steps.some((s) => s.dayOffset === PRESTART_DAY)) await prisma.developmentPathStep.createMany({ data: prestartData(-PRESTART_STEPS.length).map((d) => ({ ...d, pathId: found.id })) });
    return findPlan(organizationId);
  }
  const admin = await prisma.profile.findFirst({ where: { organizationId, role: 'ADMIN', status: 'ACTIVE', testOwnerAdminId: null }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (!admin) return null;
  await prisma.developmentPath.create({
    data: {
      organizationId, program: true, name: 'New Agent Program', createdById: admin.id, lengthDays: 4 * WEEK_DAYS,
      callsPerWeekJson: JSON.stringify(CALLS_DEFAULT), weekTitlesJson: JSON.stringify(WEEK_TITLES_DEFAULT),
      description: 'The first 4 weeks of every new Travel Agent and Flight Expert.', prestartSeeded: true,
      steps: { create: [...prestartData(-PRESTART_STEPS.length), ...DEFAULT_STEPS.map(([dayOffset, kind, title, minutes, system, howTo], i) => ({ dayOffset, kind, owner: KINDS[kind].owner, title, minutes, system, howTo, displayOrder: i }))] },
    },
  });
  return findPlan(organizationId);
}

module.exports = { WEEK_DAYS, SWITCHES, CALLS_DEFAULT, WEEK_TITLES_DEFAULT, SYSTEMS, PRESTART_DAY, PRESTART_LEAD, KINDS, PLAN_KINDS, DEFAULT_STEPS, PRESTART_STEPS, callsPerWeek, weekTitles, weekOf, callsOn, readyOf, findPlan, ensurePlan };
