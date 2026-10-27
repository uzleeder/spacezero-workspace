'use strict';

// The New agents board (Employees & Teams -> New agents, routes/newAgents.js) and one agent's page, read from the
// programs (lib/newAgentProgram.js). A Supervisor sees their own agents; an Admin sees everyone. For each agent ONE
// status, said in words and never by colour alone - Urgent, Behind, Not signed in yet, Starts soon, On track, Finished
// - with what is wrong, their 4 weeks, their day, their system sign-offs and the last check-in. Above the agents, the
// supervisor's own list across all of them: what is overdue and what is for today. The supervisor's actions (done,
// sign-off, review, extend, working days, days off, notes) are here too. The view functions are pure.
const { prisma } = require('./prisma');
const { logAudit } = require('./audit');
const { supervisedProfileIds } = require('./authz');
const { excludeOtherAdminsTestProfiles } = require('./loginAsScope');
const { dayKey } = require('./callPractice');
const plans = require('./newAgentPlan');
const np = require('./newAgentProgram');

const DAY_MS = 86400000;
const URGENT_DAYS = 2; // late by this many of the agent's working days (or 3 late items) makes an agent urgent
const EXTEND_DAYS = plans.WEEK_DAYS;
const VERDICTS = { ON_TRACK: 'On track', BEHIND: 'Behind', EXTEND: 'Extend a week' };
const STATUS = {
  URGENT: { label: 'Urgent', tone: 'urgent', rank: 0 },
  BEHIND: { label: 'Behind', tone: 'behind', rank: 1 },
  NOT_SIGNED_IN: { label: 'Not signed in yet', tone: 'waiting', rank: 2 },
  STARTS: { label: 'Starts soon', tone: 'waiting', rank: 3 },
  ON_TRACK: { label: 'On track', tone: 'ontrack', rank: 4 },
  FINISHED: { label: 'Finished', tone: 'done', rank: 5 },
};
// a supervisor ticks these (an agent's own task is confirmed by the supervisor); the others tick themselves
const MANUAL = Object.keys(plans.KINDS).filter((k) => !plans.KINDS[k].auto);
const needsSupervisor = (t) => t.owner === 'SUPERVISOR' || t.kind === 'AGENT_TASK';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "Tue 27 Oct" for a YYYY-MM-DD day. */
const shortDate = (key) => (key ? new Date(`${key}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '');
/** "today", "1d ago", "5d ago" by calendar day. */
function ago(date, now = new Date()) {
  const days = Math.round((new Date(`${dayKey(now)}T00:00:00Z`) - new Date(`${dayKey(date)}T00:00:00Z`)) / DAY_MS);
  return days <= 0 ? 'today' : `${days}d ago`;
}
/** One of 8 identity hues for a person's initials, the same on every page. */
function hueOf(id) { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 8; }
const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'They';

/** The agent's status (STATUS key) from their tasks and where they are. */
function statusOf({ profile, tasks, pos, summary }) {
  if (!pos.started) return 'STARTS';
  const late = tasks.filter((t) => np.stateOf(t, pos) === 'LATE');
  if (late.length >= 3 || late.some((t) => np.daysLate(t, pos) >= URGENT_DAYS)) return 'URGENT';
  if (late.length) return 'BEHIND';
  if (profile.status === 'INVITED') return 'NOT_SIGNED_IN';
  if (summary.finished) return 'FINISHED';
  return 'ON_TRACK';
}

/** What is going on, in one or two short sentences. */
function sentenceOf({ status, tasks, pos, cal, profile, viewerIsSupervisor }) {
  if (status === 'STARTS') return `Starts ${shortDate(cal.startKey)}.`;
  const late = tasks.filter((t) => np.stateOf(t, pos) === 'LATE');
  if (late.length) {
    const most = Math.max(...late.map((t) => np.daysLate(t, pos)));
    const items = late.filter((t) => t.kind !== 'CALLS').sort((a, b) => np.daysLate(b, pos) - np.daysLate(a, pos)).slice(0, 2).map((t) => `${t.title} ${np.daysLate(t, pos)}d overdue`);
    const callDays = late.filter((t) => t.kind === 'CALLS').length;
    if (callDays) items.push(`calls short on ${plural(callDays, 'day')}`);
    return `${plural(most, 'day')} behind. ${items.join(', ')}.`.replace(/^./, (c) => c.toUpperCase());
  }
  if (status === 'NOT_SIGNED_IN') return `${firstName(profile.fullName)} has not accepted the invitation and signed in yet.`;
  if (status === 'FINISHED') return 'All 4 weeks are done.';
  const horizon = np.horizonOf(pos);
  const next = tasks.filter((t) => t.owner === 'SUPERVISOR' && t.stepId && !t.doneAt && t.day > horizon).sort((a, b) => a.day - b.day)[0];
  return `Everything is on time.${next ? ` Next with ${viewerIsSupervisor ? 'you' : 'the supervisor'}: ${next.title.charAt(0).toLowerCase()}${next.title.slice(1)}, ${shortDate(np.dateOfDay(cal, next.day))}.` : ''}`;
}

/** Progress of each program week (0-100), leaving out videos that are not made yet. */
function weeksOf(tasks, pos, length) {
  const weeks = [];
  for (let w = 1; (w - 1) * plans.WEEK_DAYS < length; w += 1) {
    const inWeek = tasks.filter((t) => plans.weekOf(t.day) === w && np.stateOf(t, pos) !== 'WAITING');
    const done = inWeek.filter((t) => t.doneAt).length;
    weeks.push({ number: w, done, total: inWeek.length, percent: inWeek.length ? Math.round((done / inWeek.length) * 100) : 0 });
  }
  return weeks;
}

/** The agent's own items on their current day (none on a day off). */
function agentDayOf(tasks, pos, callsToday) {
  if (!pos.today) return [];
  return tasks.filter((t) => t.owner === 'AGENT' && t.day === pos.today && np.stateOf(t, pos) !== 'WAITING').map((t) => ({
    id: t.id, done: Boolean(t.doneAt), title: t.kind === 'CALLS' ? `Calls ${Math.min(callsToday, t.target)} of ${t.target}` : t.title,
  }));
}

/** The system sign-offs, in plan order: done (when, by whom), late (by how many working days) or planned (for when). */
function signOffsOf(tasks, cal, pos) {
  return tasks.filter((t) => t.kind === 'SIGN_OFF').sort((a, b) => a.day - b.day).map((t) => ({
    id: t.id, system: t.system || t.title, title: t.title, done: Boolean(t.doneAt), doneAt: t.doneAt, doneById: t.doneById,
    daysLate: np.stateOf(t, pos) === 'LATE' ? np.daysLate(t, pos) : 0, plannedKey: np.dateOfDay(cal, t.day),
  }));
}

/** When the supervisor last checked in (a check-in or a review they ticked), or null. */
function lastCheckInOf(tasks) {
  const times = tasks.filter((t) => (t.kind === 'CHECK_IN' || t.kind === 'REVIEW') && t.doneAt && t.doneById).map((t) => t.doneAt.getTime());
  return times.length ? new Date(Math.max(...times)) : null;
}

/** The supervisor's list across their agents: overdue first (most overdue on top), then today. */
function supervisorTasksOf(agents) {
  const rows = [];
  for (const a of agents) {
    for (const t of a.tasks) {
      if (!needsSupervisor(t) || t.doneAt) continue;
      const state = np.stateOf(t, a.pos);
      if (state === 'LATE' || state === 'TODAY') rows.push({ task: t, state, daysLate: np.daysLate(t, a.pos), agent: a });
    }
  }
  const late = rows.filter((r) => r.state === 'LATE').sort((x, y) => y.daysLate - x.daysLate || x.agent.profile.fullName.localeCompare(y.agent.profile.fullName));
  const today = rows.filter((r) => r.state === 'TODAY').sort((x, y) => x.agent.profile.fullName.localeCompare(y.agent.profile.fullName) || x.task.day - y.task.day);
  const minutes = today.reduce((sum, r) => sum + (r.task.minutes || 0), 0);
  return { late, today, minutes };
}
const duration = (minutes) => (minutes >= 60 ? `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}` : `${minutes} min`);

// ---------------------------------------------------------------------------------------------- database

/** Everything the board and the agent page show about one program, brought up to date first. */
async function agentState(programId, viewer, { now = new Date() } = {}) {
  const state = await np.refresh(programId, { now });
  if (!state) return null;
  const profile = state.program.profile;
  const [assignment, callsToday, report] = await Promise.all([
    prisma.supervisorAssignment.findFirst({ where: { agentId: profile.id, unassignedAt: null }, select: { supervisor: { select: { id: true, fullName: true } } } }),
    prisma.practiceCallTranscript.count({ where: { profileId: profile.id, submittedAt: { gte: new Date(`${dayKey(now)}T00:00:00+05:00`) } } }),
    require('./callPractice').reportFor(profile),
  ]);
  const supervisor = assignment ? assignment.supervisor : null;
  const viewerIsSupervisor = Boolean(supervisor && viewer && supervisor.id === viewer.id);
  const status = statusOf({ profile, ...state });
  return {
    ...state, profile, supervisor, viewerIsSupervisor, callsToday, report,
    status, statusInfo: STATUS[status], sentence: sentenceOf({ status, ...state, profile, viewerIsSupervisor }),
    weeks: weeksOf(state.tasks, state.pos, state.summary.length), agentDay: agentDayOf(state.tasks, state.pos, callsToday),
    signOffs: signOffsOf(state.tasks, state.cal, state.pos), lastCheckIn: lastCheckInOf(state.tasks), hue: hueOf(profile.id), initials: initials(profile.fullName),
  };
}

/** The running programs the viewer may see: a Supervisor's own agents, everyone's for an Admin. */
async function visiblePrograms(viewer) {
  const where = { organizationId: viewer.organizationId, status: 'ACTIVE' };
  if (viewer.role === 'SUPERVISOR') where.profileId = { in: await supervisedProfileIds(viewer.id) };
  else if (viewer.role === 'ADMIN') where.profile = excludeOtherAdminsTestProfiles(viewer);
  else return [];
  return prisma.agentProgram.findMany({ where, select: { id: true } });
}

/** The board: the agents (most urgent first) and the supervisor's list. An Admin may narrow it to one supervisor. */
async function boardFor(viewer, { supervisorId = '', now = new Date() } = {}) {
  const all = [];
  for (const p of await visiblePrograms(viewer)) { const a = await agentState(p.id, viewer, { now }); if (a) all.push(a); }
  const supervisors = [...new Map(all.filter((a) => a.supervisor).map((a) => [a.supervisor.id, a.supervisor])).values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
  const agents = (viewer.role === 'ADMIN' && supervisorId ? all.filter((a) => (supervisorId === 'none' ? !a.supervisor : a.supervisor && a.supervisor.id === supervisorId)) : all)
    .sort((a, b) => a.statusInfo.rank - b.statusInfo.rank || a.profile.fullName.localeCompare(b.profile.fullName));
  const counts = Object.fromEntries(Object.keys(STATUS).map((k) => [k, agents.filter((a) => a.status === k).length]));
  return { agents, supervisors, counts, tasks: supervisorTasksOf(agents), noSupervisor: all.filter((a) => !a.supervisor).length };
}

/** For the dashboard's "Needs your attention": supervisor items late and for today, and agents without a supervisor. */
async function attentionCounts(viewer, { now = new Date() } = {}) {
  const out = { late: 0, today: 0, noSupervisor: 0 };
  for (const { id } of await visiblePrograms(viewer)) {
    const program = await prisma.agentProgram.findUnique({ where: { id }, include: { tasks: { where: { doneAt: null } } } });
    const pos = np.positionOn(np.calendarOf(program, await np.leaveKeysFor(program.profileId)), dayKey(now));
    for (const t of program.tasks.filter(needsSupervisor)) {
      const state = np.stateOf(t, pos);
      if (state === 'LATE') out.late += 1; else if (state === 'TODAY') out.today += 1;
    }
    if (!await prisma.supervisorAssignment.findFirst({ where: { agentId: program.profileId, unassignedAt: null }, select: { id: true } })) out.noSupervisor += 1;
  }
  return out;
}

/** The notes on the agent page: free notes and what the supervisor wrote when ticking an item, newest first. */
async function notesFor(state) {
  const free = await prisma.coachingNote.findMany({ where: { profileId: state.profile.id, skillId: null }, include: { author: { select: { fullName: true } } }, orderBy: { createdAt: 'desc' }, take: 20 });
  const ids = [...new Set(state.tasks.filter((t) => t.doneById).map((t) => t.doneById))];
  const people = new Map((ids.length ? await prisma.profile.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } }) : []).map((p) => [p.id, p.fullName]));
  const fromTasks = state.tasks.filter((t) => t.doneById && (t.note || t.kind === 'REVIEW')).map((t) => {
    const verdict = (() => { try { return JSON.parse(t.resultJson || '{}').verdict; } catch { return null; } })();
    return { at: t.doneAt, author: people.get(t.doneById) || 'Someone', what: `${(plans.KINDS[t.kind] || {}).label || 'Item'}: ${t.title}${verdict ? ` · ${VERDICTS[verdict]}` : ''}`, body: t.note || '' };
  });
  return [...free.map((n) => ({ at: n.createdAt, author: n.author.fullName, what: 'Note', body: n.body })), ...fromTasks].sort((a, b) => b.at - a.at).slice(0, 20);
}

const audit = (actor, program, action, metadata) => logAudit({ organizationId: program.organizationId, actorId: actor.id, action, targetTable: 'AgentProgram', targetId: program.id, metadata: { employeeId: program.profileId, ...metadata } });

/**
 * The supervisor (or an Admin) ticks an item: done, a sign-off, a check-in, a review (with a verdict; "Extend a week"
 * adds 5 working days). Returns an error message, or null.
 */
async function completeTask(actor, program, task, { note = '', verdict = '' } = {}) {
  if (!MANUAL.includes(task.kind)) return 'This item ticks itself when it is done.';
  if (task.doneAt) return null; // a second tap changes nothing
  const text = String(note || '').trim().slice(0, 1000);
  if (task.kind === 'REVIEW' && !VERDICTS[verdict]) return 'Choose how the week went.';
  if (task.kind === 'REVIEW' && text.length < 2) return 'Write a line about the week.';
  const saved = await prisma.agentProgramTask.updateMany({ where: { id: task.id, doneAt: null }, data: { doneAt: new Date(), doneById: actor.id, note: text || null, resultJson: task.kind === 'REVIEW' ? JSON.stringify({ verdict }) : null } });
  if (saved.count && verdict === 'EXTEND') await prisma.agentProgram.update({ where: { id: program.id }, data: { extraDays: { increment: EXTEND_DAYS } } });
  if (saved.count) await audit(actor, program, task.kind === 'SIGN_OFF' ? 'program.signed_off' : 'program.task_done', { taskId: task.id, kind: task.kind, title: task.title, verdict: verdict || undefined });
  return null;
}

/** Takes back an item a person ticked by mistake (and the extra week a review asked for). */
async function undoTask(actor, program, task) {
  if (!task.doneAt || !task.doneById) return 'Only an item somebody ticked can be taken back.';
  let verdict = null; try { verdict = JSON.parse(task.resultJson || '{}').verdict; } catch { /* none */ }
  await prisma.agentProgramTask.update({ where: { id: task.id }, data: { doneAt: null, doneById: null, note: null, resultJson: null } });
  if (verdict === 'EXTEND') await prisma.agentProgram.update({ where: { id: program.id }, data: { extraDays: Math.max(0, program.extraDays - EXTEND_DAYS) } });
  await audit(actor, program, 'program.task_undone', { taskId: task.id, title: task.title });
  return null;
}

async function extend(actor, program) {
  await prisma.agentProgram.update({ where: { id: program.id }, data: { extraDays: { increment: EXTEND_DAYS } } });
  await audit(actor, program, 'program.extended', { days: EXTEND_DAYS });
}

async function setWorkDays(actor, program, days) {
  const clean = np.cleanWorkDays(days);
  if (!clean.length) return 'Choose at least one working day.';
  await prisma.agentProgram.update({ where: { id: program.id }, data: { workDaysJson: JSON.stringify(clean), workDaysConfirmedAt: program.workDaysConfirmedAt || new Date() } });
  await audit(actor, program, 'program.work_days_set', { days: clean });
  return null;
}

/** A one-off day off (sick, a swapped shift): it does not count as a working day. */
async function setDayOff(actor, program, key, off) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key) || Number.isNaN(Date.parse(`${key}T00:00:00Z`))) return 'Choose a date.';
  if (key < program.startDate || key > np.addDays(program.startDate, 180)) return 'Choose a date inside the program.';
  const list = new Set(JSON.parse(program.daysOffJson || '[]'));
  if (off) list.add(key); else list.delete(key);
  await prisma.agentProgram.update({ where: { id: program.id }, data: { daysOffJson: JSON.stringify([...list].sort()) } });
  await audit(actor, program, off ? 'program.day_off_added' : 'program.day_off_removed', { day: key });
  return null;
}

async function addNote(actor, program, body) {
  const text = String(body || '').trim().slice(0, 2000);
  if (text.length < 2) return 'Write the note first.';
  await prisma.coachingNote.create({ data: { organizationId: program.organizationId, profileId: program.profileId, authorId: actor.id, body: text } });
  await audit(actor, program, 'program.note_added', {});
  return null;
}

module.exports = {
  STATUS, VERDICTS, MANUAL, URGENT_DAYS, EXTEND_DAYS,
  shortDate, ago, hueOf, initials, firstName, needsSupervisor, statusOf, sentenceOf, weeksOf, agentDayOf, signOffsOf, lastCheckInOf, supervisorTasksOf, duration,
  agentState, visiblePrograms, boardFor, attentionCounts, notesFor, completeTask, undoTask, extend, setWorkDays, setDayOff, addNote,
};
