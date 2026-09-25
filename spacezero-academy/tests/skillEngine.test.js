'use strict';
// The Skill Score Engine is pure and deterministic; these tests pin down the behaviour the product
// promises: practical evidence outweighs theory, confidence is separate from the score, nothing is invented.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../lib/skillEngine');

const NOW = new Date('2026-09-20T12:00:00Z');
const daysAgo = (d) => new Date(NOW.getTime() - d * 86400000);
const ev = (assessmentType, score, days = 1, difficulty = 3) => ({ assessmentType, sourceType: 'PRACTICE', scoreImpact: score, difficulty, createdAt: daysAgo(days) });
const compute = (list) => engine.computeSkill(list, engine.DEFAULT_ENGINE, NOW);

test('no evidence gives no score and NONE confidence (nothing is invented)', () => {
  const r = compute([]);
  assert.equal(r.score, null); assert.equal(r.confidence.level, 'NONE'); assert.equal(r.evidenceCount, 0);
  assert.equal(engine.statusFor(null).label, 'Not assessed');
  // evidence without a numeric score (a note) does not create a score either
  assert.equal(compute([{ assessmentType: 'MANUAL', sourceType: 'MANUAL_ADJUSTMENT', scoreImpact: null, createdAt: daysAgo(1) }]).score, null);
});

test('one lucky quiz is a high score with LOW confidence — never HIGH', () => {
  const r = compute([ev('QUIZ', 92)]);
  assert.equal(r.score, 92); assert.equal(r.confidence.level, 'LOW');
  assert.match(r.confidence.reasons.join(' '), /single observation/i);
});

test('ACCEPTANCE 37: quiz 95%, role-play 62% and five weak analyzed calls do NOT display 95%', () => {
  const r = compute([ev('QUIZ', 95, 10), ev('ROLEPLAY', 62, 8), ...[35, 40, 30, 38, 42].map((s, i) => ev('CALL_ANALYSIS', s, 2 + i))]);
  assert.ok(r.score < 55, `score should follow the practical evidence, got ${r.score}`);
  assert.ok(r.score >= 30);
  // Plenty of practical evidence, but the 95% quiz disagrees with everything else: trusted, though not HIGH.
  assert.equal(r.confidence.level, 'MEDIUM'); assert.match(r.confidence.reasons.join(' '), /conflicts/);
  const consistent = compute([ev('QUIZ', 45, 10), ev('ROLEPLAY', 52, 8), ...[35, 40, 30, 38, 42].map((s, i) => ev('CALL_ANALYSIS', s, 2 + i))]);
  assert.equal(consistent.confidence.level, 'HIGH'); // the same amount of evidence, all telling the same story
  assert.deepEqual(r.kinds, { QUIZ: 1, ROLEPLAY: 1, CALL_ANALYSIS: 5 });
  assert.equal(engine.describeBasis(r.kinds), '5 analyzed real calls, 1 quiz and 1 role-play');
  // the score is explainable: every piece of evidence has a weight, a recency factor and a share of the result
  assert.equal(r.explain.length, 7); assert.ok(Math.abs(r.explain.reduce((n, x) => n + x.share, 0) - 1) < 1e-9);
  const call = r.explain.find((x) => x.kind === 'CALL_ANALYSIS'); const quiz = r.explain.find((x) => x.kind === 'QUIZ');
  assert.ok(call.weight > quiz.weight); assert.ok(call.practical && !quiz.practical);
});

test('practical evidence outweighs theory for the same score gap', () => {
  const theory = compute([ev('QUIZ', 90), ev('ROLEPLAY', 50)]).score;
  const practicalHeavy = compute([ev('QUIZ', 50), ev('ROLEPLAY', 90)]).score;
  assert.ok(practicalHeavy > 70 && theory < 70, `${theory} vs ${practicalHeavy}`);
});

test('confidence grows with meaningful evidence: LOW -> MEDIUM -> HIGH, and theory alone is capped below HIGH', () => {
  assert.equal(compute([ev('QUIZ', 80)]).confidence.level, 'LOW');
  assert.equal(compute([ev('QUIZ', 80), ev('ROLEPLAY', 78)]).confidence.level, 'MEDIUM');
  assert.equal(compute([ev('QUIZ', 80), ev('ROLEPLAY', 78), ev('ROLEPLAY', 82), ev('CALL_ANALYSIS', 79)]).confidence.level, 'HIGH');
  const theoryOnly = compute(Array.from({ length: 12 }, (_, i) => ev('QUIZ', 85, i + 1)));
  assert.notEqual(theoryOnly.confidence.level, 'HIGH');
  assert.match(theoryOnly.confidence.reasons.join(' '), /No practical evidence/);
});

