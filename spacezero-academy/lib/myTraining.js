'use strict';

// My Training = ONE path through the learner's assigned training, in a fixed order. pathOf() is the only place that
// order is decided: My Training, the finish screen of a training and the Dashboard's "what to do next" all read it.
// Pure functions over the learner's list (lib/training.js getMyTrainingList with { progress: true }), so the page and
// its tests never depend on the database; nothing here changes the training engine.

const DAY_MS = 86400000;
const UPCOMING_SHOWN = 3; // locked steps shown after the current one; the rest fold into "+N more"

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const shortDate = (d, now) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "3 days overdue" / "1 day overdue" / "Overdue today" - always spelled out, never only a colour. */
function overdueText(dueDate, now) {
  const days = Math.floor((now - new Date(dueDate)) / DAY_MS);
  return days >= 1 ? `${days} day${days === 1 ? '' : 's'} overdue` : 'Overdue today';
}

/** "Due today" / "Due tomorrow" / "Due Oct 28" (the year only when it is not this year). */
function dueText(dueDate, now) {
  const days = Math.round((startOfDay(new Date(dueDate)) - startOfDay(now)) / DAY_MS);
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  return `Due ${shortDate(new Date(dueDate), now)}`;
}

/** Where the learner stands: "2 of 5 items done · 1 of 2 practices passed" once started, what it holds before that. */
function progressText(progress, started) {
  if (!progress) return '';
  const { items, practices } = progress;
  const parts = started
    ? [items.total ? `${items.done} of ${items.total} items done` : '', practices.total ? `${practices.passed} of ${plural(practices.total, 'practice')} passed` : '']
    : [items.total ? plural(items.total, 'item') : '', practices.total ? plural(practices.total, 'practice') : ''];
  return parts.filter(Boolean).join(' · ');
}

const time = (d) => (d ? new Date(d).getTime() : Infinity);
/** When the learner started a training: the first attempt that is not "not started" (a retake counts). */
const startedAt = (row) => Math.min(...row.attempts.filter((t) => t.status !== 'NOT_STARTED').map((t) => time(t.startedAt || t.createdAt)));
const completedAt = (row) => (row.latestAttempt && row.latestAttempt.completedAt ? new Date(row.latestAttempt.completedAt) : null);

/**
 * The order of the path. Completed first (oldest completion first); then OVERDUE - started or not - the most overdue
 * first; then what is already started (the earliest started first, a retake included); then the rest by due date;
 * then no due date, in the order assigned. Every tie falls back to the order assigned, so the path never reshuffles
 * more than needed. Order only: a training moved back keeps all its progress and opens where the learner stopped.
 */
function sortForPath(rows, now = new Date()) {
  const overdue = (r) => Boolean(r.assignment.dueDate) && new Date(r.assignment.dueDate) < now;
  const band = (r) => (r.status === 'COMPLETED' ? 0 : overdue(r) ? 1 : r.status !== 'NOT_STARTED' ? 2 : 3);
  const key = (r) => (band(r) === 0 ? time(completedAt(r)) : band(r) === 2 ? startedAt(r) : time(r.assignment.dueDate));
  return [...rows].sort((a, b) => band(a) - band(b) || key(a) - key(b) || time(a.createdAt) - time(b.createdAt) || String(a.id).localeCompare(String(b.id)));
}

function stepOf(row, number, now) {
  const done = row.status === 'COMPLETED';
  const started = row.status !== 'NOT_STARTED';
  const dueDate = row.assignment.dueDate ? new Date(row.assignment.dueDate) : null;
  const overdue = !done && Boolean(dueDate) && dueDate < now;
  const href = `/training-course/${row.assignment.courseId}`;
  const finished = done ? completedAt(row) : null;
  const score = done && row.latestAttempt && row.latestAttempt.score != null ? Math.round(row.latestAttempt.score) : null;
  return {
    row, number, done, started, overdue, dueDate, href,
    id: row.id,
    courseId: row.assignment.courseId,
    title: row.assignment.course.title,
    retake: !done && row.status === 'RETAKE_REQUIRED',
    resumeHref: href, // the training page opens on the learner's current step by itself (lib/trainingSteps.js)
    dueText: done || !dueDate ? '' : overdue ? overdueText(dueDate, now) : dueText(dueDate, now),
    progressText: done ? '' : progressText(row.progress, started),
    completedText: done ? [finished ? `Completed ${shortDate(finished, now)}` : 'Completed', score !== null ? `Score ${score}%` : ''].filter(Boolean).join(' · ') : '',
  };
}

/**
 * The learner's path: every step in order, the completed ones, the current one (the only one with a button) and the
 * locked ones after it. action = the label of the one main button: "Start training" for the very first, "Continue"
 * once started (a retake too), "Start next training" between trainings; null when everything is completed.
 */
function pathOf(list, now = new Date()) {
  const steps = sortForPath(list, now).map((row, i) => stepOf(row, i + 1, now));
  const completed = steps.filter((s) => s.done);
  const open = steps.filter((s) => !s.done);
  const current = open[0] || null;
  const upcoming = open.slice(1);
  return {
    steps, completed, current, upcoming,
    upcomingShown: upcoming.slice(0, UPCOMING_SHOWN),
    upcomingMore: upcoming.slice(UPCOMING_SHOWN),
    total: steps.length,
    doneCount: completed.length,
    percent: steps.length ? Math.round((completed.length / steps.length) * 100) : 0,
    action: !current ? null : current.started ? 'Continue' : completed.length ? 'Start next training' : 'Start training',
  };
}

module.exports = { UPCOMING_SHOWN, overdueText, dueText, progressText, sortForPath, pathOf };
