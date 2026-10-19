'use strict';

// A finer-grained, at-a-glance grouping built ON TOP OF the existing readiness/setup/learning
// calculations (lib/readiness.js, lib/employeeSetup.js, lib/teamIntel.js) — it invents no new
// business rules and no new score. It only asks, from facts those modules already computed,
// "which of six buckets is this person in, and whose turn is it to act?":
//   never-started  invited, has not activated yet
//   urgent         something is broken or overdue on MANAGEMENT's side (a flagged issue, or an
//                  overdue setup item management owns) — blocked on us, not on them
//   needs-you      the employee did their part and is waiting on a Supervisor/Admin to confirm
//                  it (awaiting verification / awaiting company-control confirmation)
//   at-risk        overdue and waiting on the EMPLOYEE (an overdue setup item they own, overdue
//                  mandatory training, or a requested retake not yet redone)
//   on-track       activated, nothing overdue or blocked, but setup or mandatory training is
//                  still in progress
//   done           fully set up and all mandatory training completed
// This never replaces lib/readiness.js's five-status field (still used for the existing
// ?readiness= filter/links) — it is an additional, richer view for this one page.
const { loadSetupForProfiles } = require('./employeeSetup');
const { loadLearning } = require('./teamIntel');
const { prisma } = require('./prisma');

const GROUP_META = [
  { key: 'urgent', label: 'Urgent', desc: 'Blocked until you act' },
  { key: 'needs-you', label: 'Needs you', desc: 'Waiting for your review' },
  { key: 'at-risk', label: 'At risk', desc: 'Overdue, waiting on the employee' },
  { key: 'never-started', label: 'Never started', desc: "Invited but hasn't activated yet" },
  { key: 'on-track', label: 'On track', desc: 'Actively progressing, nothing overdue' },
  { key: 'done', label: 'Ready', desc: 'Fully set up and trained' },
];
const GROUP_KEYS = GROUP_META.map((g) => g.key);
// Collapsed by default in the UI — everyone else is worth seeing open.
const COLLAPSED_BY_DEFAULT = new Set(['never-started', 'done']);

