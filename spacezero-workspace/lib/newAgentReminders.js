'use strict';

// New Agent Program reminders, so nothing about a new agent slips (lib/newAgentProgram.js, lib/newAgentBoard.js):
//   * Every morning at 08:30 (Tashkent) each supervisor gets "Today with your new agents" - what is overdue and what is
//     for today - in the app, and by email when program.supervisorEmails is on (off for now). Nothing is sent on a day
//     with nothing to do.
//   * An agent falling behind - an item of theirs one working day late (the day's calls, a training, a standard, the
//     setup checklist), or under 70% accuracy on 3 calls in a row - alerts their supervisor that day.
//   * A supervisor's item 2 of the agent's working days late goes to every Admin, and so does a new agent without a
//     supervisor; the Admins also get a morning email listing them.
// New Travel Agents also (np.onTravelPath; Flight Experts are as before):
//   * while their supervisor is disabled, on approved leave or missing, the admins get what the supervisor would;
//   * their own items also count an agent task, and 2+ working days late go into the admins' morning message;
//   * an Admin's "Before day 1" item one working day late goes to every Admin, and to the supervisor too once day 1
//     comes with anything still open;
//   * the admins' morning message also lists who can't be tracked (untrackedHires), who the admins cover, end-of-month
//     (end-of-ramp) decisions, what only an admin can do (approvals, sign-offs to confirm, flags), and "Call library: about X days
//     left" when it is under LIBRARY_DAYS working days.
// Every message carries a key (lib/notifications.js notifyOnce): running this again never sends anything twice. The
// alerts also run with the 6-hourly automation, in case the server was down at 08:30.
const { prisma } = require('./prisma');
const { notifyOnce } = require('./notifications');
const { getSetting } = require('./orgSettings');
const mailer = require('./mailer');
const { registerJobType } = require('./jobQueue');
const { dayKey } = require('./callPractice');
const np = require('./newAgentProgram');
const board = require('./newAgentBoard');

const ESCALATE_DAYS = 2; // a supervisor's item this many of the agent's working days late goes to the Admins
const LOW_ACCURACY = 70;
const LOW_STREAK = 3;
const DIGEST_MINUTES = 8 * 60 + 30; // 08:30 Tashkent
const AGENT_ITEMS = ['CALLS', 'TRAINING', 'READ', 'SETUP'];
const LIBRARY_DAYS = 10; // the call library line shows when fewer working days of calls than this are left

const tashkentMinutes = (now) => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  return Number(parts.find((p) => p.type === 'hour').value) * 60 + Number(parts.find((p) => p.type === 'minute').value);
};
const origin = () => process.env.ACCOUNT_EMAIL_ORIGIN || process.env.APP_ORIGIN || 'http://localhost:3000';
const link = (path) => new URL(path, origin()).href;
const first = (name) => board.firstName(name);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** What an overdue row says about escalation. */
function escalationNote(daysLate, { forAdmin = false } = {}) {
  if (daysLate >= ESCALATE_DAYS) return forAdmin ? 'Admins were told' : 'Your admin was told';
  return forAdmin ? 'Admins are told after one more working day' : 'Your admin is told after one more working day';
}

/** Every running program of the organization, brought up to date (admin test accounts left out). */
async function statesOf(organizationId, now) {
  const rows = await prisma.agentProgram.findMany({ where: { organizationId, status: 'ACTIVE', profile: { testOwnerAdminId: null } }, select: { id: true } });
  const states = [];
  for (const r of rows) { const s = await board.agentState(r.id, null, { now }); if (s) states.push(s); }
  return states;
}

const adminsOf = (organizationId) => prisma.profile.findMany({ where: { organizationId, role: 'ADMIN', status: 'ACTIVE', testOwnerAdminId: null }, select: { id: true, fullName: true, email: true } });

/** The agent's own items that became late with the last working day behind them. */
function newlyLate(state) {
  const kinds = state.travel ? [...AGENT_ITEMS, 'AGENT_TASK'] : AGENT_ITEMS;
  return state.tasks.filter((t) => t.owner === 'AGENT' && kinds.includes(t.kind) && np.stateOf(t, state.pos) === 'LATE' && np.daysLate(t, state.pos) === 1);
}

