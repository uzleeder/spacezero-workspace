'use strict';

// SpaceZero AI Practice - MASTER GENERATION RULES, in one place.
//
// AI Practice reinforces training that has ALREADY been delivered:
//   REMEMBER -> RECOGNIZE -> APPLY -> RETAIN, in about 10-15 minutes, using the training in real work.
//
// STEP 1 (understand the training) is `sourceKindOf` + `planFor`: the source is classified as the closest of
// eight kinds, and each kind has ONE best practice type, a default size and a default difficulty (Level 2).
// STEP 2 (how to generate) is the prompt blocks below, appended to every generator's instructions so product,
// sales, CRM, technical, policy and call-based practice all follow the same rules.
const parse = (value, fallback) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };

const KINDS = {
  PRODUCT_KNOWLEDGE: {
    label: 'Product / airline knowledge',
    practice: 'PRODUCT_KNOWLEDGE',
    guidance: 'The source teaches PRODUCT / AIRLINE KNOWLEDGE (airlines, cabins, aircraft, fares, baggage, lounges, routes, products, features, selling points). Aim for retention plus practical client use: test what an agent needs to recognise, compare and recommend. Cover the FULL source - not only awards or one slide. Test similar products an agent could confuse against each other.',
  },
  SALES_COMMUNICATION: {
    label: 'Sales / communication / mindset',
    practice: 'ROLEPLAY',
    guidance: 'The source teaches SALES / COMMUNICATION / MINDSET (discovery, budget, objections, closing, client conversations, confidence, call control). The skill must be USED in conversation, so a client role-play is the best fit; use an Applied Quiz only when the main purpose is recognising rules, concepts or situations. In a role-play never tell the learner which technique to use - the expected technique stays hidden and is evaluated afterwards.',
  },
  CRM_WORKFLOW: {
    label: 'CRM / workflow / process',
    practice: 'QUIZ',
    guidance: 'The source teaches a CRM / WORKFLOW / PROCESS (statuses, closing reasons, lead handling, follow-up rules, CRM actions, operational decisions). Use realistic workplace situations where the employee chooses the correct action, status or reason. If the employee must perform an ordered sequence of steps rather than make one decision, a process simulation fits better.',
  },
  TECHNICAL: {
    label: 'Technical / GDS / ticketing',
    practice: 'TECHNICAL',
    guidance: 'The source teaches a TECHNICAL / GDS / TICKETING skill (Sabre, commands, fare rules, exchanges, reissues, ticketing, search procedures, technical systems). Test correct APPLICATION - what to do in a concrete situation - not trivia. If the task needs several ordered steps, a process simulation fits better.',
  },
  COMPANY_STANDARD: {
    label: 'Company standard / policy / responsibility',
    practice: 'QUIZ',
    guidance: 'The source is a COMPANY STANDARD / POLICY / RESPONSIBILITY (standards, responsibilities, procedures, disclosures, compliance, required internal rules). Use realistic situations that require the employee to choose the correct action. Avoid pure memorization unless the exact rule itself must be remembered.',
  },
  CALL_SUCCESSFUL: {
    label: 'Call - successful / best practice',
    practice: 'ROLEPLAY',
    guidance: 'The source is a SUCCESSFUL / BEST-PRACTICE CALL whose purpose is to teach other employees what worked. Identify what the agent did well, the important turning points, useful questions and phrasing, the sales decisions, and why the client responded positively - then make the learner recognise and apply those behaviours. Prefer a client role-play for conversational skills and an applied quiz for decision recognition.',
  },
  CALL_IMPROVEMENT: {
    label: 'Call - unsuccessful / improvement',
    practice: 'ROLEPLAY',
    guidance: 'The source is an UNSUCCESSFUL / IMPROVEMENT CALL whose purpose is to find what prevented a better result and practise the missing skill. Identify missed opportunities, weak discovery, objection-handling problems, call-control issues, product/technical gaps, and follow-up or closing problems. Do NOT just ask what happened in the call: make the employee practise what should have been done better, around the one important gap.',
  },
  CALL_INDIVIDUAL: {
    label: 'Individual agent call',
    practice: 'ROLEPLAY',
    guidance: 'The source is an INDIVIDUAL AGENT CALL for that employee\'s personal development. Identify the 1-3 most important improvement areas and build targeted practice around those weaknesses ONLY. Feedback must be constructive, specific and actionable. Do not expose unnecessary personal information or compare the employee with others.',
  },
};

