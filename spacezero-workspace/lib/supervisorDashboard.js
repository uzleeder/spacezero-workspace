'use strict';

// The Supervisor dashboard ("at a glance", approved 2026-11-04): only what this supervisor has to do, and how each
// person on their team is.
//   Your team   one face per person, a coloured ring (needs you / behind / on track / away) and a 2-word tag
//   Your list   short tiles in Late / Today / This week: an icon, 2 or 3 words, the face, one chip (how late / how long)
// Everything is counted live, per request, from the same functions the linked pages use (the new agents board, setup,
// training, vacation, suggested refreshers). Nothing is stored. Only the supervisor's own team is ever read.
const { prisma } = require('./prisma');
const board = require('./newAgentBoard');
const reminders = require('./newAgentReminders');
const np = require('./newAgentProgram');
const { scopedProfiles } = require('./attention');
const { loadSetupForProfiles } = require('./employeeSetup');
const { loadLearning } = require('./teamIntel');
const { visibleLeaveWhere } = require('./leave');
const { ackSummaryForProfiles } = require('./standards');
const { hasCapability, setupLinkFor } = require('./supervisorCapabilities');
const { getSetting } = require('./orgSettings');
const { dayKey } = require('./callPractice');

const DAY_MS = 86400000;
const SOON_DAYS = 7; // the supervisor's own training shows a week before it is due
const SHOWN = 6; // tiles per column; the rest are one click away
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const face = (p) => ({ name: p.fullName, initials: board.initials(p.fullName), hue: board.hueOf(p.id) });
const first = (name) => name.split(' ')[0];
const ICON = { CHECK_IN: 'chat', DEMO: 'demo', SIGN_OFF: 'sign', REVIEW: 'review', SCHEDULE: 'calendar', SUPERVISOR_TASK: 'check' };
const LATE_TAG = { CHECK_IN: 'Check-in late', DEMO: 'Demo late', SIGN_OFF: 'Sign-off late', REVIEW: 'Review late', SCHEDULE: 'Days not set', SUPERVISOR_TASK: 'Task late' };
const weekdayOf = (date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', weekday: 'short' }).format(date);

/** A tile: lane (late / today / week), an icon, 2 or 3 words, the faces, one chip; detail is the full sentence on hover. */
const tile = (key, lane, { icon, label, people = [], chip, detail = '', href, minutes = 0 }) => ({ key, lane, icon, label, faces: people.slice(0, 3).map(face), more: Math.max(0, people.length - 3), chip, detail, href, minutes });

/** Sign-offs an admin sent back, still not done: taskId -> the admin's reason. */
async function sentBackOf(organizationId, taskIds, now) {
  if (!taskIds.length) return new Map();
  const rows = await prisma.auditLog.findMany({ where: { organizationId, action: 'program.signoff_sent_back', createdAt: { gte: new Date(now.getTime() - 60 * DAY_MS) } }, orderBy: { createdAt: 'asc' }, select: { metadataJson: true } });
  const out = new Map();
  for (const r of rows) {
    let m = {}; try { m = JSON.parse(r.metadataJson || '{}'); } catch { /* not ours */ }
    if (taskIds.includes(m.taskId)) out.set(m.taskId, m.reason || '');
  }
  return out;
}

/** The new-agent items only this supervisor can do, late or for today. */
async function programTiles(actor, states, now) {
  const { late, today } = board.supervisorTasksOf(states);
  const back = await sentBackOf(actor.organizationId, [...late, ...today].filter((r) => r.task.kind === 'SIGN_OFF').map((r) => r.task.id), now);
  const tiles = [];
  for (const [lane, rows] of [['late', late], ['today', today]]) {
    // every daily check-in in one tile, one face per agent
    const checkIns = rows.filter((r) => r.task.kind === 'CHECK_IN');
    if (checkIns.length) {
      const people = [...new Map(checkIns.map((r) => [r.agent.profile.id, r.agent.profile])).values()];
      const minutes = checkIns.reduce((n, r) => n + (r.task.minutes || 0), 0);
      const most = Math.max(...checkIns.map((r) => r.daysLate));
      tiles.push(tile(`${lane}:checkin`, lane, {
        icon: 'chat', label: people.length === 1 ? 'Check-in' : 'Check-ins', people,
        chip: lane === 'late' ? `${plural(most, 'day')} late` : `${minutes || 5 * people.length} min`, minutes,
        detail: `Daily check-in with ${people.map((p) => p.fullName).join(', ')}`, href: people.length === 1 ? `/new-agents/${people[0].id}` : '/new-agents',
      }));
    }
    const others = rows.filter((x) => x.task.kind !== 'CHECK_IN');
    // late: one tile per agent, so a long absence does not bury the page ("4 items, 9 days late")
    if (lane === 'late') {
      const byAgent = new Map();
      for (const r of others) byAgent.set(r.agent.profile.id, [...(byAgent.get(r.agent.profile.id) || []), r]);
      for (const [id, list] of byAgent) {
        if (list.length === 1) continue;
        const p = list[0].agent.profile;
        tiles.push(tile(`late:${id}`, lane, {
          icon: 'review', label: `${list.length} items`, people: [p], chip: `${plural(Math.max(...list.map((r) => r.daysLate)), 'day')} late`,
          detail: `For ${p.fullName}: ${list.map((r) => board.shortTitle(r.task)).join(', ')}`, href: `/new-agents/${id}`,
        }));
      }
    }
    for (const r of others.filter((x) => lane !== 'late' || others.filter((y) => y.agent.profile.id === x.agent.profile.id).length === 1)) {
      const t = r.task; const p = r.agent.profile;
      const sent = back.has(t.id);
      tiles.push(tile(`task:${t.id}`, lane, {
        icon: sent ? 'redo' : ICON[t.kind] || 'check', label: sent ? `Redo ${board.shortTitle(t)}` : board.shortTitle(t), people: [p],
        chip: lane === 'late' ? `${plural(r.daysLate, 'day')} late` : sent ? 'Sent back' : t.minutes ? `${t.minutes} min` : 'Today', minutes: lane === 'today' ? t.minutes || 0 : 0,
        detail: `${t.title} for ${p.fullName}.${sent ? ` Sent back: "${back.get(t.id)}"` : ''}${lane === 'late' && r.daysLate >= reminders.ESCALATE_DAYS ? ' Your admin has been told.' : ''}`,
        href: `/new-agents/${p.id}#task-${t.id}`,
      }));
    }
  }
  return tiles;
}

/** Setup on the team: what this supervisor owns and is overdue, an "I don't have" access problem, items to verify. */
async function setupTiles(actor, { active, setups }) {
  const tiles = [];
  const canVerify = await hasCapability(actor, 'setup.verify');
  for (const p of active) {
    const s = setups.get(p.id);
    const href = await setupLinkFor(actor.id, p.id);
    for (const r of s.rows.filter((x) => x.counts && x.status === 'ISSUE')) tiles.push(tile(`issue:${p.id}:${r.requirement.id}`, 'late', { icon: 'lock', label: r.requirement.label, people: [p], chip: 'No access', detail: `${p.fullName} marked "I don't have" for ${r.requirement.label}`, href }));
    for (const r of s.overdueRows.filter((x) => x.ownerRole === 'SUPERVISOR' && x.status !== 'ISSUE')) {
      const days = Math.max(1, Math.floor((Date.now() - r.dueAt) / DAY_MS));
      tiles.push(tile(`setup:${p.id}:${r.requirement.id}`, 'late', { icon: 'lock', label: r.requirement.label, people: [p], chip: `${plural(days, 'day')} late`, detail: `A setup item you own for ${p.fullName}`, href }));
    }
    if (canVerify) for (const r of s.rows.filter((x) => x.awaitingVerification && x.status !== 'COMPLETED')) tiles.push(tile(`verify:${p.id}:${r.requirement.id}`, 'week', { icon: 'shield', label: `Verify ${r.requirement.label}`, people: [p], chip: 'To verify', detail: `${p.fullName} confirmed it; it counts once you verify it`, href }));
  }
  return tiles;
}

/** This week: vacation to recommend (or decide), suggested refreshers, the supervisor's own training. */
async function weekTiles(actor, { active, now }) {
  const tiles = [];
  const decides = await getSetting(actor.organizationId, 'leave.supervisorFinalApproval');
  const leave = await prisma.leaveRequest.findMany({ where: { ...(await visibleLeaveWhere(actor)), status: 'PENDING', ...(decides ? {} : { recommendation: 'NONE' }) }, orderBy: { startDate: 'asc' }, select: { id: true, startDate: true, endDate: true, profile: { select: { id: true, fullName: true } } } });
  const when = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', day: 'numeric', month: 'short' }).format(d);
  for (const l of leave) tiles.push(tile(`leave:${l.id}`, 'week', { icon: 'sun', label: 'Vacation', people: [l.profile], chip: decides ? 'Decide' : 'Recommend', detail: `${l.profile.fullName}, ${when(l.startDate)} to ${when(l.endDate)}`, href: `/leave/${l.id}` }));

  const ids = active.map((p) => p.id);
  const recs = ids.length ? await prisma.developmentRecommendation.findMany({ where: { organizationId: actor.organizationId, profileId: { in: ids }, status: 'OPEN', courseId: { not: null } }, orderBy: { priority: 'desc' }, select: { id: true, profileId: true, title: true, reason: true } }) : [];
  const byId = new Map(active.map((p) => [p.id, p]));
  for (const r of recs) tiles.push(tile(`rec:${r.id}`, 'week', { icon: 'refresh', label: 'Refresher', people: [byId.get(r.profileId)].filter(Boolean), chip: 'Suggested', detail: `${r.title}${r.reason ? `. ${r.reason}` : ''}`, href: '/team-skills' }));

  for (const l of (await loadLearning([actor.id], now)).filter((x) => x.status !== 'COMPLETED' && x.due)) {
    const days = (l.due - now) / DAY_MS;
    if (l.overdue) tiles.push(tile(`mine:${l.course.id}`, 'late', { icon: 'book', label: 'Your training', chip: 'Overdue', detail: `"${l.course.title}"`, href: '/training' }));
    else if (days <= SOON_DAYS) tiles.push(tile(`mine:${l.course.id}`, 'week', { icon: 'book', label: 'Your training', chip: `Due ${weekdayOf(l.due)}`, detail: `"${l.course.title}"`, href: '/training' }));
  }
  return tiles;
}

/** One face per person: how they are (need / behind / ok / away) and a 2-word tag. Who needs you first. */
async function teamOf(actor, { active, states, setups, learning, now }) {
  const byProfile = new Map(states.map((s) => [s.profile.id, s]));
  const today = dayKey(now);
  const late = new Map();
  for (const r of board.supervisorTasksOf(states).late) if (!late.has(r.agent.profile.id)) late.set(r.agent.profile.id, r.task);
  const overdue = new Map(); const retake = new Set();
  for (const l of learning) {
    if (l.overdue && l.course && l.course.mandatory) overdue.set(l.profileId, (overdue.get(l.profileId) || 0) + 1);
    if (l.retake) retake.add(l.profileId);
  }
  const ids = active.map((p) => p.id);
  const slipping = new Set(ids.length ? (await prisma.developmentRecommendation.findMany({ where: { organizationId: actor.organizationId, profileId: { in: ids }, source: 'RETENTION', status: 'OPEN' }, select: { profileId: true } })).map((r) => r.profileId) : []);
  const acks = ids.length ? await ackSummaryForProfiles(actor.organizationId, active) : new Map();

  const rows = [];
  for (const p of active) {
    const s = byProfile.get(p.id) || null;
    const setup = setups.get(p.id);
    const away = (await np.leaveKeysFor(p.id)).includes(today);
    let status = 'ok'; let tag = '';
    const issue = setup.rows.find((r) => r.counts && r.status === 'ISSUE');
    const mineLate = setup.overdueRows.find((r) => r.ownerRole === 'SUPERVISOR');
    const ownLate = s ? s.tasks.filter((t) => t.owner === 'AGENT' && np.stateOf(t, s.pos) === 'LATE' && !board.isHistory(t, s.pos, s.travel)) : [];
    const behindDays = ownLate.length ? Math.max(...ownLate.map((t) => np.daysLate(t, s.pos))) : 0;
    const streak = s && s.travel ? await reminders.lowStreak(p.id) : null;
    if (away) { status = 'away'; tag = 'Away'; } else if (late.has(p.id)) { status = 'need'; tag = LATE_TAG[late.get(p.id).kind] || 'Item late'; } else if (issue) { status = 'need'; tag = `No ${issue.requirement.label}`; } else if (mineLate) { status = 'need'; tag = 'Setup late'; } else if (behindDays) { status = 'behind'; tag = `${plural(behindDays, 'day')} behind`; } else if (streak) { status = 'behind'; tag = 'Low calls'; } else if (overdue.get(p.id)) { status = 'behind'; tag = `${overdue.get(p.id)} overdue`; } else if (retake.has(p.id)) { status = 'behind'; tag = 'Retake'; } else if (slipping.has(p.id)) { status = 'behind'; tag = 'Skill slipping'; } else if ((acks.get(p.id) || {}).pending) { status = 'behind'; tag = 'Read standards'; } else if (s && s.program.status === 'ACTIVE') { tag = s.pos.started ? `Day ${s.pos.today || s.pos.passed}` : `Starts ${board.shortDate(s.cal.startKey)}`; }
    rows.push({ person: p, face: face(p), first: first(p.fullName), status, tag, href: s ? `/new-agents/${p.id}` : `/team/${p.id}` });
  }
  // a first name two people share shows in full
  const firsts = rows.map((r) => r.first);
  for (const r of rows) if (firsts.filter((f) => f === r.first).length > 1) r.first = r.person.fullName;
  const ORDER = { need: 0, behind: 1, ok: 2, away: 3 };
  rows.sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.person.fullName.localeCompare(b.person.fullName));
  return rows;
}

