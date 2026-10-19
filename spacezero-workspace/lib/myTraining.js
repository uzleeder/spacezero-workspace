'use strict';

// My Training = two simple concepts on ONE page: STATUS (Overdue / To Do / In Progress / Completed) and
// CATEGORY (All / Product / Sales / System & Workflow). Pure functions over the learner's list so the page
// (and its tests) never depend on the database; nothing here changes the training engine.
const categories = require('./trainingCategories');

const DAY_MS = 86400000;
const STATUSES = [
  { key: 'overdue', label: 'Overdue', hint: 'Past its due date and not finished' },
  { key: 'todo', label: 'To Do', hint: 'Assigned, not started yet' },
  { key: 'inprogress', label: 'In Progress', hint: 'Started, not completed' },
  { key: 'completed', label: 'Completed', hint: 'Your completed training' },
];
const STATUS_KEYS = STATUSES.map((s) => s.key);

/** The status group of one training: Overdue wins over everything but Completed. A retake counts as started-but-not-completed. */
function groupOf(row, now) {
  if (row.status === 'COMPLETED') return 'completed';
  const due = row.assignment && row.assignment.dueDate ? new Date(row.assignment.dueDate) : null;
  if (due && due < now) return 'overdue';
  if (row.status === 'NOT_STARTED') return 'todo';
  return 'inprogress';
}

/** "3 days overdue" / "1 day overdue" / "Overdue since today" - always spelled out, never only a colour. */
function overdueText(dueDate, now) {
  const days = Math.floor((now - new Date(dueDate)) / DAY_MS);
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'} overdue`;
  return 'Overdue since today';
}

function buildMyTraining(list, query = {}, now = new Date()) {
  const rows = list.map((row) => {
    const group = groupOf(row, now);
    const dueDate = row.assignment && row.assignment.dueDate ? new Date(row.assignment.dueDate) : null;
    const category = categories.isCategory(row.assignment.course.trainingCategory) ? row.assignment.course.trainingCategory : null;
    return { row, group, category, dueDate, overdueText: group === 'overdue' ? overdueText(dueDate, now) : null, retake: group !== 'completed' && (row.status === 'RETAKE_REQUIRED' || row.status === 'FAILED') };
  });

  const category = categories.readFilter(query.category); // a category, "UNCATEGORIZED" (trainings that predate categories), or all
  const inCategory = rows.filter((r) => categories.matches({ trainingCategory: r.category }, category));
  const counts = Object.fromEntries(STATUS_KEYS.map((k) => [k, inCategory.filter((r) => r.group === k).length]));

  // No status chosen: land on the first thing that needs attention (Overdue first, then To Do ...).
  const requested = STATUS_KEYS.includes(query.status) ? query.status : '';
  const status = requested || STATUS_KEYS.find((k) => counts[k] > 0) || 'todo';

  const forStatus = rows.filter((r) => r.group === status);
  const catCounts = Object.fromEntries([...categories.KEYS, 'UNCATEGORIZED'].map((k) => [k, forStatus.filter((r) => categories.matches({ trainingCategory: r.category }, k)).length]));
  const cards = forStatus.filter((r) => categories.matches({ trainingCategory: r.category }, category));
  const time = (r) => (r.dueDate ? r.dueDate.getTime() : Infinity);
  if (status === 'completed') cards.sort((a, b) => new Date((b.row.latestAttempt && b.row.latestAttempt.completedAt) || 0) - new Date((a.row.latestAttempt && a.row.latestAttempt.completedAt) || 0));
  else cards.sort((a, b) => time(a) - time(b) || new Date(b.row.createdAt) - new Date(a.row.createdAt)); // overdue first = the oldest due date first

  return {
    status, category, cards, counts, catCounts, total: forStatus.length,
    statusTabs: STATUSES.map((s) => ({ ...s, count: counts[s.key] })),
    // a training from before categories has none: it gets its own chip (only while one exists) instead of vanishing from every filter
    categoryTabs: [{ key: '', label: 'All', count: forStatus.length }, ...categories.CATEGORIES.map((c) => ({ key: c.key, label: c.short, count: catCounts[c.key] })), ...(rows.some((r) => !r.category) ? [{ key: 'UNCATEGORIZED', label: 'Uncategorized', count: catCounts.UNCATEGORIZED }] : [])],
  };
}

module.exports = { STATUSES, STATUS_KEYS, groupOf, overdueText, buildMyTraining };
