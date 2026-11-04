'use strict';

// The Admin dashboard ("three lanes", approved 2026-11-04): one answer at the top, what needs the admin in three lanes,
// the academy's health in 4 rings, and the people falling behind.
//   Urgent               nobody owns it, or someone is stuck
//   Decision needed      waits for an admin
//   Up next              can wait a day
// Everything is counted live, per request, from the same functions the linked pages and the 08:30 admin message use
// (new agents board, Vacation, AI Practice, setup, standards). Nothing is stored, so a change anywhere in the academy
// shows on the next refresh, and the dashboard and the morning message cannot disagree.
const { prisma } = require('./prisma');
const board = require('./newAgentBoard');
const reminders = require('./newAgentReminders');
const np = require('./newAgentProgram');
const plans = require('./newAgentPlan');
const { scopedProfiles } = require('./attention');
const { loadSetupForProfiles } = require('./employeeSetup');
const { loadLearning } = require('./teamIntel');
const { visibleLeaveWhere } = require('./leave');
const { ackSummaryForProfiles } = require('./standards');
const { excludeOtherAdminsTestProfiles } = require('./loginAsScope');

const DAY_MS = 86400000;
const TRAINING_TARGET = 90; // % of trainings with a due date that are not overdue
const BEHIND_SHOWN = 5;
const AI_REVIEW = ['ANALYSIS_READY', 'PRACTICE_DRAFT', 'READY_FOR_REVIEW'];

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "Lena Ortiz", "Lena Ortiz and Tom Becker", "Lena Ortiz, Tom Becker and 2 others" */
function names(list) {
  const u = [...new Set(list)];
  if (u.length <= 2) return u.join(' and ');
  return `${u.slice(0, 2).join(', ')} and ${plural(u.length - 2, 'other')}`;
}
const face = (p) => ({ name: p.fullName, initials: board.initials(p.fullName), hue: board.hueOf(p.id) });
const uniqueBy = (list, key) => [...new Map(list.map((x) => [key(x), x])).values()];
const daysAgo = (date, now) => Math.max(0, Math.floor((now - new Date(date)) / DAY_MS));

/** One card: the title says what to do or what is wrong, meta says about whom, the button says the verb. */
function card(key, { title, meta = '', people = [], action, href }) {
  const all = uniqueBy(people.filter(Boolean), (p) => p.id);
  return { key, title, meta, faces: all.slice(0, 3).map(face), more: Math.max(0, all.length - 3), action, href };
}

/** The running New Agent Programs this admin sees, each brought up to date (the board's own states). */
async function programStates(actor, now) {
  const out = [];
  for (const p of await board.visiblePrograms(actor)) { const s = await board.agentState(p.id, actor, { now }); if (s) out.push(s); }
  return out;
}