test('conflicting evidence lowers confidence (not the score), very old evidence counts for little', () => {
  const agree = compute([ev('ROLEPLAY', 70), ev('ROLEPLAY', 72), ev('CALL_ANALYSIS', 71), ev('CALL_ANALYSIS', 69)]);
  const conflict = compute([ev('ROLEPLAY', 95), ev('ROLEPLAY', 30), ev('CALL_ANALYSIS', 92), ev('CALL_ANALYSIS', 28)]);
  assert.equal(agree.confidence.level, 'HIGH'); assert.notEqual(conflict.confidence.level, 'HIGH');
  assert.match(conflict.confidence.reasons.join(' '), /conflicts/);
  const old = compute([ev('ROLEPLAY', 20, 900), ev('ROLEPLAY', 85, 2)]);
  assert.ok(old.score > 80, `a two-year-old failure should barely matter, got ${old.score}`);
  assert.equal(compute([ev('ROLEPLAY', 80, 900)]).confidence.level, 'LOW'); // only very old evidence: little confidence
});

test('difficulty matters: a hard scenario is stronger evidence than an easy one', () => {
  const r = compute([ev('ROLEPLAY', 40, 1, 1), ev('ROLEPLAY', 80, 1, 5)]);
  assert.ok(r.score > 60);
});

test('deterministic: the same evidence and configuration always give the same result (order does not matter)', () => {
  const list = [ev('QUIZ', 60, 5), ev('ROLEPLAY', 75, 3), ev('CALL_ANALYSIS', 68, 1)];
  const a = compute(list); const b = compute([...list].reverse());
  assert.equal(a.score, b.score); assert.equal(a.confidence.level, b.confidence.level);
  assert.equal(engine.ENGINE_VERSION, 2);
});

test('configuration changes the result (configurable and testable): heavier quiz weight raises a quiz-heavy score', () => {
  const list = [ev('QUIZ', 95, 1), ev('ROLEPLAY', 50, 1)];
  const base = engine.computeSkill(list, engine.DEFAULT_ENGINE, NOW).score;
  const heavy = engine.computeSkill(list, { ...engine.DEFAULT_ENGINE, typeWeights: { ...engine.DEFAULT_ENGINE.typeWeights, QUIZ: 3 } }, NOW).score;
  assert.ok(heavy > base);
});

test('status bands: 0-49 Critical, 50-69 Needs Improvement, 70-79 Developing, 80-89 Proficient, 90-100 Strong — and are configurable', () => {
  const at = (s) => engine.statusFor(s).label;
  assert.deepEqual([0, 49, 50, 69, 70, 79, 80, 89, 90, 100].map(at), ['Critical', 'Critical', 'Needs Improvement', 'Needs Improvement', 'Developing', 'Developing', 'Proficient', 'Proficient', 'Strong', 'Strong']);
  const custom = [{ min: 0, label: 'Low' }, { min: 60, label: 'OK' }, { min: 85, label: 'Great' }];
  assert.deepEqual([10, 60, 84, 85].map((s) => engine.statusFor(s, custom).label), ['Low', 'OK', 'OK', 'Great']);
});

test('trend and timeline come from history: improving, declining, stable, stagnant; the original score is preserved', () => {
  const h = (score, days) => ({ score, recordedAt: daysAgo(days) });
  const climb = [h(46, 100), h(58, 70), h(71, 40), h(84, 1)];
  const t = engine.trendOf(climb, { now: NOW });
  assert.equal(t.direction, 'improving'); assert.equal(t.delta, 13); assert.equal(t.from, 71);
  assert.equal(engine.trendOf([h(80, 60), h(70, 1)], { now: NOW }).direction, 'declining');
  assert.equal(engine.trendOf([h(70, 40), h(72, 1)], { now: NOW }).direction, 'stable');
  assert.equal(engine.trendOf([h(70, 300), h(71, 200)], { now: NOW }).direction, 'stagnant');
  assert.equal(engine.trendOf([h(70, 1)], { now: NOW }).direction, 'new');
  const timeline = engine.monthlyTimeline([h(46, 100), h(50, 95), h(58, 70), h(71, 40), h(84, 1)]);
  assert.equal(timeline[0].score === 50 || timeline[0].score === 46, true);
  assert.ok(timeline.length >= 3); assert.equal(timeline.at(-1).score, 84);
});

test('failed retakes stay in the evidence: a failure followed by a pass is a blend, not an overwrite', () => {
  const r = compute([ev('ROLEPLAY', 40, 10), ev('ROLEPLAY', 85, 1)]);
  assert.equal(r.evidenceCount, 2); assert.ok(r.score > 40 && r.score < 85);
});
