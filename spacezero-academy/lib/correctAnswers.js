'use strict';

// The correct answer of a multi-answer question (MULTI_SELECT, MATCHING, ORDERING) is a LIST of the option texts.
// Older questions, and the AI, store it as one comma-joined string - which cannot be split on commas when an option
// itself contains one ("Doha, Qatar"). This reads either shape back into the real list by matching the question's own
// options, and writes the list form from now on.
const { safeParse } = require('./practiceEngine');

const MULTI = ['MULTI_SELECT', 'MATCHING', 'ORDERING'];
const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/** Cuts a comma-joined string into option texts by matching the options (longest first); null when it cannot be done. */
function partition(text, options) {
  const ordered = [...options].sort((a, b) => b.length - a.length);
  const low = text.toLowerCase();
  function walk(at, used) {
    if (at >= text.length) return [];
    for (const o of ordered) {
      if (used.has(o)) continue;
      const end = at + o.length;
      if (low.startsWith(String(o).toLowerCase(), at) && (end === text.length || /^\s*,\s*/.test(text.slice(end)))) {
        const next = end === text.length ? end : end + text.slice(end).match(/^\s*,\s*/)[0].length;
        const rest = walk(next, new Set([...used, o]));
        if (rest) return [o, ...rest];
      }
    }
    return null;
  }
  return walk(0, new Set());
}

/** The list form of a stored correct answer: an array as stored, or a comma-joined string read back through the options. */
function listOf(value, options = []) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return value == null ? [] : [String(value)];
  const text = value.trim();
  if (!text) return [];
  const opts = Array.isArray(options) ? options.map(String) : [];
  return (opts.length && partition(text, opts)) || text.split(',').map((v) => v.trim()).filter(Boolean);
}

/** What to store for a question's correct answer: the list for multi-answer types, the value itself otherwise. */
function toStored(type, options, correct) {
  return MULTI.includes(type) ? listOf(correct, options) : correct;
}

/** The correct answer of a loaded Question row as the grader and the pages use it. */
function correctOf(question) {
  const value = safeParse(question.correctAnswerJson, null);
  return MULTI.includes(question.type) ? listOf(value, safeParse(question.optionsJson, [])) : value;
}

module.exports = { MULTI, listOf, toStored, correctOf, same };