/** Urgent: nobody owns it, or someone is stuck. */
async function fixLane(actor, { states, setups, active, now }) {
  const cards = [];

  // New agents nobody is supervising: not on the path, no supervisor, or a disabled one (same check as the 08:30 message)
  const untracked = await board.untrackedHires(actor.organizationId, states, { now });
  const orphans = states.filter((s) => !s.travel && !s.supervisor).map((s) => ({ profile: s.profile, reason: 'No supervisor', action: 'Assign supervisor', href: `/admin/employees/${s.profile.id}` }));
  const unowned = [...untracked, ...orphans];
  if (unowned.length && unowned.length <= 2) { // up to 2, one card each so the names show; more, one card for them all
    for (const u of unowned) {
      const notOnPath = u.reason === 'Not in the New Agent Program';
      const title = u.reason === 'No supervisor' ? `${u.profile.fullName} has no supervisor` : notOnPath ? `${u.profile.fullName} is not in the New Agent Program` : `${u.profile.fullName}: ${u.reason.charAt(0).toLowerCase()}${u.reason.slice(1)}`;
      cards.push(card(`unowned:${u.profile.id}`, { title, meta: notOnPath ? 'Hired recently, not on the path yet' : 'Nobody is doing their supervisor items', people: [u.profile], action: u.action, href: u.href }));
    }
  } else if (unowned.length) {
    cards.push(card('unowned', { title: `${plural(unowned.length, 'new agent')} nobody is supervising`, meta: names(unowned.map((u) => u.profile.fullName)), people: unowned.map((u) => u.profile), action: 'See them', href: '/new-agents' }));
  }

  // Supervisor items late long enough to be the admins' (ESCALATE_DAYS working days)
  const late = states.flatMap((s) => reminders.escalated(s).map((t) => ({ s, t })));
  if (late.length) {
    const agents = uniqueBy(late.map((x) => x.s), (s) => s.profile.id);
    const sups = [...new Set(agents.map((s) => (s.supervisor ? s.supervisor.fullName : 'no supervisor')))];
    cards.push(card('late', {
      title: `${plural(late.length, 'supervisor item')} ${reminders.ESCALATE_DAYS}+ days late`,
      meta: `For ${names(agents.map((s) => s.profile.fullName))} · ${sups.length === 1 && sups[0] !== 'no supervisor' ? `owned by ${sups[0]}` : names(sups)}`,
      people: agents.map((s) => s.profile), action: 'See items', href: agents.length === 1 ? `/new-agents/${agents[0].profile.id}` : '/new-agents',
    }));
  }

  // Setup: an "I don't have" access problem, and setup items the admins own that are overdue
  const issues = active.filter((p) => setups.get(p.id).hasIssue).map((p) => ({ p, row: setups.get(p.id).rows.find((r) => r.counts && r.status === 'ISSUE') }));
  if (issues.length === 1) {
    const { p, row } = issues[0];
    cards.push(card('setupIssue', { title: `${p.fullName} has no ${row ? row.requirement.label : 'access'}`, meta: 'Marked "I don\'t have" on their setup', people: [p], action: 'Open setup', href: `/employees/${p.id}/setup` }));
  } else if (issues.length) {
    cards.push(card('setupIssue', { title: `${plural(issues.length, 'person', 'people')} missing access`, meta: names(issues.map((x) => x.p.fullName)), people: issues.map((x) => x.p), action: 'See them', href: '/admin/employees?readiness=NEEDS_ATTENTION' }));
  }
  const mine = active.flatMap((p) => setups.get(p.id).overdueRows.filter((r) => r.ownerRole === 'ADMIN').map((r) => ({ p, r })));
  if (mine.length) {
    cards.push(card('setupOverdue', {
      title: mine.length === 1 ? `${mine[0].r.requirement.label} overdue for ${mine[0].p.fullName}` : `${plural(mine.length, 'setup item')} you own are overdue`,
      meta: mine.length === 1 ? `Was due ${board.shortDate(mine[0].r.dueAt.toISOString().slice(0, 10))}` : `For ${names(mine.map((x) => x.p.fullName))}`,
      people: mine.map((x) => x.p), action: 'Open setup', href: mine.length === 1 ? `/employees/${mine[0].p.id}/setup` : '/admin/employees?readiness=NEEDS_ATTENTION',
    }));
  }
  return cards;
}

/** Decision needed: things that wait for an admin. */
async function decideLane({ states, now }) {
  const cards = [];
  const travel = states.filter((s) => s.travel);

  const ready = travel.filter(board.isReady);
  if (ready.length) cards.push(card('ready', { title: ready.length === 1 ? `${ready[0].profile.fullName} is ready for solo live calls` : `${ready.length} ready for solo live calls`, meta: 'Passed every check', people: ready.map((s) => s.profile), action: 'Review', href: '/new-agents/approvals' }));

  const decisions = travel.filter((s) => s.summary.rampOver && !board.isReady(s));
  if (decisions.length) cards.push(card('decisions', { title: `Month 1 is over for ${plural(decisions.length, 'agent')}`, meta: `${names(decisions.map((s) => s.profile.fullName))}: approve, or give more time`, people: decisions.map((s) => s.profile), action: 'Decide', href: '/new-agents/approvals' }));

  const confirms = travel.flatMap((s) => s.waiting.map((t) => ({ s, t })));
  if (confirms.length) {
    const ids = [...new Set(confirms.map((x) => x.t.requestedById).filter(Boolean))];
    const by = ids.length ? (await prisma.profile.findMany({ where: { id: { in: ids } }, select: { fullName: true } })).map((p) => p.fullName) : [];
    cards.push(card('signoffs', { title: `Confirm ${plural(confirms.length, 'sign-off')}`, meta: by.length ? `From ${names(by)}` : 'Supervisor sign-offs', people: confirms.map((x) => x.s.profile), action: 'Confirm', href: '/new-agents/approvals' }));
  }

  const flags = travel.flatMap((s) => s.flags.map((f) => ({ s, f })));
  if (flags.length) cards.push(card('flags', { title: `${plural(flags.length, 'flag')} to look at`, meta: `${flags[0].s.profile.fullName}: ${flags[0].f.text}`, people: flags.map((x) => x.s.profile), action: 'Look', href: '/new-agents/approvals' }));

  // "Before day 1" items only an admin can do (accounts), due today or late
  const pre = travel.flatMap((s) => s.tasks.filter((t) => t.owner === 'ADMIN' && !t.doneAt && ['LATE', 'TODAY'].includes(np.stateOf(t, s.pos))).map((t) => ({ s, t })));
  if (pre.length === 1) {
    const { s, t } = pre[0];
    cards.push(card('prestart', { title: `${board.shortTitle(t)} not ready for ${s.profile.fullName}`, meta: s.pos.started ? 'They have already started' : `Starts ${board.shortDate(s.cal.startKey)}`, people: [s.profile], action: 'Open', href: `/new-agents/${s.profile.id}` }));
  } else if (pre.length) {
    const agents = uniqueBy(pre.map((x) => x.s), (s) => s.profile.id);
    cards.push(card('prestart', { title: `${plural(pre.length, 'account')} not ready before day 1`, meta: `For ${names(agents.map((s) => s.profile.fullName))}`, people: agents.map((s) => s.profile), action: 'Open', href: agents.length === 1 ? `/new-agents/${agents[0].profile.id}` : '/new-agents' }));
  }
  void now;
  return cards;
}

