'use strict';

// Practice PLANNING. The AI analysis recommends which kinds of practice fit the material (that is judgement
// about the content); the application decides quantities and difficulty from fixed rules (that is policy),
// so a plan is predictable and costs no extra AI call. The Admin can accept it as is or customize it.
const COMPONENT_TYPES = ['QUIZ', 'ROLEPLAY', 'VOICE', 'TECHNICAL', 'PROCESS_SIM', 'PRODUCT_KNOWLEDGE'];

const LABEL = {
  QUIZ: 'Applied Quiz', ROLEPLAY: 'AI Client Role-play', VOICE: 'Voice Practice', TECHNICAL: 'Technical Practice',
  PROCESS_SIM: 'Process Simulation', PRODUCT_KNOWLEDGE: 'Product Knowledge Practice',
};
// What one unit is called for each kind of practice.
const UNIT = { QUIZ: 'question', ROLEPLAY: 'scenario', VOICE: 'scenario', TECHNICAL: 'question', PROCESS_SIM: 'simulation', PRODUCT_KNOWLEDGE: 'question' };
// One short practice (10-15 minutes) per training: sizes and the default difficulty come from the master generation rules.
const rules = require('./practiceRules');
const DEFAULT_COUNT = rules.DEFAULT_COUNT;
const DEFAULT_LEVEL = rules.DEFAULT_LEVEL; // Level 2 unless the creator picks another
const MAX_COUNT = { QUIZ: 20, ROLEPLAY: 5, VOICE: 3, TECHNICAL: 20, PROCESS_SIM: 3, PRODUCT_KNOWLEDGE: 20 };
const QUESTION_TYPES = ['QUIZ', 'TECHNICAL', 'PRODUCT_KNOWLEDGE'];

const clampCount = (type, n) => Math.max(1, Math.min(MAX_COUNT[type] || 1, Math.round(Number(n)) || DEFAULT_COUNT[type] || 1));
const clampLevel = (n, fallback = 3) => Math.max(1, Math.min(5, Math.round(Number(n)) || fallback));

/**
 * Turns the analysis into a concrete plan: [{ type, count, level, label, unit }]. Following the master generation
 * rules it is normally ONE practice (the best fit for the kind of source), at Level 2, sized for 10-15 minutes; a
 * second practice appears only when the source clearly teaches two different skills. The creator can always
 * customize it. `options` ({ callMode, callOutcome }) tells the rules the source was a call.
 */
function recommendedPlan(analysis, options = {}) {
  return rules.planFor(analysis, options).map((item) => describe(item.type, item.count, item.level));
}

/** The kind of source this is and why that practice was chosen - shown above the recommendation. */
function sourceSummary(analysis, options = {}) {
  const kind = rules.sourceKindOf(analysis, options);
  return kind ? { kind, label: rules.KINDS[kind].label, guidance: rules.KINDS[kind].guidance } : null;
}

function describe(type, count, level) {
  const n = clampCount(type, count);
  return { type, count: n, level: clampLevel(level), label: LABEL[type], unit: UNIT[type], summary: `${n} ${UNIT[type]}${n === 1 ? '' : 's'}` };
}

/** Reads a customize form: methods[] with count_<TYPE> and one shared difficulty (1-5). Unknown types are ignored. */
function readCustomPlan(body) {
  const list = (Array.isArray(body.methods) ? body.methods : body.methods ? [body.methods] : []).map(String).filter((m) => COMPONENT_TYPES.includes(m));
  const level = clampLevel(body.level);
  return [...new Set(list)].map((type) => describe(type, body[`count_${type}`], level));
}

/** Groups a package's components into the Practice Builder rows ("AI Client Role-play — 2 scenarios"). */
function groupComponents(components) {
  const groups = [];
  for (const a of components) {
    let g = groups.find((x) => x.type === a.type);
    if (!g) { g = { type: a.type, label: LABEL[a.type] || a.type, unit: UNIT[a.type] || 'item', items: [] }; groups.push(g); }
    g.items.push(a);
  }
  for (const g of groups) {
    const isQuestionSet = QUESTION_TYPES.includes(g.type);
    g.count = isQuestionSet ? g.items.reduce((n, a) => n + (a.questions ? a.questions.length : 0), 0) : g.items.length;
    g.summary = `${g.count} ${g.unit}${g.count === 1 ? '' : 's'}`;
  }
  return groups;
}

module.exports = { COMPONENT_TYPES, LABEL, UNIT, DEFAULT_COUNT, DEFAULT_LEVEL, MAX_COUNT, QUESTION_TYPES, recommendedPlan, sourceSummary, readCustomPlan, describe, groupComponents, clampLevel };
