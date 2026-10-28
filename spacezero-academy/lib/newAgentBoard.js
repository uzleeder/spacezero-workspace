'use strict';

// The New agents board (Employees & Teams -> New agents, routes/newAgents.js) and one agent's page, read from the
// programs (lib/newAgentProgram.js). A Supervisor sees their own agents; an Admin sees everyone. ONE line per agent, in
// one group said in words and never by colour alone - Urgent, Needs you, Behind, Not started, On track, Finished -
// with everything that is going on, the one next step and its button; the agent's page has every item day by day.
// The supervisor's actions (done, sign-off, review, extend, working days, days off, notes) are here too. The view
// functions are pure.
// New Travel Agents (np.onTravelPath) also have: an owner for every item who is a real, active person (ownerOf - the
// agent, their supervisor or the admin who hired them; when the supervisor is disabled, on approved leave or missing,
// the admins cover from that first day: coverOf), the "Ready for solo live calls" gate (readinessOf, approve), the
// end-of-ramp decision (extendRamp). untrackedHires is the daily check that every new Travel Agent is accounted for.
// Admin checks, Travel Agents only (nobody marks their own work as passed): only an admin approves and takes a tick
// back; a supervisor's sign-off is a request an admin confirms (requestSignOff, confirmSignOff, sendBack); the agent
// answers "did this happen?" (checksFor, answerCheck); flagsOf names the ticks that need a second look (clearFlag).
// An Admin's "Waiting for you" page is approvalsFor.
const { prisma } = require('./prisma');
const { logAudit } = require('./audit');
const { supervisedProfileIds } = require('./authz');
const { excludeOtherAdminsTestProfiles } = require('./loginAsScope');
const { dayKey } = require('./callPractice');
const { notifyOnce } = require('./notifications');
const plans = require('./newAgentPlan');
const np = require('./newAgentProgram');

const DAY_MS = 86400000;
const URGENT_DAYS = 2; // late by this many of the agent's working days (or 3 late items) makes an agent urgent
const EXTEND_DAYS = plans.WEEK_DAYS;
const IDLE_DAYS = 2; // no call and nothing done for this many working days shows in "What's going on"
const TRACK_DAYS = 90; // a Travel Agent hired this recently (or starting later) must be on the path: untrackedHires
const VERDICTS = { ON_TRACK: 'On track', BEHIND: 'Behind', EXTEND: 'Extend a week' };
// The board's groups, most urgent first. Every agent is in exactly one (groupOf), so the counts add up to All.
const GROUPS = {
  URGENT: { label: 'Urgent', tone: 'urgent', rank: 0 },
  NEEDS_YOU: { label: 'Needs you', tone: 'needs', rank: 1 },
  BEHIND: { label: 'Behind', tone: 'behind', rank: 2, meaning: 'Their own work is a day late' },
  NOT_STARTED: { label: 'Not started', tone: 'waiting', rank: 3, meaning: 'Not signed in yet, or starting soon' },
  ON_TRACK: { label: 'On track', tone: 'ontrack', rank: 4, meaning: 'Everything is on time' },
  FINISHED: { label: 'Finished', tone: 'done', rank: 5, meaning: 'All 4 weeks are done' },
};
/** What a group means, said to this viewer. */
function groupMeaning(key, isAdmin) {
  if (key === 'URGENT') return `2 or more working days late, or ${plans.SWITCHES.ramp ? 'the ramp is over' : 'Month 1 is over and they are not ready'}. ${isAdmin ? 'Admins have' : 'Your admin has'} been told.`;
  if (key === 'NEEDS_YOU') return isAdmin ? 'Waiting on you: approvals, sign-offs to confirm, and agents you cover' : 'Waiting on you. After 2 working days late, your admin is told.';
  if (key === 'BEHIND' && isAdmin) return 'A day late: their own work or their supervisor’s';
  return GROUPS[key].meaning;
}
// a supervisor ticks these (an agent's own task is confirmed by the supervisor); the others tick themselves
const MANUAL = Object.keys(plans.KINDS).filter((k) => !plans.KINDS[k].auto);
/** A Travel Agent's sign-off the supervisor asked for, waiting for an admin to confirm it (np.stateOf: CONFIRM). */
const awaitsAdmin = (t) => Boolean(t.requestedAt && !t.doneAt);
const needsSupervisor = (t) => !awaitsAdmin(t) && (t.owner === 'SUPERVISOR' || t.kind === 'AGENT_TASK');
// the items a new Travel Agent is asked about ("did this happen?"), and the ones a flag can be on
const ASKED = ['SIGN_OFF', 'DEMO', 'CHECK_IN'];
const ASK_DAYS = 7; // asked for this many calendar days after the tick
const BURST = { count: 3, minutes: 5 }; // this many ticks by one person within these minutes is flagged
const ANSWERS = { YES: 'Yes', NO: 'No, it did not happen', UNSURE: 'Not sure' };
// the 5-minute check-in planned on most days: it never makes an agent "need you" on its own
const isDailyCheckIn = (t) => String(t.key || '').startsWith('checkin:');
const ACTIONS = { SIGN_OFF: 'Sign off', REVIEW: 'Write review', SCHEDULE: 'Set working days', AGENT_TASK: 'Confirm done', ACCOUNT: 'Add login' };
const isPrestart = (t) => t.day === plans.PRESTART_DAY;
/** Can a Travel Agent be approved now: in the ramp, or (ramp switched off) from the end of Month 1 on? */
const gateOpen = (summary) => Boolean(summary && summary.travel && (summary.stage === 'RAMP' || (!plans.SWITCHES.ramp && summary.stage === 'MONTH_1')));
const moreTime = () => (plans.SWITCHES.ramp ? 'extend the ramp' : 'extend a week');
/**
 * A Travel Agent's missed calls day can never be made up: once it has been to their supervisor (+1) and the admins
 * (+2) it is history - it no longer keeps them Urgent or Behind, and My day does not show it.
 */
const isHistory = (t, pos, travel) => Boolean(travel && t.kind === 'CALLS' && !t.doneAt && np.daysLate(t, pos) > URGENT_DAYS);

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
const initials = (name) => String(name || '?').trim().split(/\s+/).filter((w) => /\p{L}/u.test(w[0])).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'They';

/**
 * The agent's group (GROUPS key) from their tasks and where they are, for this viewer: "Needs you" is a Supervisor's
 * items late or for today; for an Admin it is what only an admin does (approve, confirm a sign-off, an admin's own
 * item) and the supervisor items of an agent the admins cover. A supervisor item a day late is "Behind" to an Admin.
 */
function groupOf({ profile, tasks, pos, summary, readiness = null, isAdmin = false, cover = null }) {
  if (!pos.started) return 'NOT_STARTED';
  const late = tasks.filter((t) => np.stateOf(t, pos) === 'LATE' && !isHistory(t, pos, summary.travel));
  const ready = gateOpen(summary) && readiness && readiness.met; // waits for an admin's Approve
  if ((summary.rampOver && !ready) || late.length >= 3 || late.some((t) => np.daysLate(t, pos) >= URGENT_DAYS)) return 'URGENT';
  const supervisors = (t) => needsSupervisor(t) && (late.includes(t) || (!isDailyCheckIn(t) && np.stateOf(t, pos) === 'TODAY'));
  if (!isAdmin && tasks.some(supervisors)) return 'NEEDS_YOU';
  if (isAdmin && (ready || tasks.some(awaitsAdmin) || late.some((t) => t.owner === 'ADMIN') || (cover && cover.absent && tasks.some(supervisors)))) return 'NEEDS_YOU';
  if (late.length) return 'BEHIND';
  if (profile.status === 'INVITED') return 'NOT_STARTED';
  if (summary.finished) return 'FINISHED';
  return 'ON_TRACK';
}

