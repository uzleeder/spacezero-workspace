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
const DEFAULT_COUNT = { QUIZ: 8, ROLEPLAY: 2, VOICE: 1, TECHNICAL: 6, PROCESS_SIM: 1, PRODUCT_KNOWLEDGE: 6 };
const MAX_COUNT = { QUIZ: 20, ROLEPLAY: 5, VOICE: 3, TECHNICAL: 20, PROCESS_SIM: 3, PRODUCT_KNOWLEDGE: 20 };
const QUESTION_TYPES = ['QUIZ', 'TECHNICAL', 'PRODUCT_KNOWLEDGE'];

const clampCount = (type, n) => Math.max(1, Math.min(MAX_COUNT[type] || 1, Math.round(Number(n)) || DEFAULT_COUNT[type] || 1));
const clampLevel = (n, fallback = 3) => Math.max(1, Math.min(5, Math.round(Number(n)) || fallback));

/** Turns the analysis recommendation into a concrete plan: [{ type, count, level, label, unit }]. */
function recommendedPlan(analysis) {
  const parse = (v, f) => { try { return v ? JSON.parse(v) : f; } catch { return f; } };
  const methods = parse(analysis && analysis.recommendedMethodsJson, []).filter((m) => COMPONENT_TYPES.includes(m));
  const level = clampLevel(parse(analysis && analysis.recommendedIntensityJson, 3));
  const chosen = methods.length ? methods : ['QUIZ'];
  // Knowledge check first, then practical practice: the order the learner will meet them.
  const order = ['QUIZ', 'PRODUCT_KNOWLEDGE', 'TECHNICAL', 'PROCESS_SIM', 'ROLEPLAY', 'VOICE'];
  return [...new Set(chosen)].sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((type) => describe(type, DEFAULT_COUNT[type], level));
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

module.exports = { COMPONENT_TYPES, LABEL, UNIT, DEFAULT_COUNT, MAX_COUNT, QUESTION_TYPES, recommendedPlan, readCustomPlan, describe, groupComponents, clampLevel };