/** A Travel Agent's own items late long enough for the admins' morning message. */
const agentLate = (state) => (state.travel ? state.tasks.filter((t) => t.owner === 'AGENT' && np.stateOf(t, state.pos) === 'LATE' && (t.kind === 'CALLS' ? np.daysLate(t, state.pos) === ESCALATE_DAYS : np.daysLate(t, state.pos) >= ESCALATE_DAYS)) : []); // a missed calls day once, then it is history
/** An Admin's "Before day 1" items that are late. */
const prestartLate = (state) => state.tasks.filter((t) => t.owner === 'ADMIN' && np.stateOf(t, state.pos) === 'LATE');
/** Who gets what the supervisor would: the supervisor, or every Admin while they cover (Travel Agents only). */
const watchersOf = (state, admins) => (state.travel && state.cover && state.cover.absent ? admins.map((a) => a.id) : state.supervisor ? [state.supervisor.id] : []);

/**
 * How many working days of calls the library has left for the agent furthest through it: the ready calls they have
 * not done yet, at their calls a day now. null when nobody is doing calls.
 */
async function libraryDaysLeft(organizationId, states) {
  const ready = await prisma.practiceCall.findMany({ where: { organizationId, archivedAt: null, referenceStatus: 'READY' }, select: { id: true } });
  const ids = ready.map((c) => c.id);
  let least = null;
  for (const s of states) {
    if (s.program.status !== 'ACTIVE' || !s.pos.started || s.summary.finished) continue;
    const calls = s.tasks.find((t) => t.kind === 'CALLS' && t.day >= np.horizonOf(s.pos)) || null;
    if (!calls || !calls.target) continue;
    const done = await prisma.practiceCallTranscript.findMany({ where: { profileId: s.profile.id, callId: { in: ids }, submittedAt: { not: null } }, distinct: ['callId'], select: { callId: true } });
    const days = Math.floor((ids.length - done.length) / calls.target);
    if (least === null || days < least) least = days;
  }
  return least;
}

/** The supervisor's items late long enough to go to the Admins. */
function escalated(state) {
  return state.tasks.filter((t) => t.owner === 'SUPERVISOR' && np.stateOf(t, state.pos) === 'LATE' && np.daysLate(t, state.pos) >= ESCALATE_DAYS);
}

/**
 * The run of scored transcripts under 70% the agent is in now, when it is at least 3 long: { startId, last } - startId
 * is where the run began (one alert per run, however long it gets), last the 3 latest scores, oldest first. Else null.
 */
async function lowStreak(profileId) {
  const recent = await prisma.practiceCallTranscript.findMany({ where: { profileId, submittedAt: { not: null }, accuracy: { not: null } }, orderBy: { submittedAt: 'desc' }, take: 50, select: { id: true, accuracy: true } });
  let run = 0;
  while (run < recent.length && recent[run].accuracy < LOW_ACCURACY) run += 1;
  return run >= LOW_STREAK ? { startId: recent[run - 1].id, last: recent.slice(0, LOW_STREAK).reverse() } : null;
}