// Practice types by what they are good at (used to decide whether a second practice is justified).
const CLASSIFICATION_KIND = {
  PRODUCT_KNOWLEDGE: 'PRODUCT_KNOWLEDGE', SALES_COMMUNICATION: 'SALES_COMMUNICATION', CUSTOMER_SERVICE: 'SALES_COMMUNICATION',
  TECHNICAL: 'TECHNICAL', PROCESS_SOP: 'CRM_WORKFLOW', COMPLIANCE_POLICY: 'COMPANY_STANDARD', LEADERSHIP_SUPERVISOR: 'COMPANY_STANDARD',
};

// Default size of ONE practice, chosen so it takes about 10-15 minutes. Difficulty is Level 2 unless the creator picks another.
const DEFAULT_COUNT = { QUIZ: 8, TECHNICAL: 8, PRODUCT_KNOWLEDGE: 10, ROLEPLAY: 1, VOICE: 1, PROCESS_SIM: 1 };
const DEFAULT_LEVEL = 2;
const ORDER = ['QUIZ', 'PRODUCT_KNOWLEDGE', 'TECHNICAL', 'PROCESS_SIM', 'ROLEPLAY', 'VOICE'];

/** The closest of the eight source kinds for an analysis (or a call batch's outcome). */
function sourceKindOf(analysis, { callMode = null, callOutcome = null } = {}) {
  const insights = parse(analysis && analysis.insightsJson, {}) || {};
  if (insights.sourceKind && KINDS[insights.sourceKind]) return insights.sourceKind;
  if (callMode === 'INDIVIDUAL_AGENT') return 'CALL_INDIVIDUAL';
  if (callMode === 'BEST_PRACTICE') return callOutcome === 'UNSUCCESSFUL' ? 'CALL_IMPROVEMENT' : 'CALL_SUCCESSFUL';
  const classifications = parse(analysis && analysis.classificationsJson, []) || [];
  for (const c of classifications) if (CLASSIFICATION_KIND[c]) return CLASSIFICATION_KIND[c];
  return null; // MIXED / unknown: the recommended methods decide
}

/**
 * Which practice type best reinforces the kind, given what the analysis recommended. The analysis already ruled
 * out practice the material cannot support, so when the kind's ideal is not among its recommendations the first
 * (best-fit) recommendation is used instead.
 */
function primaryPractice(kind, methods) {
  const ideal = idealPractice(kind, methods);
  return methods.length && !methods.includes(ideal) ? methods.find((m) => ORDER.includes(m)) || ideal : ideal;
}

function idealPractice(kind, methods) {
  const has = (m) => methods.includes(m);
  const conversational = has('ROLEPLAY') || has('VOICE');
  switch (kind) {
    case 'PRODUCT_KNOWLEDGE': return 'PRODUCT_KNOWLEDGE';
    case 'SALES_COMMUNICATION': return conversational ? (has('ROLEPLAY') ? 'ROLEPLAY' : 'VOICE') : has('QUIZ') ? 'QUIZ' : 'ROLEPLAY';
    case 'CRM_WORKFLOW': return has('PROCESS_SIM') && !has('QUIZ') ? 'PROCESS_SIM' : 'QUIZ';
    case 'TECHNICAL': return has('PROCESS_SIM') && !has('TECHNICAL') ? 'PROCESS_SIM' : 'TECHNICAL';
    case 'COMPANY_STANDARD': return 'QUIZ';
    case 'CALL_SUCCESSFUL': case 'CALL_IMPROVEMENT': case 'CALL_INDIVIDUAL': return conversational || !methods.length ? (has('VOICE') && !has('ROLEPLAY') ? 'VOICE' : 'ROLEPLAY') : (has('QUIZ') ? 'QUIZ' : 'ROLEPLAY');
    default: {
      const known = methods.filter((m) => ORDER.includes(m));
      return known.length ? known.slice().sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))[0] : 'QUIZ';
    }
  }
}

/**
 * The plan for a training: normally ONE practice. A second one is added only when the source clearly teaches two
 * different skills that one practice cannot reinforce (two different source kinds, and the analysis recommended the
 * second kind's practice). Returns [{ type, count, level }] in the order the learner meets them.
 */
