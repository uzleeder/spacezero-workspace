'use strict';

// New Agent Program reminders, so nothing about a new agent slips (lib/newAgentProgram.js, lib/newAgentBoard.js):
//   * Every morning at 08:30 (Tashkent) each supervisor gets "Today with your new agents" - what is overdue and what is
//     for today - in the app, and by email when program.supervisorEmails is on (off for now). Nothing is sent on a day
//     with nothing to do.
//   * An agent falling behind - an item of theirs one working day late (the day's calls, a training, a standard, the
//     setup checklist), or under 70% accuracy on 3 calls in a row - alerts their supervisor that day.
//   * A supervisor's item 2 of the agent's working days late goes to every Admin, and so does a new agent without a
//     supervisor; the Admins also get a morning email listing them.
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
  return state.tasks.filter((t) => t.owner === 'AGENT' && AGENT_ITEMS.includes(t.kind) && np.stateOf(t, state.pos) === 'LATE' && np.daysLate(t, state.pos) === 1);
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
    if (s.supervisor) {
      const late = newlyLate(s);
      if (late.length && await notifyOnce(s.supervisor.id, `program-behind:${s.program.id}:${s.pos.passed}`, { type: 'program.behind', title: `${name} fell behind`, body: `Not done on day ${s.pos.passed}: ${late.map((t) => t.title).join(', ')}.`, link: page })) out.behind += 1;
      const streak = await lowStreak(s.profile.id);
      if (streak && await notifyOnce(s.supervisor.id, `program-accuracy:${s.program.id}:${streak.startId}`, { type: 'program.low_accuracy', title: `${name}: low accuracy on ${LOW_STREAK} calls in a row`, body: `Their last ${LOW_STREAK} transcripts scored ${streak.last.map((t) => `${Math.round(t.accuracy)}%`).join(', ')}. Listen to one of those calls together.`, link: page })) out.accuracy += 1;
    } else {
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
function adminEmail(admin, late, orphans, now) {
  const lines = [
    `Hi ${first(admin.fullName)},`, '',
    ...(late.length ? [`These supervisor items for new agents are ${ESCALATE_DAYS} or more working days late:`, ...late.map((r) => `- ${r.supervisor} · ${r.agent} · ${r.title} · ${r.daysLate}d overdue`), ''] : []),
    ...(orphans.length ? ['New agents without a supervisor (nobody is doing their supervisor items):', ...orphans.map((n) => `- ${n}`), ''] : []),
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
  for (const s of alerts.states) if (s.supervisor) bySupervisor.set(s.supervisor.id, [...(bySupervisor.get(s.supervisor.id) || []), s]);
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
  const late = alerts.states.flatMap((s) => escalated(s).map((t) => ({ supervisor: s.supervisor ? s.supervisor.fullName : 'No supervisor', agent: s.profile.fullName, title: t.title, daysLate: np.daysLate(t, s.pos) })));
  const orphans = alerts.states.filter((s) => !s.supervisor).map((s) => s.profile.fullName);
  if (late.length || orphans.length) {
    for (const admin of await adminsOf(organizationId)) {
      const created = await notifyOnce(admin.id, `program-admin-digest:${day}`, { type: 'program.digest', title: 'New agents: what needs you', body: [late.length ? `${plural(late.length, 'supervisor item')} ${ESCALATE_DAYS}+ days late` : '', orphans.length ? `${plural(orphans.length, 'agent')} without a supervisor` : ''].filter(Boolean).join(' · '), link: '/new-agents' });
      if (!created) continue;
      out.adminDigests += 1;
      if (await deliver(adminEmail(admin, late, orphans, now), `program-admin-digest:${admin.id}:${day}`, send)) out.emails += 1;
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

module.exports = { ESCALATE_DAYS, LOW_ACCURACY, DIGEST_MINUTES, tashkentMinutes, escalationNote, newlyLate, escalated, lowStreak, runAlerts, runMorning, supervisorEmail, adminEmail };