/** Alerts and escalations for the organization's running programs. Returns the counts and the states. */
async function runAlerts(organizationId, { now = new Date(), states = null } = {}) {
  const all = states || await statesOf(organizationId, now);
  const admins = await adminsOf(organizationId);
  const out = { behind: 0, accuracy: 0, escalated: 0, noSupervisor: 0, states: all };
  for (const s of all) {
    const name = s.profile.fullName;
    const page = `/new-agents/${s.profile.id}`;
    const watchers = watchersOf(s, admins);
    if (watchers.length) {
      const late = newlyLate(s);
      const streak = await lowStreak(s.profile.id);
      let behind = false; let accuracy = false;
      for (const w of watchers) {
        if (late.length && await notifyOnce(w, `program-behind:${s.program.id}:${s.pos.passed}`, { type: 'program.behind', title: `${name} fell behind`, body: `Not done on day ${s.pos.passed}: ${late.map((t) => t.title).join(', ')}.`, link: page })) behind = true;
        if (streak && await notifyOnce(w, `program-accuracy:${s.program.id}:${streak.startId}`, { type: 'program.low_accuracy', title: `${name}: low accuracy on ${LOW_STREAK} calls in a row`, body: `Their last ${LOW_STREAK} transcripts scored ${streak.last.map((t) => `${Math.round(t.accuracy)}%`).join(', ')}. Listen to one of those calls together.`, link: page })) accuracy = true;
      }
      out.behind += Number(behind); out.accuracy += Number(accuracy);
    }
    if (s.travel) {
      // "Before day 1": one working day late goes to every Admin; day 1 with anything still open, to the supervisor too
      const open = prestartLate(s);
      for (const t of open) for (const a of admins) if (await notifyOnce(a.id, `program-prestart:${t.id}`, { type: 'program.prestart_late', title: `Not ready for ${name}: ${t.title}`, body: `It was due ${board.shortDate(s.pos.pre.dueKey)}. ${first(name)} ${s.pos.started ? 'has started' : `starts ${board.shortDate(s.cal.startKey)}`}.`, link: t.kind === 'ACCOUNT' ? `/employees/${s.profile.id}/credentials` : `${page}#task-${t.id}` })) out.prestart = (out.prestart || 0) + 1;
      if (s.pos.started && open.length) for (const w of watchers) await notifyOnce(w, `program-prestart-open:${s.program.id}`, { type: 'program.prestart_late', title: `${name} started with ${plural(open.length, 'item')} not ready`, body: `Not ready on day 1: ${open.map((t) => t.title).join(', ')}. Admins have been told.`, link: page });
    }
    if (!s.supervisor) {
      for (const a of admins) if (await notifyOnce(a.id, `program-nosup:${s.program.id}`, { type: 'program.no_supervisor', title: `${name} has no supervisor`, body: 'Their New Agent Program has supervisor items nobody is doing. Assign a supervisor.', link: '/new-agents?supervisor=none' })) out.noSupervisor += 1;
    }
    for (const t of escalated(s)) {
      const who = s.supervisor ? s.supervisor.fullName : 'No supervisor';
      for (const a of admins) if (await notifyOnce(a.id, `program-escalated:${t.id}`, { type: 'program.escalated', title: `Overdue for ${name}: ${t.title}`, body: `${who} · ${plural(np.daysLate(t, s.pos), 'working day')} late.`, link: `${page}#task-${t.id}` })) out.escalated += 1;
    }
  }
  return out;
}

/** The supervisor's morning email: overdue, today, and a line per agent. */
function supervisorEmail(supervisor, agents, tasks, now) {
  const late = tasks.late.map((r) => `- ${r.agent.profile.fullName} · ${r.task.title} · ${r.daysLate}d overdue${r.task.owner === 'SUPERVISOR' ? ` (${escalationNote(r.daysLate).toLowerCase()})` : ''}`);
  const today = tasks.today.map((r) => `- ${r.agent.profile.fullName} · ${r.task.title}${r.task.minutes ? ` · ${r.task.minutes} min` : ''}`);
  // the same line as on the board: where they are, everything going on, the next step
  const people = agents.map((a) => `- ${a.profile.fullName}: ${a.pos.started ? `${a.pos.today ? `day ${a.pos.today}` : 'day off today'}. ${a.goingOn}. Next: ${a.next.text}.` : `${a.goingOn}.`}`);
  const lines = [
    `Hi ${first(supervisor.fullName)},`, '',
    `${[tasks.late.length ? `${plural(tasks.late.length, 'thing is', 'things are')} overdue` : '', tasks.today.length ? `${plural(tasks.today.length, 'thing is', 'things are')} for today` : ''].filter(Boolean).join(' and ')}.`.replace(/^./, (c) => c.toUpperCase()),
    ...(late.length ? ['', 'OVERDUE', ...late] : []),
    ...(today.length ? ['', `FOR YOU TODAY${tasks.minutes ? ` (about ${board.duration(tasks.minutes)})` : ''}`, ...today] : []),
    '', 'YOUR NEW AGENTS', ...people,
    '', `Open New agents: ${link('/new-agents')}`,
    '', `You get this at 08:30 on days you have something for your new agents. Anything of yours still open after ${ESCALATE_DAYS} of the agent's working days goes to your admin.`,
    '', 'SpaceZero Workspace',
  ];
  return { to: supervisor.email, subject: `Today with your new agents · ${board.shortDate(dayKey(now))}`, text: lines.join('\n') };
}

