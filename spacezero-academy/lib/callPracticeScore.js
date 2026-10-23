'use strict';

// Call Practice scoring: how closely a trainee's typed transcript matches the call's answer key, word by word.
// Deterministic - no AI per trainee. Both texts are reduced to plain words (no "Agent:" / "Client:" labels, no
// [number] placeholders, no punctuation, any case) and lined up with the fewest changes: a word-level edit distance.
// Accuracy = the share of the answer key's words typed right, less one for every word missed, typed differently or
// added. Pure functions over strings, so the pages and their tests never need the database.

const LABEL = /^\s*(agent|client|customer|speaker|unknown)\s*:\s*/i;
const TOKEN = /\[[^\]]*\]|\S+/g; // a [placeholder] is one token even with spaces inside
const SAME = { okay: 'ok' };
const MAX_CELLS = 16e6; // above this (two very long texts) the score is still exact, only the highlighting is skipped

/** The scored words of one piece of text: lower case, letters / digits / apostrophes only. */
function normalize(token) {
  if (/^\[.*\]$/.test(token)) return [];
  return token.toLowerCase().replace(/[’‘`]/g, "'").split(/[^\p{L}\p{N}']+/u)
    .map((w) => w.replace(/^'+|'+$/g, '')).filter(Boolean).map((w) => SAME[w] || w);
}

/** Line by line: { speaker ('Agent', 'Client' or null), tokens: [{ text, words }] } - words are what each token scores as. */
function linesOf(text) {
  return String(text || '').split(/\r?\n/).map((line) => {
    const label = line.match(LABEL);
    const body = label ? line.slice(label[0].length) : line;
    const speaker = label ? (/^(client|customer)$/i.test(label[1]) ? 'Client' : /^agent$/i.test(label[1]) ? 'Agent' : 'Speaker') : null;
    return { speaker, tokens: (body.match(TOKEN) || []).map((t) => ({ text: t, words: normalize(t) })) };
  }).filter((l) => l.speaker || l.tokens.length);
}

const wordsOf = (text) => linesOf(text).flatMap((l) => l.tokens.flatMap((t) => t.words));

/**
 * Lines up two word lists with the fewest changes. Returns { errors, correct, missed, wrong, extra, ops } where ops
 * (null when the texts are too long to keep the table) is one entry per step: { op: 'ok' | 'sub' | 'del' | 'ins', r, h }
 * with r / h the index into the answer key / the typed words.
 */
function align(ref, hyp) {
  const n = ref.length; const m = hyp.length;
  const keep = (n + 1) * (m + 1) <= MAX_CELLS;
  const dir = keep ? new Uint8Array((n + 1) * (m + 1)) : null; // 0 ok/sub (diagonal), 1 del (up), 2 ins (left)
  let prev = new Uint32Array(m + 1); let row = new Uint32Array(m + 1);
  for (let j = 0; j <= m; j += 1) { prev[j] = j; if (keep) dir[j] = 2; }
  for (let i = 1; i <= n; i += 1) {
    row[0] = i; if (keep) dir[i * (m + 1)] = 1;
    for (let j = 1; j <= m; j += 1) {
      const diag = prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      const up = prev[j] + 1; const left = row[j - 1] + 1;
      let best = diag; let d = 0;
      if (up < best) { best = up; d = 1; }
      if (left < best) { best = left; d = 2; }
      row[j] = best; if (keep) dir[i * (m + 1) + j] = d;
    }
    [prev, row] = [row, prev];
  }
  const errors = prev[m];
  if (!keep) {
    // without the table the kinds of mistakes are not known; the total is exact
    return { errors, correct: Math.max(0, n - errors), missed: null, wrong: null, extra: null, ops: null };
  }
  const ops = [];
  let i = n; let j = m;
  while (i > 0 || j > 0) {
    const d = i > 0 && j > 0 ? dir[i * (m + 1) + j] : i > 0 ? 1 : 2;
    if (d === 0) { ops.push({ op: ref[i - 1] === hyp[j - 1] ? 'ok' : 'sub', r: i - 1, h: j - 1 }); i -= 1; j -= 1; }
    else if (d === 1) { ops.push({ op: 'del', r: i - 1, h: null }); i -= 1; }
    else { ops.push({ op: 'ins', r: null, h: j - 1 }); j -= 1; }
  }
  ops.reverse();
  const count = (op) => ops.filter((o) => o.op === op).length;
  return { errors, correct: count('ok'), missed: count('del'), wrong: count('sub'), extra: count('ins'), ops };
}

/** Accuracy 0-100 (one decimal), or null when the answer key has no words. */
function accuracyOf(errors, refCount) {
  if (!refCount) return null;
  return Math.round(Math.max(0, (refCount - errors) / refCount) * 1000) / 10;
}

/** Words a minute of typing, or null when too little typing time was measured to say. */
function wordsPerMinute(wordCount, typingSeconds) {
  if (!wordCount || !(typingSeconds >= 20)) return null;
  return Math.round(Math.min(200, wordCount / (typingSeconds / 60)) * 10) / 10;
}

/** The score of a transcript against the answer key. */
function scoreTranscript(referenceText, typedText, typingSeconds = 0) {
  const ref = wordsOf(referenceText); const hyp = wordsOf(typedText);
  const result = align(ref, hyp);
  return {
    wordCount: hyp.length, referenceWords: ref.length,
    accuracy: accuracyOf(result.errors, ref.length),
    wordsPerMinute: wordsPerMinute(hyp.length, typingSeconds),
    correct: result.correct, missed: result.missed, wrong: result.wrong, extra: result.extra,
  };
}

/**
 * The answer key ready to show after submitting: its lines, each token marked 'ok', 'missed' (left out or typed
 * differently - `typed` then says what was typed instead) or 'skip' (a placeholder or punctuation, never scored).
 * Returns null when the texts are too long to highlight.
 */
function markedAnswerKey(referenceText, typedText) {
  const lines = linesOf(referenceText);
  const ref = []; const owners = []; // each scored word of the answer key, and the token it belongs to
  for (const line of lines) {
    for (const token of line.tokens) {
      token.state = token.words.length ? 'ok' : 'skip';
      for (const word of token.words) { ref.push(word); owners.push(token); }
    }
  }
  const hyp = wordsOf(typedText);
  const { ops } = align(ref, hyp);
  if (!ops) return null;
  // a token holding several words (check-in) is marked when any of them is off
  for (const o of ops) {
    if (o.op !== 'del' && o.op !== 'sub') continue;
    const token = owners[o.r];
    token.state = 'missed';
    if (o.op === 'sub') token.typed = token.typed ? `${token.typed} ${hyp[o.h]}` : hyp[o.h];
  }
  return lines.map((l) => ({ speaker: l.speaker, tokens: l.tokens.map((t) => ({ text: t.text, state: t.state, typed: t.typed || null })) }));
}

module.exports = { normalize, linesOf, wordsOf, align, accuracyOf, wordsPerMinute, scoreTranscript, markedAnswerKey, MAX_CELLS };