/** Up next: decisions that can wait a day. */
async function waitLane(actor, { states, sources, profiles, now }) {
  const cards = [];

  const leave = await prisma.leaveRequest.findMany({ where: { ...(await visibleLeaveWhere(actor)), status: 'PENDING' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true, profile: { select: { id: true, fullName: true } } } });
  if (leave.length) {
    const waited = daysAgo(leave[0].createdAt, now);
    cards.push(card('leave', { title: plural(leave.length, 'vacation request'), meta: waited ? `The oldest has waited ${plural(waited, 'day')}` : 'Asked today', people: leave.map((l) => l.profile), action: 'Decide', href: '/leave?status=PENDING' }));
  }

  const submitted = sources.filter((i) => i.state.key === 'SUBMITTED');
  if (submitted.length) cards.push(card('trainingApproval', { title: `${plural(submitted.length, 'training')} to approve`, meta: submitted.length === 1 ? `"${submitted[0].title}"${submitted[0].uploadedBy ? ` from ${submitted[0].uploadedBy}` : ''}` : names(submitted.map((i) => `"${i.title}"`)), action: 'Review', href: '/ai-practice?tab=approval' }));

  const review = sources.filter((i) => AI_REVIEW.includes(i.state.key));
  if (review.length) cards.push(card('aiReview', { title: `${plural(review.length, 'AI practice')} to review`, meta: review.length === 1 ? `"${review[0].title}"` : names(review.map((i) => `"${i.title}"`)), action: 'Review', href: '/ai-practice?tab=review' }));

  const covering = states.filter((s) => s.travel && s.cover && s.cover.reason === 'LEAVE');
  if (covering.length) {
    const away = [...new Set(covering.map((s) => s.supervisor.fullName))];
    cards.push(card('covering', { title: `You are covering ${plural(covering.length, 'agent')}`, meta: `${names(away)} ${away.length === 1 ? 'is' : 'are'} on leave`, people: covering.map((s) => s.profile), action: 'See', href: '/new-agents' }));
  }

  const invited = profiles.filter((p) => p.status === 'INVITED');
  if (invited.length) cards.push(card('activation', { title: `${plural(invited.length, 'person', 'people')} not activated yet`, meta: names(invited.map((p) => p.fullName)), people: invited, action: 'See', href: '/admin/employees?readiness=NOT_ACTIVATED' }));
  return cards;
}

/** The red bar: something broke in the background, or is about to run out. */
async function brokenOf(actor, { states, sources }) {
  const out = [];
  const failed = sources.filter((i) => i.state.key === 'FAILED');
  for (const i of failed.slice(0, 2)) out.push({ key: `failed:${i.id}`, text: i.kind === 'CALL' ? `"${i.title}" failed to process.` : `"${i.title}" failed to build.`, action: 'Retry', href: i.href });
  if (failed.length > 2) out.push({ key: 'failed:more', text: `${plural(failed.length - 2, 'more item')} in AI Practice failed.`, action: 'Open', href: '/ai-practice?tab=needs' });
  const keys = await prisma.practiceCall.count({ where: { organizationId: actor.organizationId, archivedAt: null, referenceStatus: 'FAILED' } });
  if (keys) out.push({ key: 'answerKeys', text: `${plural(keys, 'Call Practice answer key')} could not be made.`, action: 'Fix', href: '/admin/call-practice' });
  const left = await reminders.libraryDaysLeft(actor.organizationId, states);
  if (left !== null && left < reminders.LIBRARY_DAYS) out.push({ key: 'library', text: left ? `Call library: about ${plural(left, 'day')} of calls left.` : 'Call library: no new calls left.', action: 'Add calls', href: '/admin/call-practice' });
  return out;
}

