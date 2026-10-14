'use strict';

// The AI tends to write the correct answer first ("A"). Answer choices are therefore stirred before a
// question is saved, and again - with a fixed seed per question - when a learner opens an older quiz
// that was saved in the AI's order. Grading compares the answer TEXT, so the order never matters to it.
// "All of the above" / "None of these" style choices stay at the end where they make sense.
const SHUFFLED_TYPES = ['MCQ', 'MULTI_SELECT', 'SCENARIO', 'SHORT_ANSWER', 'MATCHING', 'ORDERING'];
const ANCHORED = /^(all|none|both|neither|any|every)\s+of\s+(the\s+)?(above|these|them|those|the\s+options)\b|^(a|b|c|d|e)\s*(,|and|&)\s*(a|b|c|d|e)\b\.?$/i;

function shuffleWith(items, rng) {
  const list = [...items];
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/** Same options in a different order; the anchored ones ("All of the above") keep their place at the end. */
function stir(options, rng, textOf = (o) => String(o)) {
  if (!Array.isArray(options) || options.length < 2) return options;
  const anchored = options.filter((o) => ANCHORED.test(textOf(o).trim()));
  const loose = options.filter((o) => !ANCHORED.test(textOf(o).trim()));
  if (loose.length < 2) return options;
  let order = shuffleWith(loose, rng);
  // never hand back the very order the AI wrote (a few tries is plenty; the odds of a repeat are tiny)
  for (let tries = 0; tries < 5 && order.every((o, i) => o === loose[i]); tries += 1) order = shuffleWith(loose, rng);
  return [...order, ...anchored];
}

/** Stirs the options of a question the AI just wrote (random each time). */
function shuffleOptions(type, options, rng = Math.random) {
  return SHUFFLED_TYPES.includes(type) ? stir(options, rng) : options;
}

/** Workflow-simulation choices ({ label, score, nextId, ... }): same idea, so the best action is not always the first one. */
function shuffleChoices(choices, rng = Math.random) { return stir(choices, rng, (c) => String((c && c.label) || '')); }

function seededRandom(seed) {
  let h = 1779033703 ^ String(seed).length;
  for (let i = 0; i < String(seed).length; i += 1) { h = Math.imul(h ^ String(seed).charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** The order a learner sees: stable for one question (a refresh shows the same order), different between questions. */
function displayOptions(question, options) {
  return shuffleOptions(question.type, options, seededRandom(question.id || question.prompt));
}

module.exports = { shuffleOptions, shuffleChoices, displayOptions, seededRandom, SHUFFLED_TYPES };