/** An item said short: "Dialpad sign-off", "EGF demo", "Cockpit video", "calls". */
function shortTitle(t) {
  if (t.kind === 'SIGN_OFF') return `${t.system || t.title} sign-off`;
  if (t.kind === 'DEMO' && t.system) return `${t.system} demo`;
  if (t.kind === 'TRAINING' && t.system) return `${t.system} video`;
  if (t.kind === 'CALLS') return 'calls';
  if (t.kind === 'ACCOUNT' && t.system) return `${t.system} account`;
  return t.title;
}
const listOf = (names) => (names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** Everything that is going on, in one line: what is late (and how late), else what is on today, and the call accuracy. */
function goingOnOf({ tasks, pos, cal, profile, report, summary = null, readiness = null, idle = 0 }) {
  const before = tasks.filter(isPrestart);
  if (!pos.started) {
    if (!before.length) return `Starts ${shortDate(cal.startKey)}`;
    const open = before.filter((t) => np.stateOf(t, pos) === 'LATE');
    return [`Starts ${shortDate(cal.startKey)}`, `${before.filter((t) => t.doneAt).length} of ${before.length} ready`, open.length ? `${open.length} not ready, due ${shortDate(pos.pre.dueKey)}` : ''].filter(Boolean).join(' · ');
  }
  const parts = [];
  if (summary && summary.rampOver && !(readiness && readiness.met)) parts.push(`${summary.overText}: an admin decides`);
  if (profile.status === 'INVITED') parts.push('has not signed in yet');
  const late = tasks.filter((t) => np.stateOf(t, pos) === 'LATE');
  const pre = late.filter(isPrestart);
  if (pre.length) parts.push(`${plural(pre.length, 'pre-start item')} still open`);
  if (idle >= IDLE_DAYS) parts.push(`no activity for ${idle} working days`);
  const most = (list) => Math.max(...list.map((t) => np.daysLate(t, pos)));
  const signs = late.filter((t) => t.kind === 'SIGN_OFF');
  if (signs.length) parts.push(`${listOf(signs.map((t) => t.system || t.title))} sign-off${signs.length === 1 ? '' : 's'} ${most(signs)}d late`);
  const singles = late.filter((t) => !isPrestart(t) && (['REVIEW', 'DEMO', 'SUPERVISOR_TASK', 'SCHEDULE', 'AGENT_TASK'].includes(t.kind) || (t.kind === 'CHECK_IN' && !isDailyCheckIn(t))));
  parts.push(...singles.slice(0, 2).map((t) => `${shortTitle(t)} ${np.daysLate(t, pos)}d late`));
  if (singles.length > 2) parts.push(`${singles.length - 2} more late`);
  const missed = late.filter(isDailyCheckIn).length;
  if (missed) parts.push(`${plural(missed, 'check-in')} missed`);
  const calls = late.filter((t) => t.kind === 'CALLS').length; // every missed day, even the ones that are history
  if (calls) parts.push(`calls short on ${plural(calls, 'day')}`);
  const videos = late.filter((t) => t.kind === 'TRAINING');
  if (videos.length) parts.push(`${listOf(videos.map((t) => t.system || t.title))} video${videos.length === 1 ? '' : 's'} not finished`);
  const reads = late.filter((t) => t.kind === 'READ').length;
  if (reads) parts.push(`${plural(reads, 'standard')} not read`);
  if (late.some((t) => t.kind === 'SETUP')) parts.push('setup not finished');
  if (!late.length && !(summary && summary.rampOver)) {
    if (!pos.today) parts.push('day off today');
    const today = tasks.filter((t) => needsSupervisor(t) && !isDailyCheckIn(t) && np.stateOf(t, pos) === 'TODAY');
    parts.push(today.length ? `today: ${today.map(shortTitle).join(', ')}` : 'everything on time');
  }
  if (readiness && summary.stage === 'RAMP') parts.push(`ready: ${readiness.metCount} of ${readiness.checks.length}`);
  else if (report && report.averageAccuracy != null) parts.push(`calls ${Math.round(report.averageAccuracy)}%`);
  const text = parts.join(' · ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The one next step for the supervisor: the most overdue item that waits on them, else today's (the daily check-in
 * last), with the button that does it. Nothing waiting on them: what to chase or what comes next, without a button.
 */
function nextStepOf({ tasks, pos, cal, profile, summary = null, readiness = null, isAdmin = false, supervisor = null, cover = null }) {
  const travel = Boolean(summary && summary.travel);
  const mine = tasks.filter((t) => needsSupervisor(t) && !t.doneAt);
  const late = mine.filter((t) => np.stateOf(t, pos) === 'LATE').sort((a, b) => np.daysLate(b, pos) - np.daysLate(a, pos) || a.day - b.day);
  const today = mine.filter((t) => np.stateOf(t, pos) === 'TODAY').sort((a, b) => Number(isDailyCheckIn(a)) - Number(isDailyCheckIn(b)) || a.day - b.day);
  const task = late[0] || today[0] || null;
  const review = { label: 'Review', href: `/new-agents/approvals#agent-${profile.id}` };
  const waiting = tasks.filter(awaitsAdmin);
  const ready = gateOpen(summary) && readiness && readiness.met;
  const signOffs = (list) => `${listOf(list.map((t) => t.system || t.title))} sign-off${list.length === 1 ? '' : 's'}`;
  if (summary && summary.rampOver && !ready) return isAdmin && travel ? { text: `Decide: ${moreTime()} or approve anyway`, button: { ...review, label: 'Decide' } } : { text: `An admin decides: ${moreTime()} or approve anyway`, lock: travel };
  // what only an admin does comes first for an Admin
  if (isAdmin && travel && waiting.length) return { text: `Confirm ${signOffs(waiting)}`, button: review };
  if (isAdmin && ready) return { text: 'Approve for solo live calls', button: review };
  const before = tasks.filter((t) => isPrestart(t) && !t.doneAt);
  if (isAdmin && travel && !pos.started && before.length) return { text: `Get ready: ${listOf(before.map(shortTitle))}` };
  if (task) {
    // an Admin chases the supervisor, unless the admins cover; a supervisor asks an admin to confirm a Travel Agent's sign-off
    const chase = isAdmin && supervisor && !(cover && cover.absent);
    const text = chase ? `Chase ${firstName(supervisor.fullName)}: ${shortTitle(task)}`
      : task.kind === 'SIGN_OFF' ? (travel && !isAdmin ? `Request ${task.system || task.title} sign-off` : `Sign off ${task.system || task.title}`) : task.title;
    return { task, text, action: ACTIONS[task.kind] || 'Mark done', link: task.kind === 'REVIEW' || task.kind === 'SCHEDULE' };
  }
  if (ready) return { text: 'Waiting for an admin to approve', lock: true };
  if (travel && waiting.length) return { text: `Waiting for an admin: ${signOffs(waiting)}`, lock: true };
  const first = firstName(profile.fullName);
  if (!pos.started) return { text: `Starts ${shortDate(cal.startKey)}` };
  if (profile.status === 'INVITED') return { text: `Ask ${first} to accept the invitation` };
  const theirs = tasks.filter((t) => t.owner === 'AGENT' && np.stateOf(t, pos) === 'LATE').sort((a, b) => np.daysLate(b, pos) - np.daysLate(a, pos));
  if (theirs.length) return { text: `Remind ${first} about ${shortTitle(theirs[0])}` };
  const ahead = mine.filter((t) => t.day > np.horizonOf(pos) && !isDailyCheckIn(t)).sort((a, b) => a.day - b.day)[0];
  return ahead ? { text: `Next: ${shortTitle(ahead)}, ${shortDate(np.dateOfDay(cal, ahead.day))}` } : { text: 'Nothing waiting' };
}

/** The most working days anything of this agent's is late (0 when nothing is). */
function maxLateOf(tasks, pos, travel = false) {
  const late = tasks.filter((t) => np.stateOf(t, pos) === 'LATE' && !isHistory(t, pos, travel));
  return late.length ? Math.max(...late.map((t) => np.daysLate(t, pos))) : 0;
}

/** Progress of each program week (0-100), leaving out videos that are not made yet. */
function weeksOf(tasks, pos, length) {
  const weeks = [];
  for (let w = 1; (w - 1) * plans.WEEK_DAYS < length; w += 1) {
    const inWeek = tasks.filter((t) => !isPrestart(t) && plans.weekOf(t.day) === w && np.stateOf(t, pos) !== 'WAITING');
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
    waiting: awaitsAdmin(t), requestedAt: t.requestedAt, requestedById: t.requestedById,
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

/**
 * Who does an item, as a person: the agent; their supervisor - or, while the admins cover (coverOf), the admin; for an
 * Admin's item, the admin who hired them (another active admin when that one is gone). null only with no admin at all.
 */
function ownerOf(task, { agent, supervisor, cover, admin }) {
  if (awaitsAdmin(task)) return admin; // a sign-off the supervisor asked for: an admin confirms it
  if (task.owner === 'AGENT') return agent;
  if (task.owner === 'SUPERVISOR') return cover && cover.absent ? admin : supervisor;
  return admin;
}

/** The gate's criteria, each { key, label, ok, detail }, from the agent's items and their latest calls (newest first). */
function readinessOf({ tasks, pos, plan, summary }, recent) {
  const r = plans.readyOf(plan);
  const signs = tasks.filter((t) => t.kind === 'SIGN_OFF');
  const last = (key) => recent.filter((x) => x[key] != null).slice(0, r.calls);
  const avg = (rows, key) => (rows.length ? Math.round(rows.reduce((n, x) => n + x[key], 0) / rows.length) : null);
  const scored = last('accuracy'); const timed = last('wordsPerMinute');
  const accuracy = avg(scored, 'accuracy'); const wpm = avg(timed, 'wordsPerMinute');
  const final = tasks.filter((t) => t.kind === 'REVIEW' && !isPrestart(t) && t.day <= summary.lengths.month1).sort((a, b) => b.day - a.day)[0] || null;
  // a missed call day cannot be made up, so it never blocks the gate; everything else overdue does
  const overdue = tasks.filter((t) => t.kind !== 'CALLS' && np.stateOf(t, pos) === 'LATE').length;
  const short = (rows) => `${rows.length} of ${r.calls} calls typed so far`;
  const checks = [
    { key: 'signoffs', label: 'Every system sign-off, confirmed by an admin', ok: signs.every((t) => t.doneAt), detail: `${signs.filter((t) => t.doneAt).length} of ${signs.length} confirmed${signs.some(awaitsAdmin) ? ` · ${signs.filter(awaitsAdmin).length} waiting` : ''}` },
    { key: 'accuracy', label: `Accuracy ${r.accuracy}% or more over the last ${r.calls} calls`, ok: scored.length >= r.calls && accuracy >= r.accuracy, detail: scored.length < r.calls ? short(scored) : `${accuracy}%` },
    { key: 'speed', label: `Typing speed ${r.wpm} words a minute or more`, ok: timed.length >= r.calls && wpm >= r.wpm, detail: timed.length < r.calls ? short(timed) : `${wpm} wpm` },
    { key: 'review', label: 'Month 1 final review done', ok: !final || Boolean(final.doneAt), detail: !final ? 'None in the plan' : final.doneAt ? `Done ${shortDate(dayKey(final.doneAt))}` : 'Not done yet' },
    { key: 'overdue', label: 'Nothing overdue', ok: overdue === 0, detail: overdue ? `${overdue} overdue` : 'Nothing overdue' },
  ];
  const metCount = checks.filter((c) => c.ok).length;
  return { checks, metCount, met: metCount === checks.length, accuracy, wpm, targets: r };
}

/** Working days that went by with no call submitted and nothing done by the agent (0 before day 1). */
function idleDaysOf({ cal, pos, tasks }, lastCallAt, todayKey) {
  if (!pos.started) return 0;
  const times = tasks.filter((t) => t.owner === 'AGENT' && t.doneAt).map((t) => t.doneAt.getTime());
  if (lastCallAt) times.push(new Date(lastCallAt).getTime());
  const lastKey = times.length ? dayKey(new Date(Math.max(...times))) : null;
  let n = 0;
  for (let key = lastKey && lastKey >= cal.startKey ? np.addDays(lastKey, 1) : cal.startKey, i = 0; key < todayKey && i < 400; key = np.addDays(key, 1), i += 1) if (np.isWorking(cal, key)) n += 1;
  return n;
}

/**
 * The board's Progress: in Month 1 (a Flight Expert's 4 weeks) the share of the plan done, against the share due by
 * today (plan); in the ramp the ready checks met; before day 1 what is ready. { text, meta, percent, plan|null }
 */
function progressOf({ tasks, pos, summary }, readiness) {
  const share = (n, of) => (of ? Math.round((n / of) * 100) : 0);
  if (!pos.started) {
    const before = tasks.filter(isPrestart); const done = before.filter((t) => t.doneAt).length;
    return before.length ? { text: `${done} of ${before.length}`, meta: 'ready for day 1', percent: share(done, before.length), plan: null } : { text: '—', meta: 'not started', percent: 0, plan: null };
  }
  if (summary.stage === 'RAMP' && readiness) return { text: `${readiness.metCount} of ${readiness.checks.length}`, meta: 'ready checks', percent: share(readiness.metCount, readiness.checks.length), plan: null };
  const last = summary.stage === 'MONTH_1' ? summary.lengths.month1 : summary.lengths.total;
  const counted = tasks.filter((t) => !isPrestart(t) && t.kind !== 'CALLS' && t.day <= last && np.stateOf(t, pos) !== 'WAITING');
  const percent = share(counted.filter((t) => t.doneAt).length, counted.length);
  const plan = share(counted.filter((t) => t.day <= (pos.today || pos.passed)).length, counted.length);
  return { text: `${percent}%`, meta: `plan ${plan}%`, percent, plan };
}

/** Call quality over the last `calls` typed calls (newest first in): average accuracy and speed, the trend, and each call's accuracy oldest first. */
function qualityOf(recent, calls = 10) {
  const avg = (xs) => (xs.length ? Math.round(xs.reduce((n, x) => n + x, 0) / xs.length) : null);
  const rows = recent.filter((x) => x.accuracy != null).slice(0, calls).reverse();
  if (!rows.length) return null;
  const spark = rows.map((x) => Math.round(x.accuracy));
  const half = Math.floor(spark.length / 2);
  const change = spark.length >= 4 ? avg(spark.slice(half)) - avg(spark.slice(0, half)) : 0;
  return { accuracy: avg(spark), wpm: avg(recent.filter((x) => x.wordsPerMinute != null).slice(0, calls).map((x) => x.wordsPerMinute)), trend: change >= 2 ? 'up' : change <= -2 ? 'down' : 'flat', spark };
}

/**
 * The supervisor's ticks on a new Travel Agent that need a second look, newest first: the agent says it did not
 * happen, BURST.count or more ticks within BURST.minutes, ticked on the agent's day off, or before its planned day. An
 * admin who let one be (flagClearedAt) is not asked again. [{ task, at, reasons, text }]
 */
function flagsOf({ tasks, cal, profile, supervisor, travel }) {
  if (!travel || !supervisor) return [];
  const tickOf = (t) => (t.requestedById === supervisor.id ? t.requestedAt : t.doneById === supervisor.id ? t.doneAt : null);
  const ticked = tasks.filter((t) => MANUAL.includes(t.kind) && tickOf(t)).map((t) => ({ t, at: new Date(tickOf(t)) }));
  const first = firstName(profile.fullName);
  const out = [];
  for (const { t, at } of ticked) {
    if (t.flagClearedAt) continue;
    const reasons = [];
    if (t.agentAnswer === 'NO') reasons.push(`${first} says it did not happen`);
    const near = ticked.filter((x) => Math.abs(x.at - at) <= BURST.minutes * 60000).length;
    if (near >= BURST.count) reasons.push(`${near} ticks within ${BURST.minutes} minutes`);
    const key = dayKey(at);
    if (!np.isWorking(cal, key)) reasons.push(`ticked on ${first}'s day off`);
    const planned = isPrestart(t) ? null : np.dateOfDay(cal, t.day);
    if (planned && key < planned) reasons.push(`ticked before its day (${shortDate(planned)})`);
    if (reasons.length) out.push({ task: t, at, reasons, text: `${shortTitle(t)}: ${reasons.join(', ')}` });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** The question a new Travel Agent answers about an item someone else ticked. */
function questionOf(t, who) {
  if (t.kind === 'SIGN_OFF') return `Did ${who} watch you do this on your own: ${String(t.title).replace(/^Sign off\s*/i, '')}?`;
  if (t.kind === 'DEMO') return `Did ${who} go through this with you: ${t.title}?`;
  return `Did you have this with ${who}: ${t.title}?`;
}
/** What a new Travel Agent is asked on My day: sign-offs, demos and 1:1s someone else ticked in the last ASK_DAYS days, not answered yet. */
function checksOf({ tasks, profile, travel }, names, now = new Date()) {
  if (!travel) return [];
  const by = (t) => t.requestedById || t.doneById;
  const at = (t) => t.requestedAt || t.doneAt;
  return tasks.filter((t) => ASKED.includes(t.kind) && !isDailyCheckIn(t) && !t.agentAnswer && at(t) && by(t) && by(t) !== profile.id && now - new Date(at(t)) <= ASK_DAYS * DAY_MS)
    .sort((a, b) => new Date(at(a)) - new Date(at(b)))
    .map((t) => ({ id: t.id, question: questionOf(t, names.get(by(t)) ? firstName(names.get(by(t))) : 'your supervisor') }));
}

/** A Travel Agent's stage in words: { stage, label: 'Month 1', detail: 'day 7 of 20' }; null for anyone else. */
function stageText(a) {
  const s = a.summary;
  if (!s.stage) return null;
  const detail = s.stage === 'PRE_START' ? `starts ${shortDate(a.cal.startKey)}`
    : s.stage === 'LIVE' ? `since ${shortDate(dayKey(a.program.approvedAt))}`
      : s.stage === 'MONTH_1' ? (a.pos.today ? `day ${a.pos.today} of ${s.length}` : 'day off today')
        : !plans.SWITCHES.ramp ? (s.rampOver ? `Month 1 ended ${shortDate(np.dateOfDay(a.cal, s.lengths.month1))}` : `day ${a.pos.today ? a.pos.today - s.lengths.month1 : a.pos.passed - s.lengths.month1} of ${s.lengths.ramp}`)
          : s.rampOver ? 'over' : `week ${s.rampWeek} of ${s.rampWeeks}`;
  // the steps of the path line (partials/stage-line); with the ramp off, the time after Month 1 is still Month 1's step
  const path = plans.SWITCHES.ramp ? [['PRE_START', 'Pre-start'], ['MONTH_1', 'Month 1'], ['RAMP', 'Ramp'], ['LIVE', 'Live']] : [['PRE_START', 'Before day 1'], ['MONTH_1', 'Month 1'], ['LIVE', 'Ready for solo live calls']];
  const at = path.findIndex(([k]) => k === (s.stage === 'RAMP' && !plans.SWITCHES.ramp ? 'MONTH_1' : s.stage));
  const stepDetail = s.stage === 'RAMP' && !plans.SWITCHES.ramp ? `${s.stageLabel} · ${detail}` : detail;
  return { stage: s.stage, label: s.stageLabel, detail, text: `${s.stageLabel} · ${detail}`, path: path.map(([key, name]) => ({ key, name })), at, stepDetail };
}

/**
 * The board line's columns besides the next step, said short for this viewer: who (with their supervisor for an Admin),
 * the stage bar (4 steps for a new Travel Agent, 1 for anyone else), sign-off blocks, when they were last seen and had
 * a 1:1 (Admins), and today's calls (Supervisors).
 */
function cellsOf(a, { isAdmin = false, now = new Date() } = {}) {
  const s = a.summary;
  const pct = (n, of) => (of ? Math.max(0, Math.min(100, Math.round((n / of) * 100))) : 0);
  const st = stageText(a);
  let stage;
  if (!st) {
    stage = { label: s.started ? `Week ${s.week}` : 'Not started', detail: !s.started ? `starts ${shortDate(a.cal.startKey)}` : a.pos.today ? `day ${a.pos.today} of ${s.length}` : 'day off today', steps: [pct(Math.min(a.pos.today || a.pos.passed, s.length), s.length)] };
  } else if (!plans.SWITCHES.ramp) {
    // Month 1 only: one segment per week of Month 1, full once the week is over
    const day = s.started ? Math.min(a.pos.today || a.pos.passed, s.lengths.month1) : 0;
    const weeks = Array.from({ length: Math.ceil(s.lengths.month1 / plans.WEEK_DAYS) }, (_, i) => pct(day - i * plans.WEEK_DAYS, plans.WEEK_DAYS));
    stage = { label: s.stage === 'MONTH_1' ? `Week ${s.week}` : st.label, detail: st.detail, steps: weeks };
  } else {
    const order = Object.keys(np.STAGES);
    const at = order.indexOf(s.stage);
    const within = s.stage === 'PRE_START' ? pct(s.prestart ? s.prestart.done : 0, s.prestart ? s.prestart.total : 0)
      : s.stage === 'MONTH_1' ? pct(a.pos.today || a.pos.passed, s.lengths.month1) : s.stage === 'RAMP' ? (s.rampOver ? 100 : pct(s.rampWeek, s.rampWeeks)) : 100;
    stage = { label: st.label, detail: st.detail, steps: order.map((k, i) => (i < at ? 100 : i === at ? within : 0)) };
  }
  const signs = a.signOffs.map((x) => ({ system: x.system, state: x.done ? 'done' : x.waiting ? 'waiting' : x.daysLate ? 'late' : 'open' }));
  const count = (k) => signs.filter((x) => x.state === k).length;
  const signMeta = !signs.length ? 'None in the plan' : [`${count('done')} of ${signs.length}`, count('waiting') ? `${count('waiting')} waiting` : '', count('late') ? `${count('late')} late` : ''].filter(Boolean).join(' · ');
  const target = a.callsTarget || 0;
  return {
    who: `${a.travel ? 'Travel Agent' : 'Flight Expert'} · ${isAdmin ? (a.supervisor ? a.supervisor.fullName + (a.cover && a.cover.absent ? `, ${a.cover.reason === 'LEAVE' ? 'on leave' : 'away'}` : '') : 'no supervisor') : `${s.started ? 'started' : 'starts'} ${shortDate(a.cal.startKey)}`}`,
    stage, signs, signMeta,
    seen: a.seenAt ? (ago(a.seenAt, now) === 'today' ? 'Seen today' : `Seen ${ago(a.seenAt, now)}`) : 'Not signed in yet',
    oneone: !a.pos.started ? `Starts ${shortDate(a.cal.startKey)}` : a.lastCheckIn ? `1:1 ${ago(a.lastCheckIn, now)}` : '1:1 not yet',
    dots: Array.from({ length: target }, (_, i) => i < a.callsToday),
    callsMeta: !a.pos.started ? 'Not started' : !a.pos.today ? 'Day off today' : target ? `${Math.min(a.callsToday, target)} of ${target} today` : 'No calls today',
  };
}

// "My day": the agent's own items, in the order they are best done
const DAY_ORDER = ['SETUP', 'CALLS', 'TRAINING', 'READ', 'AGENT_TASK'];
/** Where an item of the agent's own opens. */
function hrefOf(t, profileId) {
  if (t.kind === 'CALLS') return '/call-practice';
  if (t.kind === 'TRAINING' && t.courseId) return `/training-course/${t.courseId}`;
  if (t.kind === 'READ' && t.standardId) return `/standards/${t.standardId}`;
  if (t.kind === 'SETUP') return `/employees/${profileId}/setup`;
  return null;
}

/**
 * "My month" on My day: the weeks of Month 1 (and an extra week) with the agent's own items and what they do with their
 * supervisor - no daily check-ins, nothing of an admin's - each said for the agent. A finished week folds into one line;
 * this week is open. [{ number, name, range, note, isNow, isDone, done, total, percent, days: [{ label, isToday, items }] }]
 */
function monthOf(a, sup) {
  const who = sup ? firstName(sup.fullName) : 'your supervisor';
  const titles = plans.weekTitles(a.plan);
  const m1Weeks = Math.ceil(a.summary.lengths.month1 / plans.WEEK_DAYS);
  const theirs = a.tasks.filter((t) => !isPrestart(t) && !isDailyCheckIn(t) && t.owner !== 'ADMIN');
  const kindOf = (t) => (t.owner === 'AGENT' ? (t.kind === 'AGENT_TASK' ? 'Your task' : (plans.KINDS[t.kind] || {}).label || '') : t.kind === 'SIGN_OFF' ? `${who} watches you` : `with ${who}`);
  const whenOf = (t, state, key) => (state === 'DONE' ? `Done ${shortDate(dayKey(t.doneAt)).slice(4)}` : state === 'LATE' ? `${np.daysLate(t, a.pos)}d late`
    : state === 'TODAY' ? (t.kind === 'CALLS' ? `${Math.min(a.callsToday, t.target)} of ${t.target} today` : 'Today') : state === 'WAITING' ? 'Video coming' : state === 'CONFIRM' ? 'Waiting for an admin' : shortDate(key));
  return a.weeks.map((w) => {
    const first = (w.number - 1) * plans.WEEK_DAYS + 1; const last = w.number * plans.WEEK_DAYS;
    const isNow = a.pos.started && w.number === a.summary.week && a.pos.passed < a.summary.lengths.total;
    const open = theirs.filter((t) => t.day >= first && t.day <= last && !t.doneAt && t.kind !== 'CALLS' && np.stateOf(t, a.pos) !== 'WAITING').length;
    const isDone = a.pos.started && last <= a.pos.passed && !open;
    const fromKey = np.dateOfDay(a.cal, first); const toKey = np.dateOfDay(a.cal, Math.min(last, a.summary.lengths.total));
    const days = [];
    for (let d = first; d <= last; d += 1) {
      const key = np.dateOfDay(a.cal, d);
      const items = theirs.filter((t) => t.day === d).map((t) => { const state = np.stateOf(t, a.pos); return { id: t.id, title: t.title, kind: kindOf(t), state: state.toLowerCase(), when: whenOf(t, state, key) }; });
      if (items.length) days.push({ label: `Day ${d}${key ? ` · ${shortDate(key)}` : ''}${a.pos.today === d ? ' · today' : ''}`, isToday: a.pos.today === d, items });
    }
    return {
      number: w.number, name: w.number > m1Weeks ? 'Extra week' : `Week ${w.number}${titles[w.number - 1] ? ` · ${titles[w.number - 1]}` : ''}`,
      range: fromKey ? `${shortDate(fromKey)} – ${shortDate(toKey)}` : '', isNow, isDone, done: w.done, total: w.total, percent: w.percent,
      note: isDone ? 'done' : isNow ? (a.pos.today ? `day ${a.pos.today} today` : 'day off today') : last <= a.pos.passed ? 'not finished' : fromKey ? `starts ${shortDate(fromKey)}` : '', days,
    };
  });
}

/**
 * A new Travel Agent's "My day" (My Training): today's own items and anything still open from before, in one ordered
 * checklist with how much is done; who they see today; their numbers against the targets in the ramp. null for anyone
 * not on the path.
 */
async function myDayFor(profile, { now = new Date() } = {}) {
  if (!np.onTravelPath(profile)) return null;
  const program = await prisma.agentProgram.findUnique({ where: { profileId: profile.id }, select: { id: true, status: true } });
  if (!program || program.status === 'STOPPED') return null;
  const a = await agentState(program.id, profile, { now });
  const name = (person) => (person ? firstName(person.fullName) : 'your supervisor');
  const sup = a.ownerOf({ owner: 'SUPERVISOR' });
  // today's own items, and what is still open from before (a past day's calls cannot be done any more)
  const mine = a.tasks.filter((t) => t.owner === 'AGENT' && np.stateOf(t, a.pos) !== 'WAITING' && (t.day === a.pos.today || (!t.doneAt && t.kind !== 'CALLS' && np.stateOf(t, a.pos) === 'LATE')));
  const rank = (t) => (t.doneAt || t.day === a.pos.today ? 1 : 0); // what is still open from before comes first
  mine.sort((x, y) => rank(x) - rank(y) || np.daysLate(y, a.pos) - np.daysLate(x, a.pos) || DAY_ORDER.indexOf(x.kind) - DAY_ORDER.indexOf(y.kind));
  const rows = mine.map((t) => {
    const late = t.doneAt ? 0 : np.daysLate(t, a.pos);
    const when = late === 1 ? 'From yesterday' : late > 1 ? `${late} working days late` : '';
    const what = t.kind === 'CALLS' ? `${Math.min(a.callsToday, t.target)} of ${t.target} done` : t.kind === 'AGENT_TASK' ? `${name(sup)} confirms this` : (plans.KINDS[t.kind] || {}).label;
    return { id: t.id, title: t.title, done: Boolean(t.doneAt), late, href: t.doneAt ? null : hrefOf(t, profile.id), meta: [when, what].filter(Boolean).join(' · ') };
  });
  const withYou = a.tasks.filter((t) => t.owner === 'SUPERVISOR' && t.day === a.pos.today && !t.doneAt).map(shortTitle);
  const done = rows.filter((r) => r.done).length;
  const askers = [...new Set(a.tasks.map((t) => t.requestedById || t.doneById).filter(Boolean))];
  const names = new Map((askers.length ? await prisma.profile.findMany({ where: { id: { in: askers } }, select: { id: true, fullName: true } }) : []).map((p) => [p.id, p.fullName]));
  return {
    stage: stageText(a), summary: a.summary, rows, done, total: rows.length, percent: rows.length ? Math.round((done / rows.length) * 100) : 0,
    dayOff: a.pos.started && !a.pos.today, startKey: a.cal.startKey, supervisorName: sup ? sup.fullName : null, withYou: withYou.length ? `With ${name(sup)} today: ${listOf(withYou)}` : '',
    readiness: a.summary.stage === 'RAMP' || (!plans.SWITCHES.ramp && a.summary.stage === 'MONTH_1') ? a.readiness : null, approvedAt: a.program.approvedAt,
    checkKey: np.dateOfDay(a.cal, a.summary.lengths.month1), // the end of Month 1: the ready check
    checks: a.program.status === 'ACTIVE' ? checksOf(a, names, now) : [], answers: ANSWERS,
    month: monthOf(a, sup),
  };
}

// ---------------------------------------------------------------------------------------------- database

/** Everything the board and the agent page show about one program, brought up to date first. */
/** Is the supervisor away today? { absent, reason (NONE | DISABLED | LEAVE), text } - then the admins cover. */
async function coverOf(supervisor, todayKey) {
  if (!supervisor) return { absent: true, reason: 'NONE', text: 'No supervisor: admins cover' };
  const first = firstName(supervisor.fullName);
  if (supervisor.status !== 'ACTIVE') return { absent: true, reason: 'DISABLED', text: `Covering for ${first} (account disabled)` };
  if ((await np.leaveKeysFor(supervisor.id)).includes(todayKey)) return { absent: true, reason: 'LEAVE', text: `Covering for ${first} (on leave)` };
  return { absent: false, reason: null, text: '' };
}

/** The active admins, oldest first, and the one who covers for this agent: whoever hired them, while they are an admin. */
async function adminFor(profile) {
  const admins = await prisma.profile.findMany({ where: { organizationId: profile.organizationId, role: 'ADMIN', status: 'ACTIVE', testOwnerAdminId: null }, orderBy: { createdAt: 'asc' }, select: { id: true, fullName: true, status: true, role: true } });
  return admins.find((x) => x.id === profile.createdById) || admins[0] || null;
}

async function agentState(programId, viewer, { now = new Date() } = {}) {
  const state = await np.refresh(programId, { now });
  if (!state) return null;
  const profile = state.program.profile;
  const todayKey = dayKey(now);
  const readyCalls = state.plan ? plans.readyOf(state.plan).calls : 10;
  const [assignment, callsToday, report, recent, session] = await Promise.all([
    prisma.supervisorAssignment.findFirst({ where: { agentId: profile.id, unassignedAt: null }, select: { supervisor: { select: { id: true, fullName: true, status: true, role: true } } } }),
    prisma.practiceCallTranscript.count({ where: { profileId: profile.id, submittedAt: { gte: new Date(`${todayKey}T00:00:00+05:00`) } } }),
    require('./callPractice').reportFor(profile),
    prisma.practiceCallTranscript.findMany({ where: { profileId: profile.id, submittedAt: { not: null } }, orderBy: { submittedAt: 'desc' }, take: Math.max(readyCalls, 10), select: { accuracy: true, wordsPerMinute: true, submittedAt: true, typingSeconds: true } }),
    prisma.session.findFirst({ where: { profileId: profile.id }, orderBy: { lastUsedAt: 'desc' }, select: { lastUsedAt: true } }),
  ]);
  const supervisor = assignment ? assignment.supervisor : null;
  const viewerIsSupervisor = Boolean(supervisor && viewer && supervisor.id === viewer.id);
  const isAdmin = Boolean(viewer && viewer.role === 'ADMIN');
  // the new Travel Agent path only: Flight Experts keep their 4 weeks exactly as they were
  const travel = state.travel;
  const cover = travel ? await coverOf(supervisor, todayKey) : null;
  const admin = travel ? await adminFor(profile) : null;
  const readiness = travel && state.plan ? readinessOf(state, recent) : null;
  const idle = travel && state.program.status === 'ACTIVE' ? idleDaysOf(state, recent[0] ? recent[0].submittedAt : null, todayKey) : 0;
  const owners = { agent: profile, supervisor, cover, admin };
  const view = { ...state, profile, report, readiness, idle, isAdmin, supervisor, cover };
  const group = groupOf(view);
  const next = nextStepOf(view);
  const flags = flagsOf({ ...state, profile, supervisor });
  const waiting = state.tasks.filter(awaitsAdmin);
  // the second line under the next step: a flag (Admins), no activity, or a sign-off waiting for an admin
  const nextMeta = isAdmin && flags.length ? { text: flags[0].text + (flags.length > 1 ? ` · +${flags.length - 1} more` : ''), kind: 'flag' }
    : idle >= IDLE_DAYS ? { text: `No activity for ${idle} working days`, kind: 'warn' }
      : isAdmin && cover && cover.absent ? { text: cover.text, kind: '' }
        : !isAdmin && waiting.length && !next.lock ? { text: `${plural(waiting.length, 'sign-off')} waiting for an admin`, kind: '' } : null;
  const callsTask = state.pos.today ? state.tasks.find((t) => t.kind === 'CALLS' && t.day === state.pos.today) : null;
  return {
    ...state, profile, supervisor, viewerIsSupervisor, callsToday, report, cover, admin, readiness, idle, owners, ownerOf: (t) => ownerOf(t, owners),
    group, groupInfo: GROUPS[group], goingOn: goingOnOf(view), next, nextMeta, maxLate: maxLateOf(state.tasks, state.pos, travel),
    flags, waiting, recent, progress: progressOf(state, readiness), quality: qualityOf(recent, readyCalls), seenAt: session ? session.lastUsedAt : null, callsTarget: callsTask ? callsTask.target : 0,
    weeks: weeksOf(state.tasks, state.pos, state.summary.lengths.total), agentDay: agentDayOf(state.tasks, state.pos, callsToday),
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

/**
 * The board: one line per agent, in their groups (most urgent first), with a count per group for the filter chips.
 * An Admin may narrow it to one supervisor; anyone may narrow it to one group.
 */
async function boardFor(viewer, { supervisorId = '', group = '', now = new Date() } = {}) {
  const all = [];
  for (const p of await visiblePrograms(viewer)) { const a = await agentState(p.id, viewer, { now }); if (a) all.push(a); }
  const supervisors = [...new Map(all.filter((a) => a.supervisor).map((a) => [a.supervisor.id, a.supervisor])).values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
  const agents = (viewer.role === 'ADMIN' && supervisorId ? all.filter((a) => (supervisorId === 'none' ? !a.supervisor : a.supervisor && a.supervisor.id === supervisorId)) : all)
    .sort((a, b) => a.groupInfo.rank - b.groupInfo.rank || a.profile.fullName.localeCompare(b.profile.fullName));
  const counts = Object.fromEntries(Object.keys(GROUPS).map((k) => [k, agents.filter((a) => a.group === k).length]));
  const chosen = GROUPS[group] ? group : '';
  const groups = Object.keys(GROUPS).filter((k) => !chosen || k === chosen).map((k) => ({ key: k, info: GROUPS[k], agents: agents.filter((a) => a.group === k) })).filter((g) => g.agents.length);
  const tasks = supervisorTasksOf(agents);
  const isAdmin = viewer.role === 'ADMIN';
  return {
    agents, groups, counts, total: agents.length, group: chosen, supervisors, tasks, noSupervisor: all.filter((a) => !a.supervisor).length,
    cards: cardsOf(agents, isAdmin, tasks), scorecard: isAdmin ? scorecardOf(all, now) : [],
  };
}

const daysSince = (date, now) => Math.max(0, Math.round((new Date(`${dayKey(now)}T00:00:00Z`) - new Date(`${dayKey(date)}T00:00:00Z`)) / DAY_MS));
const isReady = (a) => Boolean(gateOpen(a.summary) && a.readiness && a.readiness.met);

/** The summary cards above the board, for this viewer (the agent counts are the board's own): [{ label, value, meta, href, link }] */
function cardsOf(agents, isAdmin, tasks) {
  const stages = [['PRE_START', 'pre-start'], ['MONTH_1', 'in month 1'], ['RAMP', plans.SWITCHES.ramp ? 'in the ramp' : 'past Month 1']].map(([k, w]) => { const n = agents.filter((a) => a.summary.stage === k).length; return n ? `${n} ${w}` : ''; });
  const experts = agents.filter((a) => !a.travel).length;
  const mix = [...stages, experts ? plural(experts, 'Flight Expert') : ''].filter(Boolean).join(' · ') || 'Nobody on the path';
  const scores = agents.filter((a) => a.quality).map((a) => a.quality.accuracy);
  const gate = agents.find((a) => a.readiness);
  const accuracy = { label: 'Call accuracy', value: scores.length ? `${Math.round(scores.reduce((n, x) => n + x, 0) / scores.length)}%` : '—', meta: `${isAdmin ? 'Average' : 'Your agents'}, last 10 calls · target ${gate ? gate.readiness.targets.accuracy : 90}%` };
  const confirms = agents.reduce((n, a) => n + a.waiting.length, 0);
  const ready = agents.filter(isReady).length;
  const named = (rows) => [...new Map(rows.map((r) => [r.agent.profile.id, r.agent.profile.fullName])).values()].join(', ');
  if (!isAdmin) {
    const lateBy = new Map(); for (const r of tasks.late) lateBy.set(r.agent.profile.fullName, (lateBy.get(r.agent.profile.fullName) || 0) + 1);
    return [
      { label: 'Your new agents', value: String(agents.length), meta: mix },
      { label: 'For you today', value: String(tasks.today.length), meta: tasks.today.length ? `About ${duration(tasks.minutes)} · ${named(tasks.today)}` : 'Nothing for today' },
      { label: 'Overdue', value: String(tasks.late.length), meta: tasks.late.length ? [...lateBy].map(([n, c]) => `${n} ${c}`).join(', ') : 'Nothing overdue' },
      { label: 'Waiting for an admin', value: String(confirms + ready), meta: [ready ? `${plural(ready, 'approval')}` : '', confirms ? plural(confirms, 'sign-off') : ''].filter(Boolean).join(' · ') || 'Nothing waiting' },
      accuracy,
    ];
  }
  const decisions = agents.filter((a) => a.travel && a.summary.rampOver && !isReady(a)).length;
  const waiting = ready + confirms + decisions;
  const late = agents.flatMap((a) => a.tasks.filter((t) => np.stateOf(t, a.pos) === 'LATE' && !isHistory(t, a.pos, a.travel)).map((t) => ({ id: a.profile.id, days: np.daysLate(t, a.pos) })));
  const flags = agents.reduce((n, a) => n + a.flags.length, 0);
  return [
    { label: 'New agents', value: String(agents.length), meta: mix },
    { label: 'Waiting for you', value: String(waiting), meta: [ready ? plural(ready, 'approval') : '', confirms ? plural(confirms, 'sign-off') : '', decisions ? plural(decisions, plans.SWITCHES.ramp ? 'ramp decision' : 'end-of-month decision') : ''].filter(Boolean).join(' · ') || 'Nothing to approve or confirm', href: waiting ? '/new-agents/approvals' : '', link: 'Open approvals' },
    { label: 'Overdue items', value: String(late.length), meta: late.length ? `Across ${plural(new Set(late.map((x) => x.id)).size, 'agent')} · oldest ${plural(Math.max(...late.map((x) => x.days)), 'working day')}` : 'Nothing overdue' },
    accuracy,
    { label: 'Flags', value: String(flags), meta: flags ? 'Ticks to check before you confirm' : 'Nothing looks wrong', href: flags ? '/new-agents/approvals#flags' : '', link: 'See flags' },
  ];
}

/** For Admins: how each supervisor keeps up with their new agents, one row each (and one for agents with none). */
function scorecardOf(states, now) {
  const by = new Map();
  for (const a of states) { const k = a.supervisor ? a.supervisor.id : ''; by.set(k, [...(by.get(k) || []), a]); }
  return [...by.entries()].map(([id, list]) => {
    const sup = list[0].supervisor;
    const late = list.flatMap((a) => a.tasks.filter((t) => needsSupervisor(t) && np.stateOf(t, a.pos) === 'LATE').map((t) => np.daysLate(t, a.pos)));
    const gaps = list.filter((a) => a.pos.started).map((a) => ({ a, days: daysSince(a.lastCheckIn || new Date(`${a.cal.startKey}T12:00:00Z`), now) })).sort((x, y) => y.days - x.days);
    const away = list.find((a) => a.cover && a.cover.absent);
    const note = !sup ? 'Admins cover' : away ? `${away.cover.reason === 'LEAVE' ? 'On leave' : 'Account disabled'} · admins cover` : 'Supervisor';
    return {
      id, name: sup ? sup.fullName : 'No supervisor', note, hue: hueOf(id || 'none'), initials: initials(sup ? sup.fullName : '?'), agents: list.length,
      overdue: late.length, mostLate: late.length ? `${Math.max(...late)}d` : '—', gap: !gaps.length ? '—' : gaps[0].days ? `${gaps[0].days}d (${gaps[0].a.profile.fullName})` : 'Today',
      onPace: `${list.filter((a) => !['URGENT', 'BEHIND'].includes(a.group)).length} of ${list.length}`, flags: list.reduce((n, a) => n + a.flags.length, 0),
    };
  }).sort((a, b) => Number(!a.id) - Number(!b.id) || a.name.localeCompare(b.name));
}

/**
 * An Admin's "Waiting for you": new Travel Agents to approve (with their supervisor's final review and how their last
 * calls were typed), the sign-offs to confirm, the end-of-ramp decisions, and the flags.
 */
async function approvalsFor(viewer, { now = new Date() } = {}) {
  const states = [];
  for (const p of await visiblePrograms(viewer)) { const a = await agentState(p.id, viewer, { now }); if (a && a.travel) states.push(a); }
  const ids = [...new Set(states.flatMap((a) => a.tasks.flatMap((t) => [t.requestedById, t.doneById]).filter(Boolean)))];
  const names = new Map((ids.length ? await prisma.profile.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } }) : []).map((p) => [p.id, p.fullName]));
  const finalReview = (a) => a.tasks.filter((t) => t.kind === 'REVIEW' && t.doneAt && !isPrestart(t) && t.day <= a.summary.lengths.month1).sort((x, y) => y.day - x.day)[0] || null;
  const typing = (a) => {
    const rows = a.recent.slice(0, a.readiness.targets.calls);
    if (!rows.length) return '';
    const mins = rows.filter((r) => r.typingSeconds).map((r) => Math.max(1, Math.round(r.typingSeconds / 60)));
    const span = !mins.length ? '' : Math.min(...mins) === Math.max(...mins) ? `, about ${plural(mins[0], 'minute')} of typing each` : `, ${Math.min(...mins)} to ${Math.max(...mins)} minutes of typing each`;
    return `Last ${plural(rows.length, 'call')} over ${plural(new Set(rows.map((r) => dayKey(r.submittedAt))).size, 'day')}${span}.`;
  };
  const byName = (x, y) => x.profile.fullName.localeCompare(y.profile.fullName);
  const ready = states.filter(isReady).sort(byName).map((a) => ({ a, review: finalReview(a), typing: typing(a) }));
  const decisions = states.filter((a) => a.summary.rampOver && !isReady(a)).sort(byName);
  const confirms = states.flatMap((a) => a.waiting.map((task) => ({ a, task, flags: a.flags.filter((f) => f.task.id === task.id) }))).sort((x, y) => x.task.requestedAt - y.task.requestedAt);
  const flags = states.flatMap((a) => a.flags.map((f) => ({ a, ...f }))).sort((x, y) => y.at - x.at);
  return { ready, decisions, confirms, flags, names, total: ready.length + decisions.length + confirms.length };
}

/**
 * The daily check that every new Travel Agent is accounted for: hired in the last TRACK_DAYS days (or starting later)
 * and not on the path at all, or on it with nobody to supervise them (no supervisor, or one whose account is disabled).
 * The admins cover in the meantime; this says what to fix. [{ profile, reason, action, href }]
 */
async function untrackedHires(organizationId, states, { now = new Date(), where = { testOwnerAdminId: null } } = {}) {
  const hires = await prisma.profile.findMany({ where: { organizationId, role: 'TRAVEL_AGENT', status: { in: np.LIVE_STATUSES }, archivedAt: null, employmentStartDate: { gte: new Date(now.getTime() - TRACK_DAYS * DAY_MS) }, agentProgram: null, ...where }, orderBy: { fullName: 'asc' }, select: { id: true, fullName: true, role: true, employmentStartDate: true } });
  const out = hires.map((p) => ({ profile: p, reason: 'Not in the New Agent Program', action: 'Start it', href: '/admin/new-agent-program#start' }));
  for (const s of states) {
    if (!s.travel || !s.cover || !['NONE', 'DISABLED'].includes(s.cover.reason)) continue;
    out.push({ profile: s.profile, reason: s.cover.reason === 'NONE' ? 'No supervisor' : `Supervisor ${s.supervisor.fullName} is disabled`, action: 'Assign supervisor', href: `/admin/employees/${s.profile.id}` });
  }
  return out;
}

/** For the dashboard's "Needs your attention": supervisor items late and for today, and agents without a supervisor. */
async function attentionCounts(viewer, { now = new Date() } = {}) {
  const out = { late: 0, today: 0, noSupervisor: 0 };
  for (const { id } of await visiblePrograms(viewer)) {
    const program = await prisma.agentProgram.findUnique({ where: { id }, include: { tasks: { where: { doneAt: null } } } });
    const pos = np.placeOf(np.calendarOf(program, await np.leaveKeysFor(program.profileId)), dayKey(now));
    for (const t of program.tasks.filter((x) => needsSupervisor(x) || (viewer.role === 'ADMIN' && (x.owner === 'ADMIN' || awaitsAdmin(x))))) {
      const state = np.stateOf(t, pos);
      if (state === 'LATE') out.late += 1; else if (state === 'TODAY' || state === 'CONFIRM') out.today += 1;
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

const isRampReview = (t) => String(t.key || '').startsWith('ramp-review:'); // "Extend a week" there adds a ramp week
const audit = (actor, program, action, metadata) => logAudit({ organizationId: program.organizationId, actorId: actor.id, action, targetTable: 'AgentProgram', targetId: program.id, metadata: { employeeId: program.profileId, ...metadata } });

/**
 * The supervisor (or an Admin) ticks an item: done, a sign-off, a check-in, a review (with a verdict; "Extend a week"
 * adds 5 working days). Returns an error message, or null.
 */
async function completeTask(actor, program, task, { note = '', verdict = '' } = {}) {
  if (!MANUAL.includes(task.kind)) return 'This item ticks itself when it is done.';
  if (task.owner === 'ADMIN' && actor.role !== 'ADMIN') return 'An admin ticks this.';
  if (task.doneAt) return null; // a second tap changes nothing
  if (task.requestedAt) return actor.role === 'ADMIN' ? confirmSignOff(actor, program, task) : null;
  const text = String(note || '').trim().slice(0, 1000);
  if (task.kind === 'SIGN_OFF' && actor.role !== 'ADMIN' && await travelOf(program)) return requestSignOff(actor, program, task, text);
  if (task.kind === 'REVIEW' && !VERDICTS[verdict]) return 'Choose how the week went.';
  if (task.kind === 'REVIEW' && text.length < 2) return 'Write a line about the week.';
  const saved = await prisma.agentProgramTask.updateMany({ where: { id: task.id, doneAt: null }, data: { doneAt: new Date(), doneById: actor.id, note: text || null, resultJson: task.kind === 'REVIEW' ? JSON.stringify({ verdict }) : null } });
  if (saved.count && verdict === 'EXTEND') await prisma.agentProgram.update({ where: { id: program.id }, data: isRampReview(task) ? { rampExtraDays: { increment: EXTEND_DAYS } } : { extraDays: { increment: EXTEND_DAYS } } });
  if (saved.count) await audit(actor, program, task.kind === 'SIGN_OFF' ? 'program.signed_off' : 'program.task_done', { taskId: task.id, kind: task.kind, title: task.title, verdict: verdict || undefined });
  return null;
}

/** Takes back an item a person ticked by mistake (and the extra week a review asked for). */
async function undoTask(actor, program, task) {
  if (!task.doneAt || !task.doneById) return 'Only an item somebody ticked can be taken back.';
  if (task.owner === 'ADMIN' && actor.role !== 'ADMIN') return 'An admin takes this back.';
  if (actor.role !== 'ADMIN' && await travelOf(program)) return 'Only an admin takes a tick back.';
  let verdict = null; try { verdict = JSON.parse(task.resultJson || '{}').verdict; } catch { /* none */ }
  await prisma.agentProgramTask.update({ where: { id: task.id }, data: { doneAt: null, doneById: null, note: null, resultJson: null, ...UNASKED } });
  if (verdict === 'EXTEND') await prisma.agentProgram.update({ where: { id: program.id }, data: isRampReview(task) ? { rampExtraDays: Math.max(0, program.rampExtraDays - EXTEND_DAYS) } : { extraDays: Math.max(0, program.extraDays - EXTEND_DAYS) } });
  await audit(actor, program, 'program.task_undone', { taskId: task.id, title: task.title });
  return null;
}

/** The "Ready for solo live calls" certificate of the organization (made once; never issued by the automation). */
async function readyDefinition(organizationId, actorId) {
  const found = await prisma.certificationDefinition.findFirst({ where: { organizationId, kind: 'PROGRAM' }, orderBy: { createdAt: 'asc' } });
  if (found) return found;
  return prisma.certificationDefinition.create({ data: { organizationId, name: 'Ready for solo live calls', kind: 'PROGRAM', roleKey: 'TRAVEL_AGENT', description: 'Approved at the end of the New Agent Program ramp.', requirementsJson: JSON.stringify({ noOutstandingRetakes: false }), createdById: actorId } });
}

/**
 * Approves a Travel Agent in their ramp for solo live calls: when every criterion is met (their supervisor or an Admin),
 * or "anyway" with a written reason (an Admin). Issues the certificate and closes the program. Returns an error or null.
 */
async function approve(actor, state, { anyway = false, reason = '' } = {}) {
  const program = state.program;
  if (!state.travel || program.status !== 'ACTIVE' || !gateOpen(state.summary)) return plans.SWITCHES.ramp ? 'Only a Travel Agent in their ramp can be approved.' : 'Only a Travel Agent at the end of Month 1 can be approved.';
  if (actor.role !== 'ADMIN') return 'Only an admin approves for solo live calls.';
  const text = String(reason || '').trim().slice(0, 1000);
  if (anyway && actor.role !== 'ADMIN') return 'Only an admin can approve before every criterion is met.';
  if (anyway && !plans.SWITCHES.ramp && state.summary.stage !== 'RAMP') return 'Approve anyway is for after Month 1.';
  if (anyway && text.length < 5) return 'Write why they are ready anyway.';
  if (!anyway && !state.readiness.met) return 'Not every criterion is met yet.';
  const now = new Date();
  const saved = await prisma.agentProgram.updateMany({ where: { id: program.id, status: 'ACTIVE' }, data: { status: 'COMPLETED', approvedAt: now, approvedById: actor.id } });
  if (!saved.count) return null; // a second tap changes nothing
  const def = await readyDefinition(program.organizationId, actor.id);
  const earned = await prisma.earnedCertification.create({ data: { definitionId: def.id, profileId: program.profileId, issuedAt: now, issuedById: actor.id, snapshotJson: JSON.stringify({ issuedFor: def.name, engine: 'new-agent-program', approvedAnyway: anyway, reason: text || null, checks: state.readiness.checks }) } });
  await audit(actor, program, 'program.approved', { anyway, reason: text || undefined, certificationId: earned.id, met: state.readiness.metCount });
  await notifyOnce(program.profileId, `program-approved:${program.id}`, { type: 'program.approved', title: 'Ready for solo live calls', body: 'You are approved for solo live calls. Well done.', link: '/training' });
  return null;
}

/** "Not yet" on a Travel Agent who meets every criterion (an Admin): a note on their page, and their supervisor is told. */
async function notYet(actor, state, reason) {
  if (actor.role !== 'ADMIN') return 'Only an admin decides this.';
  const text = String(reason || '').trim().slice(0, 1000);
  if (text.length < 5) return 'Write what is missing.';
  const error = await addNote(actor, state.program, `Not ready for solo live calls yet: ${text}`);
  if (error) return error;
  await audit(actor, state.program, 'program.not_yet', { reason: text });
  if (state.supervisor) await notifyOnce(state.supervisor.id, `program-not-yet:${state.program.id}:${Date.now()}`, { type: 'program.not_yet', title: `Not ready yet: ${state.profile.fullName}`, body: `${firstName(actor.fullName)}: ${text}`, link: `/new-agents/${state.profile.id}#notes` });
  return null;
}

/** The end-of-ramp (ramp off: end of Month 1) decision "Extend" (an Admin): one more week of calls and a review, from today. */
async function extendRamp(actor, state) {
  if (actor.role !== 'ADMIN') return 'Only an admin can extend the ramp.';
  if (!state.travel || state.program.status !== 'ACTIVE' || state.summary.stage !== 'RAMP') return plans.SWITCHES.ramp ? 'Only a Travel Agent in their ramp can have it extended.' : 'Only a Travel Agent past Month 1 can have an extra week.';
  const { total } = state.summary.lengths;
  const add = Math.max(total, np.horizonOf(state.pos)) + EXTEND_DAYS - total;
  await prisma.agentProgram.update({ where: { id: state.program.id }, data: { rampExtraDays: { increment: add } } });
  await audit(actor, state.program, 'program.ramp_extended', { days: add });
  return null;
}

// ---------------------------------------------------------------------------------------------- admin checks

const UNASKED = { requestedAt: null, requestedById: null, agentAnswer: null, agentAnsweredAt: null, flagClearedAt: null, flagClearedById: null };
/** Is the program a new Travel Agent's (the admin checks are for them only)? */
async function travelOf(program) { return np.onTravelPath(await prisma.profile.findUnique({ where: { id: program.profileId }, select: { role: true } })); }

/** A supervisor's sign-off of a new Travel Agent: it waits for an admin to confirm it, with what they saw. */
async function requestSignOff(actor, program, task, text) {
  if (text.length < 5) return 'Write what you watched them do on their own.';
  const at = new Date();
  const saved = await prisma.agentProgramTask.updateMany({ where: { id: task.id, doneAt: null, requestedAt: null }, data: { requestedAt: at, requestedById: actor.id, note: text } });
  if (!saved.count) return null;
  await audit(actor, program, 'program.signoff_requested', { taskId: task.id, title: task.title });
  const profile = await prisma.profile.findUnique({ where: { id: program.profileId }, select: { id: true, fullName: true, organizationId: true, createdById: true } });
  const admin = await adminFor(profile);
  if (admin) await notifyOnce(admin.id, `program-confirm:${task.id}:${at.getTime()}`, { type: 'program.confirm', title: `Confirm a sign-off: ${profile.fullName}`, body: `${actor.fullName} signed off ${task.system || task.title} and asks you to confirm it.`, link: `/new-agents/approvals#task-${task.id}` });
  return null;
}

/** An Admin confirms a sign-off the supervisor asked for: from now on it counts. */
async function confirmSignOff(actor, program, task) {
  if (actor.role !== 'ADMIN') return 'Only an admin confirms a sign-off.';
  if (!task.requestedAt || task.doneAt) return null;
  const saved = await prisma.agentProgramTask.updateMany({ where: { id: task.id, doneAt: null, requestedAt: { not: null } }, data: { doneAt: new Date(), doneById: actor.id } });
  if (saved.count) await audit(actor, program, 'program.signed_off', { taskId: task.id, kind: task.kind, title: task.title, confirmed: true, requestedById: task.requestedById });
  return null;
}

/** An Admin sends a sign-off back: it is the supervisor's to do again, and they are told why. */
async function sendBack(actor, program, task, reason) {
  if (actor.role !== 'ADMIN') return 'Only an admin sends a sign-off back.';
  const text = String(reason || '').trim().slice(0, 1000);
  if (text.length < 2) return 'Write what they should do again.';
  if (!task.requestedAt || task.doneAt) return null;
  const saved = await prisma.agentProgramTask.updateMany({ where: { id: task.id, doneAt: null, requestedAt: task.requestedAt }, data: { ...UNASKED, note: null } });
  if (!saved.count) return null;
  await audit(actor, program, 'program.signoff_sent_back', { taskId: task.id, title: task.title, reason: text });
  await notifyOnce(task.requestedById, `program-sent-back:${task.id}:${new Date(task.requestedAt).getTime()}`, { type: 'program.sent_back', title: `Sign-off sent back: ${task.system || task.title}`, body: `${firstName(actor.fullName)}: ${text}`, link: `/new-agents/${program.profileId}#task-${task.id}` });
  return null;
}

/** An Admin looked at a flag and lets it be: it is not shown again. */
async function clearFlag(actor, program, task) {
  if (actor.role !== 'ADMIN') return 'Only an admin decides about a flag.';
  await prisma.agentProgramTask.update({ where: { id: task.id }, data: { flagClearedAt: new Date(), flagClearedById: actor.id } });
  await audit(actor, program, 'program.flag_cleared', { taskId: task.id, title: task.title });
  return null;
}

/** A new Travel Agent answers "did this happen?" about an item someone else ticked. "No" goes to an admin. */
async function answerCheck(profile, taskId, answer) {
  if (!ANSWERS[answer]) return 'Choose an answer.';
  const program = np.onTravelPath(profile) ? await prisma.agentProgram.findUnique({ where: { profileId: profile.id } }) : null;
  if (!program || program.status !== 'ACTIVE') return 'This question is closed.';
  const saved = await prisma.agentProgramTask.updateMany({ where: { id: String(taskId), programId: program.id, kind: { in: ASKED }, agentAnswer: null }, data: { agentAnswer: answer, agentAnsweredAt: new Date() } });
  if (!saved.count) return null;
  await audit(profile, program, 'program.agent_answered', { taskId, answer });
  if (answer === 'NO') {
    const task = await prisma.agentProgramTask.findUnique({ where: { id: String(taskId) }, select: { title: true } });
    const admin = await adminFor(profile);
    if (admin) await notifyOnce(admin.id, `program-said-no:${taskId}`, { type: 'program.flag', title: `${profile.fullName} says something did not happen`, body: task ? task.title : '', link: '/new-agents/approvals#flags' });
  }
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
  GROUPS, VERDICTS, MANUAL, URGENT_DAYS, EXTEND_DAYS,
  IDLE_DAYS, TRACK_DAYS,
  shortDate, ago, hueOf, initials, firstName, needsSupervisor, isDailyCheckIn, isPrestart, isHistory, groupMeaning, groupOf, shortTitle, goingOnOf, nextStepOf, maxLateOf, weeksOf, agentDayOf, signOffsOf, lastCheckInOf, supervisorTasksOf, duration,
  ownerOf, readinessOf, idleDaysOf, stageText, myDayFor,
  coverOf, adminFor, agentState, visiblePrograms, boardFor, untrackedHires, attentionCounts, notesFor, completeTask, undoTask, extend, readyDefinition, approve, extendRamp, setWorkDays, setDayOff, addNote,
  ASKED, ANSWERS, BURST, awaitsAdmin, gateOpen, moreTime, monthOf, cellsOf, progressOf, qualityOf, flagsOf, checksOf, cardsOf, scorecardOf, approvalsFor, isReady,
  requestSignOff, confirmSignOff, sendBack, clearFlag, answerCheck, notYet,
};