/** An Admin's morning email: supervisor items late enough to escalate, and new agents without a supervisor. */
function adminEmail(admin, late, orphans, now, more = {}) {
  const { untracked = [], decisions = [], waiting = [], covering = [], behind = [], prestart = [], library = null } = more;
  const section = (title, rows) => (rows.length ? [title, ...rows, ''] : []);
  const lines = [
    `Hi ${first(admin.fullName)},`, '',
    ...section('CAN\'T BE TRACKED (fix these first):', untracked.map((u) => `- ${u.profile.fullName} · ${u.reason} · ${u.action}: ${link(u.href)}`)),
    ...section('WAITING FOR YOU (only an admin can do these):', waiting.map((w) => `- ${w.agent} · ${w.what}`)),
    ...section(`DECISIONS (time is up: ${board.moreTime()} or approve anyway):`, decisions.map((d) => `- ${d.agent} · ready ${d.met} of ${d.of}`)),
    ...section('BEFORE DAY 1, NOT READY:', prestart.map((r) => `- ${r.agent} · ${r.title} · ${r.daysLate}d late · ${r.starts}`)),
    ...section('YOU COVER (their supervisor is away):', covering.map((c) => `- ${c.agent} · ${c.text}${c.items ? ` · ${plural(c.items, 'item')} late or due today` : ''}`)),
    ...(late.length ? [`These supervisor items for new agents are ${ESCALATE_DAYS} or more working days late:`, ...late.map((r) => `- ${r.supervisor} · ${r.agent} · ${r.title} · ${r.daysLate}d overdue`), ''] : []),
    ...section(`Travel Agents ${ESCALATE_DAYS} or more working days behind on their own items:`, behind.map((r) => `- ${r.agent} · ${r.titles} · ${r.daysLate}d late`)),
    ...(orphans.length ? ['New agents without a supervisor (nobody is doing their supervisor items):', ...orphans.map((n) => `- ${n}`), ''] : []),
    ...(library !== null ? [`Call library: about ${plural(library, 'day')} left. Upload more calls in Manage Training -> Call Practice.`, ''] : []),
    ...(waiting.length ? [`Open Waiting for you: ${link('/new-agents/approvals')}`] : []),
    `Open New agents: ${link('/new-agents')}`, '', 'SpaceZero Workspace',
  ];
  return { to: admin.email, subject: `New agents: what needs you · ${board.shortDate(dayKey(now))}`, text: lines.join('\n') };
}

/** Sends one email when delivery is set up; a failure is logged, the in-app message stays. */
async function deliver(message, key, send) {
  if (!message.to || (send === mailer.sendEmailMessage && !mailer.isEmailConfigured())) return false;
  try { await send(message, { idempotencyKey: key }); return true; } catch (err) { console.error(`[program] email ${key} failed:`, err.message || err); return false; }
}