const AVATAR_HUES = ['rose', 'apricot', 'sand', 'mint', 'teal', 'sky', 'lilac', 'orchid'];
function avatarHue(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_HUES[h % AVATAR_HUES.length];
}
function initialsOf(fullName) {
  return String(fullName || '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
}

/** Real "last active" signal — the most recent session for each profile. Never fabricated. */
async function lastActiveMap(profileIds) {
  if (!profileIds.length) return new Map();
  const rows = await prisma.session.groupBy({ by: ['profileId'], where: { profileId: { in: profileIds } }, _max: { lastUsedAt: true } });
  return new Map(rows.map((r) => [r.profileId, r._max.lastUsedAt]));
}

function daysAgo(date, now) {
  if (!date) return null;
  return Math.max(0, Math.floor((now - date) / 86400000));
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "6 Aug", or "6 Aug 2025" only when the date is not in the current year. */
function formatShortDate(date, now) {
  if (!date) return null;
  const label = `${date.getDate()} ${SHORT_MONTHS[date.getMonth()]}`;
  return date.getFullYear() === now.getFullYear() ? label : `${label} ${date.getFullYear()}`;
}

/** Pure classification for one profile, from its already-computed setup + learning facts. */
function classifyOne({ profile, setup, learning, now }) {
  if (profile.status === 'INVITED') {
    return { group: 'never-started', reasons: ['Has not activated the account yet'], overdueDays: null, overdueDate: null };
  }
  if (profile.status !== 'ACTIVE') return null; // disabled / archived: not part of this view

  const mandatory = learning.filter((l) => l.course && l.course.mandatory);
  const openMandatory = mandatory.filter((l) => l.status !== 'COMPLETED');
  const overdueTraining = learning.filter((l) => l.overdue);
  const retakeTraining = learning.filter((l) => l.retake);
  const managementOwnedOverdue = setup.overdueRows.filter((r) => r.ownerRole === 'ADMIN' || r.ownerRole === 'SUPERVISOR');
  const employeeOwnedOverdue = setup.overdueRows.filter((r) => r.ownerRole !== 'ADMIN' && r.ownerRole !== 'SUPERVISOR');
  const awaitingUs = setup.rows.filter((r) => r.awaitingVerification || r.awaitingCompanyControl);

  const overdueDates = [...setup.overdueRows.map((r) => r.dueAt), ...overdueTraining.map((l) => l.due)].filter(Boolean);
  // The oldest due date is the one driving the overdue-days figure — show that one date, not every date.
  const oldestOverdueDate = overdueDates.length ? new Date(Math.min(...overdueDates.map((d) => d.getTime()))) : null;
  const overdueDays = oldestOverdueDate ? daysAgo(oldestOverdueDate, now) : null;

  if (setup.hasIssue || managementOwnedOverdue.length) {
    const reasons = [];
    if (setup.hasIssue) reasons.push('A setup item has an issue');
    if (managementOwnedOverdue.length) reasons.push(`${managementOwnedOverdue.length} setup item${managementOwnedOverdue.length === 1 ? '' : 's'} we own ${managementOwnedOverdue.length === 1 ? 'is' : 'are'} overdue`);
    return { group: 'urgent', reasons, overdueDays, overdueDate: oldestOverdueDate };
  }
  if (awaitingUs.length) {
    return { group: 'needs-you', reasons: [`${awaitingUs.length} setup item${awaitingUs.length === 1 ? '' : 's'} waiting on your review`], overdueDays: null, overdueDate: null };
  }
  if (employeeOwnedOverdue.length || overdueTraining.length || retakeTraining.length) {
    const reasons = [];
    if (employeeOwnedOverdue.length) reasons.push(`${employeeOwnedOverdue.length} setup item${employeeOwnedOverdue.length === 1 ? '' : 's'} overdue`);
    if (overdueTraining.length) reasons.push(`${overdueTraining.length} training assignment${overdueTraining.length === 1 ? '' : 's'} overdue`);
    if (retakeTraining.length) reasons.push(`${retakeTraining.length} retake${retakeTraining.length === 1 ? '' : 's'} required`);
    return { group: 'at-risk', reasons, overdueDays, overdueDate: oldestOverdueDate };
  }
  if (!setup.fullySetUp || openMandatory.length) {
    const reasons = [];
    if (!setup.fullySetUp) reasons.push(`${setup.required - setup.completed} required setup item${setup.required - setup.completed === 1 ? '' : 's'} left`);
    if (openMandatory.length) reasons.push(`${openMandatory.length} mandatory training${openMandatory.length === 1 ? '' : 's'} not completed`);
    return { group: 'on-track', reasons, overdueDays: null, overdueDate: null };
  }
  return { group: 'done', reasons: [], overdueDays: null, overdueDate: null };
}

/**
 * Classifies many profiles of one organization at once. `setupMap`/`readinessMap` may be passed
 * when the caller already loaded them (both routes that use this already compute setupMap).
 * Returns Map(profileId -> { group, label, desc, reasons, progress, overdueDays, lastActiveAt,
 * hue, initials }). People who are disabled or archived have no entry (matches readiness.js).
 */
async function classifyEmployees(organizationId, profiles, { setupMap = null, now = new Date() } = {}) {
  const setups = setupMap || await loadSetupForProfiles(organizationId, profiles);
  const active = profiles.filter((p) => p.status === 'ACTIVE');
  const ids = profiles.map((p) => p.id);
  const [learningRows, lastActive, noteRows] = await Promise.all([
    active.length ? loadLearning(active.map((p) => p.id), now) : [],
    lastActiveMap(ids),
    ids.length ? prisma.coachingNote.findMany({ where: { profileId: { in: ids } }, select: { profileId: true } }) : [],
  ]);
  const noteCounts = new Map();
  for (const row of noteRows) noteCounts.set(row.profileId, (noteCounts.get(row.profileId) || 0) + 1);
  const learningByProfile = new Map();
  for (const l of learningRows) {
    const list = learningByProfile.get(l.profileId) || [];
    list.push(l);
    learningByProfile.set(l.profileId, list);
  }

  const out = new Map();
  for (const profile of profiles) {
    const setup = setups.get(profile.id);
    if (!setup) continue;
    const learning = learningByProfile.get(profile.id) || [];
    const result = classifyOne({ profile, setup, learning, now });
    if (!result) continue;
    const mandatory = learning.filter((l) => l.course && l.course.mandatory);
    const trainingCompleted = mandatory.filter((l) => l.status === 'COMPLETED').length;
    const meta = GROUP_META.find((g) => g.key === result.group);
    out.set(profile.id, {
      group: result.group,
      label: meta.label,
      desc: meta.desc,
      reasons: result.reasons,
      progress: {
        completed: setup.completed + trainingCompleted,
        required: setup.required + mandatory.length,
      },
      overdueDays: result.overdueDays,
      overdueDateLabel: formatShortDate(result.overdueDate, now),
      lastActiveAt: lastActive.get(profile.id) || null,
      noteCount: noteCounts.get(profile.id) || 0,
      hue: avatarHue(profile.id),
      initials: initialsOf(profile.fullName),
    });
  }
  return out;
}

/** Groups an already-classified list of profiles into the ordered, non-empty buckets the page renders. */
function groupBy(profiles, statusGroups) {
  const buckets = new Map(GROUP_KEYS.map((k) => [k, []]));
  for (const profile of profiles) {
    const s = statusGroups.get(profile.id);
    if (s) buckets.get(s.group).push(profile);
  }
  return GROUP_META
    .map((meta) => ({ ...meta, collapsed: COLLAPSED_BY_DEFAULT.has(meta.key), profiles: buckets.get(meta.key) }))
    .filter((g) => g.profiles.length > 0);
}

/** Disabled/archived people fit none of the six groups (they need no action) but must not just vanish from a filtered list. */
function ungrouped(profiles, statusGroups) {
  return profiles.filter((p) => !statusGroups.has(p.id));
}

module.exports = { GROUP_META, GROUP_KEYS, classifyEmployees, groupBy, ungrouped, avatarHue, initialsOf, lastActiveMap };