/** The 4 rings. ok: on target; low: below it; none: nothing to measure yet. */
async function ringsOf(actor, { states, learning, active, now }) {
  const ring = (key, label, pct, target, value, note, href, extra = {}) => ({ key, label, pct, target, value, note, href, status: pct === null ? 'none' : pct >= target ? 'ok' : 'low', ...extra });
  const rings = [];

  const withDue = learning.filter((l) => l.due);
  const overdue = withDue.filter((l) => l.overdue);
  const overduePeople = new Set(overdue.map((l) => l.profileId)).size;
  const onTime = withDue.length ? Math.round(((withDue.length - overdue.length) / withDue.length) * 100) : null;
  rings.push(ring('training', 'Training on time', onTime, TRAINING_TARGET, onTime === null ? '—' : `${onTime}%`, onTime === null ? 'No due dates yet' : overduePeople ? `${plural(overduePeople, 'person', 'people')} overdue` : 'Nothing overdue', '/admin/employees?overdue=1'));

  const behind = states.filter((s) => ['URGENT', 'BEHIND'].includes(s.group));
  const onPace = states.length - behind.length;
  rings.push(ring('newAgents', 'New agents on track', states.length ? Math.round((onPace / states.length) * 100) : null, 100, states.length ? `${onPace}/${states.length}` : '—',
    !states.length ? 'No new agents now' : behind.length === 1 ? `${board.firstName(behind[0].profile.fullName)} is behind` : behind.length ? `${behind.length} are behind` : 'Everyone on plan', '/new-agents'));

  // Call Practice accuracy: the last 7 days against the 7 before (both counted from the transcripts, so the trend is exact)
  const plan = states.find((s) => s.plan) ? states.find((s) => s.plan).plan : null;
  const target = plan ? plans.readyOf(plan).accuracy : 90;
  const avgSince = async (from, to) => {
    const r = await prisma.practiceCallTranscript.aggregate({ _avg: { accuracy: true }, _count: { accuracy: true }, where: { submittedAt: { gte: from, lt: to }, accuracy: { not: null }, profile: { organizationId: actor.organizationId, ...excludeOtherAdminsTestProfiles(actor) } } });
    return r._count.accuracy ? Math.round(r._avg.accuracy) : null;
  };
  const week = await avgSince(new Date(now.getTime() - 7 * DAY_MS), now);
  const before = await avgSince(new Date(now.getTime() - 14 * DAY_MS), new Date(now.getTime() - 7 * DAY_MS));
  const delta = week !== null && before !== null ? week - before : null;
  rings.push(ring('accuracy', 'Call Practice accuracy', week, target, week === null ? '—' : `${week}%`,
    week === null ? 'No calls this week' : delta === null ? `Target ${target}%` : delta > 0 ? `↑ ${plural(delta, 'pt')} this week` : delta < 0 ? `↓ ${plural(-delta, 'pt')} this week` : 'Same as last week', '/new-agents', { delta }));

  const acks = active.length ? await ackSummaryForProfiles(actor.organizationId, active) : new Map();
  let required = 0; let done = 0; let people = 0;
  for (const a of acks.values()) { required += a.required; done += a.acknowledged; if (a.pending) people += 1; }
  const read = required ? Math.round((done / required) * 100) : null;
  rings.push(ring('standards', 'Standards acknowledged', read, 100, read === null ? '—' : `${read}%`, read === null ? 'No required standards' : people ? `${plural(people, 'person', 'people')} still to read` : 'Everyone read the latest', '/standards/team-status'));
  return rings;
}