/** The 08:30 run for one organization: alerts and escalations, then each supervisor's and each Admin's morning message. */
async function runMorning(organizationId, { now = new Date(), send = mailer.sendEmailMessage } = {}) {
  const alerts = await runAlerts(organizationId, { now });
  const day = dayKey(now);
  const out = { ...alerts, digests: 0, adminDigests: 0, emails: 0 };
  const emailSupervisors = await getSetting(organizationId, 'program.supervisorEmails');
  delete out.states;
  const bySupervisor = new Map();
  // a Travel Agent whose supervisor is away is in the admins' message instead (they cover)
  for (const s of alerts.states) if (s.supervisor && !(s.travel && s.cover && s.cover.absent)) bySupervisor.set(s.supervisor.id, [...(bySupervisor.get(s.supervisor.id) || []), s]);
  for (const [supervisorId, agents] of bySupervisor) {
    const tasks = board.supervisorTasksOf(agents);
    if (!tasks.late.length && !tasks.today.length) continue; // nothing to do today: nothing is sent
    const supervisor = await prisma.profile.findUnique({ where: { id: supervisorId }, select: { id: true, fullName: true, email: true, status: true } });
    if (!supervisor || supervisor.status !== 'ACTIVE') continue;
    const created = await notifyOnce(supervisorId, `program-digest:${day}`, { type: 'program.digest', title: 'Today with your new agents', body: [tasks.late.length ? `${tasks.late.length} overdue` : '', `${tasks.today.length} for today`].filter(Boolean).join(' · '), link: '/new-agents' });
    if (!created) continue;
    out.digests += 1;
    if (emailSupervisors && await deliver(supervisorEmail(supervisor, [...agents].sort((a, b) => a.groupInfo.rank - b.groupInfo.rank), tasks, now), `program-digest:${supervisorId}:${day}`, send)) out.emails += 1;
  }
  const states = alerts.states;
  const late = states.flatMap((s) => escalated(s).map((t) => ({ supervisor: s.supervisor ? s.supervisor.fullName : 'No supervisor', agent: s.profile.fullName, title: t.title, daysLate: np.daysLate(t, s.pos) })));
  const orphans = states.filter((s) => !s.supervisor && !s.travel).map((s) => s.profile.fullName); // a Travel Agent's is under "can't be tracked"
  const more = {
    untracked: await board.untrackedHires(organizationId, states, { now }),
    decisions: states.filter((s) => s.summary.rampOver && !board.isReady(s)).map((s) => ({ agent: s.profile.fullName, met: s.readiness.metCount, of: s.readiness.checks.length })),
    waiting: [
      ...states.filter(board.isReady).map((s) => ({ agent: s.profile.fullName, what: 'approve for solo live calls' })),
      ...states.flatMap((s) => s.waiting.map((t) => ({ agent: s.profile.fullName, what: `confirm the ${t.system || t.title} sign-off` }))),
      ...states.flatMap((s) => s.flags.map((f) => ({ agent: s.profile.fullName, what: `flag: ${f.text}` }))),
    ],
    prestart: states.flatMap((s) => (s.travel ? prestartLate(s) : []).map((t) => ({ agent: s.profile.fullName, title: t.title, daysLate: np.daysLate(t, s.pos), starts: s.pos.started ? 'already started' : `starts ${board.shortDate(s.cal.startKey)}` }))),
    covering: states.filter((s) => s.travel && s.cover && s.cover.reason === 'LEAVE').map((s) => ({ agent: s.profile.fullName, text: s.cover.text, items: s.tasks.filter((t) => board.needsSupervisor(t) && ['LATE', 'TODAY'].includes(np.stateOf(t, s.pos))).length })),
    behind: states.map((s) => ({ s, rows: agentLate(s) })).filter((x) => x.rows.length).map(({ s, rows }) => ({ agent: s.profile.fullName, titles: [...new Set(rows.map(board.shortTitle))].join(', '), daysLate: Math.max(...rows.map((t) => np.daysLate(t, s.pos))) })),
  };
  const left = await libraryDaysLeft(organizationId, states);
  more.library = left !== null && left < LIBRARY_DAYS ? left : null;
  const counts = [
    more.untracked.length ? `${plural(more.untracked.length, 'agent')} can't be tracked` : '',
    more.waiting.length ? `${plural(more.waiting.length, 'thing')} only an admin can do` : '',
    more.decisions.length ? `${plural(more.decisions.length, 'end-of-month decision')}` : '',
    more.prestart.length ? `${plural(more.prestart.length, 'pre-start item')} late` : '',
    more.covering.length ? `covering ${plural(more.covering.length, 'agent')}` : '',
    late.length ? `${plural(late.length, 'supervisor item')} ${ESCALATE_DAYS}+ days late` : '',
    more.behind.length ? `${plural(more.behind.length, 'agent')} ${ESCALATE_DAYS}+ days behind` : '',
    orphans.length ? `${plural(orphans.length, 'agent')} without a supervisor` : '',
    more.library !== null ? `call library: about ${plural(more.library, 'day')} left` : '',
  ].filter(Boolean);
  if (counts.length) {
    for (const admin of await adminsOf(organizationId)) {
      const created = await notifyOnce(admin.id, `program-admin-digest:${day}`, { type: 'program.digest', title: 'New agents: what needs you', body: counts.join(' · '), link: '/new-agents' });
      if (!created) continue;
      out.adminDigests += 1;
      if (await deliver(adminEmail(admin, late, orphans, now, more), `program-admin-digest:${admin.id}:${day}`, send)) out.emails += 1;
    }
  }
  return out;
}

// Once a day, at 08:30 Tashkent or as soon after as the server is up (lib/jobQueue.js polls every few seconds).
let lastDay = null;
registerJobType({
  name: 'newAgentReminders',
  async findNext() {
    const now = new Date();
    const day = dayKey(now);
    if (lastDay === day || tashkentMinutes(now) < DIGEST_MINUTES) return null;
    lastDay = day;
    return { id: `new-agent-reminders-${day}`, run: async () => { for (const org of await prisma.organization.findMany({ select: { id: true } })) await runMorning(org.id, { now }); } };
  },
  async requeueStuck() {},
});

module.exports = { ESCALATE_DAYS, LOW_ACCURACY, DIGEST_MINUTES, LIBRARY_DAYS, tashkentMinutes, escalationNote, newlyLate, escalated, agentLate, prestartLate, watchersOf, libraryDaysLeft, lowStreak, runAlerts, runMorning, supervisorEmail, adminEmail };