function planFor(analysis, options = {}) {
  const methods = (parse(analysis && analysis.recommendedMethodsJson, []) || []).filter((m) => ORDER.includes(m));
  const kind = sourceKindOf(analysis, options);
  const first = primaryPractice(kind, methods);
  const picked = [first];
  const classifications = parse(analysis && analysis.classificationsJson, []) || [];
  const kinds = [...new Set(classifications.map((c) => CLASSIFICATION_KIND[c]).filter(Boolean))];
  if (!String(kind || '').startsWith('CALL_') && kinds.length >= 2) {
    const second = kinds.map((k) => primaryPractice(k, methods)).find((t) => t !== first && methods.includes(t));
    if (second) picked.push(second);
  }
  return picked.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)).map((type) => ({ type, count: DEFAULT_COUNT[type], level: DEFAULT_LEVEL }));
}

// ---------------------------------------------------------------------------- prompt blocks
const GENERAL_RULES = [
  'MASTER GENERATION RULES (apply to everything you write):',
  '- AI Practice reinforces training that has ALREADY been delivered: REMEMBER -> RECOGNIZE -> APPLY -> RETAIN. A practice should take about 10-15 minutes and help the employee use the training in real work.',
  '- Create ONE practice for this training; do not pad it with extra material.',
  '- Keep it short, useful and job-related. Prefer realistic client / workplace situations over textbook wording.',
  '- Use ONLY information supported by the training source. Preserve the company\'s terminology from the source. Never invent rules, products, fares, policies or procedures.',
  '- Cover the full relevant source: do not over-focus on one slide, one award, one example or one fact. Avoid repetitive questions.',
  '- Distractors must be plausible - no silly or obviously wrong choices. Similar concepts that employees may confuse must be tested against each other.',
  '- Test understanding and APPLICATION, not whether the learner memorised exact wording.',
  '- Do NOT write questions about which training resource, video or slide the employee should review, or trivia about names, call numbers, dates or irrelevant details.',
  '- Do not give the answer away: nothing in the question, the choices or the feedback shown before answering may reveal the correct one.',
].join('\n');

const ROLEPLAY_RULES = [
  'ROLE-PLAY RULES:',
  '- The learner will see ONLY: the client situation, a realistic opening message, and general skill categories.',
  '- The learner must NOT see: the correct technique, instructions explaining how to solve the scenario, the customer\'s hidden budget or hidden objection, or any technique-specific scoring clue. Put those only in the hidden fields.',
  '- The AI client reacts naturally to what the learner says and does not reveal information too easily: good questions and good technique unlock more information.',
  '- After the role-play the learner receives: what they did well, what they missed, which approach they used, what would have worked better, and one short actionable improvement.',
].join('\n');

const CALL_PRINCIPLE = 'CALL ANALYSIS PRINCIPLE: do not analyse a call only to describe it. Always ask "What should the employee learn or do differently because of this call?" and build the practice around that answer. Do not create trivia about the call, the agent name, the call number or irrelevant details.';

const QUALITY_CHECK = [
  'FINAL QUALITY CHECK - before you answer, verify and fix anything that fails:',
  '1. What is the main learning objective?  2. Which ONE practice type best reinforces it?  3. Does the practice reflect the full relevant source?',
  '4. Will it help the employee perform better at work?  5. Is anything giving away the answer?  6. Is anything being tested that was not in the source?  7. Can it reasonably be completed in 10-15 minutes?',
].join('\n');

/** The rules block appended to a generator's instructions: always the general rules + quality check; the kind's guidance; role-play and call rules when they apply. */
function rulesFor({ kind = null, type = null, call = false } = {}) {
  const parts = [GENERAL_RULES];
  if (kind && KINDS[kind]) parts.push(`SOURCE TYPE: ${KINDS[kind].guidance}`);
  if (type === 'ROLEPLAY' || type === 'VOICE') parts.push(ROLEPLAY_RULES);
  if (call || String(kind || '').startsWith('CALL_')) parts.push(CALL_PRINCIPLE);
  parts.push(QUALITY_CHECK);
  return parts.join('\n\n');
}

module.exports = { KINDS, DEFAULT_COUNT, DEFAULT_LEVEL, GENERAL_RULES, ROLEPLAY_RULES, CALL_PRINCIPLE, QUALITY_CHECK, sourceKindOf, primaryPractice, planFor, rulesFor };
