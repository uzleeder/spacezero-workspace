'use strict';

// The answer key of a choice question, written as the option texts a learner actually picks. Single-choice
// and true/false questions have ONE correct answer; multi-select, ordering and matching have a LIST, saved
// as a real JSON array. Older questions saved that list as one comma-joined string, which split any option
// that itself contains a comma ("Seat selection, meals") - such a string is rebuilt here against the options.
// Used by grading, by everything that saves a question, and by the Admin review (which flags a key that
// cannot be answered).
const SINGLE_TYPES = ['MCQ', 'TRUE_FALSE'];
const LIST_TYPES = ['MULTI_SELECT', 'ORDERING', 'MATCHING'];
const KEYED_TYPES = [...SINGLE_TYPES, ...LIST_TYPES];

const safeParse = (value, fallback) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };
const normalize = (value) => String(value ?? '').trim().toLowerCase();
// How the AI tends to mis-copy an option: different case, spacing or punctuation, or a leading "B)" / "b." / "(c)" label.
const loose = (value) => normalize(value).replace(/^\(?[a-h][).:]\s+/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function optionsOf(type, options) {
  if (Array.isArray(options) && options.length) return options.map(String);
  return type === 'TRUE_FALSE' ? ['True', 'False'] : [];
}

/** The option an answer means: the same text (ignoring case), else the one option it loosely matches; null if none. */
function matchOption(answer, options) {
  const exact = options.find((o) => normalize(o) === normalize(answer));
  if (exact !== undefined) return exact;
  const near = options.filter((o) => loose(o) && loose(o) === loose(answer));
  return near.length === 1 ? near[0] : null;
}

/** A saved list of answers: a real array, or an older comma-joined string rebuilt against the options. */
function listOf(value, options) {
  if (Array.isArray(value)) return value.map(String);
  if (value === null || value === undefined || value === '') return [];
  const text = String(value);
  if (options.length) {
    const rebuilt = [];
    let piece = null;
    for (const part of text.split(',')) {
      piece = piece === null ? part : `${piece},${part}`;
      const option = matchOption(piece, options);
      if (option !== null) { rebuilt.push(option); piece = null; }
    }
    if (piece === null && rebuilt.length) return rebuilt;
  }
  return text.split(',').map((v) => v.trim()).filter(Boolean);
}

function wantedOf(type, value, options) {
  if (SINGLE_TYPES.includes(type)) {
    const one = Array.isArray(value) ? value[0] : value;
    return one === null || one === undefined || one === '' ? [] : [String(one)];
  }
  return listOf(value, options);
}

/**
 * The correct answer(s) of a saved question, as option texts: { answers, problem }. `problem` explains a key
 * nobody can answer correctly (a correct answer that is not one of the options); it is shown in Admin review.
 * Questions answered in free text (SCENARIO, SHORT_ANSWER) return their expected answer as it is.
 */
function keyFor(question) {
  const raw = safeParse(question.correctAnswerJson, question.correctAnswerJson);
  if (!KEYED_TYPES.includes(question.type)) return { answers: Array.isArray(raw) ? raw : [raw], problem: null };
  const options = optionsOf(question.type, safeParse(question.optionsJson, null));
  const wanted = wantedOf(question.type, raw, options);
  if (!wanted.length) return { answers: [], problem: 'This question has no correct answer.' };
  if (!options.length) return { answers: wanted, problem: 'This question has no answer options to choose from.' };
  const matched = wanted.map((a) => matchOption(a, options));
  const missing = wanted.filter((_a, i) => matched[i] === null);
  return {
    answers: matched.map((m, i) => (m === null ? wanted[i] : m)),
    problem: missing.length ? `The correct answer ${missing.map((m) => `"${m}"`).join(', ')} is not one of the options, so nobody can answer this question correctly. Edit it or replace it with AI.` : null,
  };
}

/**
 * Fits an AI-written correct answer to the question's own options BEFORE it is saved (and before the options
 * are shuffled): an answer copied with different case or punctuation, or written as a letter ("B") for the
 * option in that position, becomes the exact option text, and several answers become a real list.
 * Returns { correctAnswer, problem } - `problem` is set when an answer matches no option at all.
 */
function fitToOptions({ type, options, correctAnswer }) {
  if (!KEYED_TYPES.includes(type)) return { correctAnswer, problem: null };
  const opts = optionsOf(type, options);
  const byLetter = (answer) => {
    const m = /^\(?([a-h])[).:]?$/i.exec(String(answer).trim());
    return m && opts[m[1].toLowerCase().charCodeAt(0) - 97] !== undefined ? opts[m[1].toLowerCase().charCodeAt(0) - 97] : null;
  };
  const wanted = wantedOf(type, correctAnswer, opts);
  const fitted = wanted.map((a) => matchOption(a, opts) ?? byLetter(a));
  const problem = !wanted.length || fitted.includes(null) ? 'The correct answer is not one of the options.' : null;
  if (problem) return { correctAnswer, problem };
  return { correctAnswer: SINGLE_TYPES.includes(type) ? fitted[0] : fitted, problem: null };
}

module.exports = { SINGLE_TYPES, LIST_TYPES, KEYED_TYPES, normalize, matchOption, listOf, keyFor, fitToOptions };