/** Falling behind: one line per person, the most serious reason first; the 5 most behind are shown. */
async function behindOf(actor, { states, learning, byId }) {
  const rows = new Map();
  const add = (p, rank, sort, why, tag, href) => {
    if (!p) return;
    const cur = rows.get(p.id);
    if (!cur) rows.set(p.id, { person: p, rank, sort, why, tag, href, others: 0 });
    else if (rank < cur.rank || (rank === cur.rank && sort > cur.sort)) rows.set(p.id, { person: p, rank, sort, why, tag, href, others: cur.others + 1 });
    else cur.others += 1;
  };
  for (const s of states) {
    const own = s.tasks.filter((t) => t.owner === 'AGENT' && np.stateOf(t, s.pos) === 'LATE' && !board.isHistory(t, s.pos, s.travel));
    const days = own.length ? Math.max(...own.map((t) => np.daysLate(t, s.pos))) : 0;
    const sup = s.supervisor ? s.supervisor.fullName : 'no supervisor';
    if (days) add(s.profile, 0, days, `New agent · ${sup}`, `${plural(days, 'day')} behind`, `/new-agents/${s.profile.id}`);
    if (s.travel) {
      const streak = await reminders.lowStreak(s.profile.id);
      if (streak) add(s.profile, 1, 0, `Call Practice ${Math.round(streak.last[streak.last.length - 1].accuracy)}%, needs ${plans.readyOf(s.plan || {}).accuracy}% · ${sup}`, `Low ${streak.last.length} calls in a row`, `/new-agents/${s.profile.id}`);
    }
  }
  const by = (list) => { const m = new Map(); for (const l of list) m.set(l.profileId, [...(m.get(l.profileId) || []), l]); return m; };
  for (const [id, list] of by(learning.filter((l) => l.overdue && l.course && l.course.mandatory))) {
    add(byId.get(id), 2, list.length, list.length === 1 ? `"${list[0].course.title}"` : 'Mandatory training', `${list.length} overdue`, `/employees/${id}/training`);
  }
  for (const [id, list] of by(learning.filter((l) => l.retake))) {
    add(byId.get(id), 3, list.length, list.length === 1 ? `"${list[0].course.title}"` : `${list.length} trainings`, 'Retake needed', `/employees/${id}/training`);
  }
  const ids = [...byId.keys()];
  const slipping = ids.length ? await prisma.developmentRecommendation.findMany({ where: { organizationId: actor.organizationId, profileId: { in: ids }, source: 'RETENTION', status: 'OPEN' }, select: { profileId: true, title: true } }) : [];
  for (const r of slipping) add(byId.get(r.profileId), 4, 0, r.title, 'Skill slipping', `/employees/${r.profileId}/training`);

  const all = [...rows.values()].sort((a, b) => a.rank - b.rank || b.sort - a.sort || a.person.fullName.localeCompare(b.person.fullName));
  return { total: all.length, rows: all.slice(0, BEHIND_SHOWN).map((r) => ({ ...r, face: face(r.person), why: r.others ? `${r.why} · +${r.others} more` : r.why })) };
}

/** Everything the Admin dashboard shows, counted now. */
async function adminDashboard(actor, { now = new Date() } = {}) {
  const profiles = await scopedProfiles(actor);
  const active = profiles.filter((p) => p.status === 'ACTIVE');
  const byId = new Map(active.map((p) => [p.id, p]));
  const [states, setups, learning, sources] = await Promise.all([
    programStates(actor, now),
    loadSetupForProfiles(actor.organizationId, profiles),
    active.length ? loadLearning(active.map((p) => p.id), now) : [],
    require('./aiPracticeState').loadSources(actor, { now }),
  ]);
  const ctx = { states, setups, learning, sources, profiles, active, byId, now };
  const [fix, decide, wait, broken, rings, behind] = await Promise.all([
    fixLane(actor, ctx), decideLane(ctx), waitLane(actor, ctx), brokenOf(actor, ctx), ringsOf(actor, ctx), behindOf(actor, ctx),
  ]);
  const lanes = [
    { key: 'fix', name: 'Urgent', hint: 'Nobody owns it, or someone is stuck', cards: fix },
    { key: 'decide', name: 'Decision needed', hint: 'Waiting for an admin', cards: decide },
    { key: 'wait', name: 'Up next', hint: 'Can wait a day', cards: wait },
  ];
  const total = fix.length + decide.length + wait.length;
  const headline = !total ? 'All clear today.' : fix.length ? `${plural(fix.length, 'thing needs', 'things need')} fixing.` : decide.length ? `${plural(decide.length, 'thing waits', 'things wait')} for you.` : 'Nothing urgent today.';
  return { headline, total, lanes, broken, rings, behind, at: now };
}

module.exports = { adminDashboard, names };
