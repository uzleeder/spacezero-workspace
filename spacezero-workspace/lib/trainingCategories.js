'use strict';

// The ONE Training Category system, shared by the Training Catalog, Assignments, My Training and AI Practice
// (it is a field on the training itself, TrainingCourse.trainingCategory, so it travels with the training
// everywhere and there is nothing to keep in sync). Three fixed categories; no individual airline or training
// name is ever hard-coded. A training that existed before categories keeps a null category until an Admin
// chooses one - it is never deleted or recreated.
const CATEGORIES = [
  { key: 'PRODUCT', label: 'Product Training', short: 'Product', hint: 'Airline / product knowledge: aircraft, cabins, fares, baggage, lounges, routes and airline products.' },
  { key: 'SALES', label: 'Sales Training', short: 'Sales', hint: 'Sales techniques: discovery, objections, closing, communication, call skills and sales mindset.' },
  { key: 'SYSTEM_WORKFLOW', label: 'System & Workflow Training', short: 'System & Workflow', hint: 'CRM, GDS, ticketing, internal systems, technical procedures, operational processes and workflows.' },
];
const KEYS = CATEGORIES.map((c) => c.key);
const byKey = new Map(CATEGORIES.map((c) => [c.key, c]));

const isCategory = (value) => typeof value === 'string' && byKey.has(value);
/** A valid category key, or null. */
const readCategory = (value) => (isCategory(value) ? value : null);
const categoryLabel = (key) => (byKey.get(key) ? byKey.get(key).label : 'Uncategorized');
const categoryShort = (key) => (byKey.get(key) ? byKey.get(key).short : 'Uncategorized');

/** A category filter from a query string: one of the keys, "UNCATEGORIZED", or "" for all. */
const readFilter = (value) => (isCategory(value) || value === 'UNCATEGORIZED' ? value : '');

/** What the AI analysis suggests (a starting point for the Admin's choice, never applied on its own). */
function suggestFromClassifications(classificationsJson) {
  let list;
  try { list = JSON.parse(classificationsJson || '[]') || []; } catch { list = []; }
  const map = { PRODUCT_KNOWLEDGE: 'PRODUCT', SALES_COMMUNICATION: 'SALES', CUSTOMER_SERVICE: 'SALES', TECHNICAL: 'SYSTEM_WORKFLOW', PROCESS_SOP: 'SYSTEM_WORKFLOW' };
  for (const c of list) if (map[c]) return map[c];
  return '';
}

/** Counts per category (and uncategorized) for a list of courses. */
function countByCategory(courses) {
  const counts = { UNCATEGORIZED: 0 };
  for (const key of KEYS) counts[key] = 0;
  for (const c of courses) counts[isCategory(c.trainingCategory) ? c.trainingCategory : 'UNCATEGORIZED'] += 1;
  return counts;
}

const matches = (course, filter) => !filter || (filter === 'UNCATEGORIZED' ? !isCategory(course.trainingCategory) : course.trainingCategory === filter);

module.exports = { CATEGORIES, KEYS, isCategory, readCategory, categoryLabel, categoryShort, readFilter, suggestFromClassifications, countByCategory, matches };