/** Everything the Supervisor dashboard shows, counted now. */
async function supervisorDashboard(actor, { now = new Date() } = {}) {
  const profiles = await scopedProfiles(actor); // their own assigned team only
  const active = profiles.filter((p) => p.status === 'ACTIVE');
  const states = [];
  for (const p of await board.visiblePrograms(actor)) { const s = await board.agentState(p.id, actor, { now }); if (s) states.push(s); }
  const [setups, learning] = await Promise.all([loadSetupForProfiles(actor.organizationId, active), active.length ? loadLearning(active.map((p) => p.id), now) : []]);
  const ctx = { active, states, setups, learning, now };
  const [program, setup, week, team] = await Promise.all([programTiles(actor, states, now), setupTiles(actor, ctx), weekTiles(actor, ctx), teamOf(actor, ctx)]);
  const all = [...program, ...setup, ...week];
  const lanes = [
    { key: 'late', name: 'Late', tiles: all.filter((t) => t.lane === 'late') },
    { key: 'today', name: 'Today', tiles: all.filter((t) => t.lane === 'today') },
    { key: 'week', name: 'This week', tiles: all.filter((t) => t.lane === 'week') },
  ];
  for (const l of lanes) { l.more = Math.max(0, l.tiles.length - SHOWN); l.shown = l.tiles.slice(0, SHOWN); }
  const minutes = lanes[1].tiles.reduce((n, t) => n + t.minutes, 0);
  lanes[1].hint = minutes ? `About ${board.duration(minutes)}` : '';
  const [lateN, todayN] = [lanes[0].tiles.length, lanes[1].tiles.length];
  const headline = !all.length ? 'Nothing for you today.' : lateN ? `${lateN} late, ${todayN} today.` : todayN ? `${todayN} today.` : `${plural(lanes[2].tiles.length, 'thing')} this week.`;
  const tally = ['need', 'behind', 'ok'].map((k) => ({ key: k, n: team.filter((t) => t.status === k).length })).filter((x) => x.n);
  return { headline, total: all.length, lanes, team, tally, at: now };
}

module.exports = { supervisorDashboard, ICON };
