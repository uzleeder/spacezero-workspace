'use strict';

// The Skill Score Engine (Phase 3). PURE and DETERMINISTIC: the same evidence and the same
// configuration always give the same result, so every number on screen can be recomputed and explained.
//
//   * The AI never produces a skill score. It produces structured assessment evidence (a 0-100 score
//     for one skill from one attempt or call); this file turns evidence into a competency score.
//   * score      = weighted mean of the evidence scores, weight = type x difficulty x recency
//   * confidence = how much the score can be trusted (LOW / MEDIUM / HIGH), from the amount, the
//                  practical-ness, the diversity, the recency and the consistency of the evidence
//   * status     = a configurable band ("Critical" ... "Strong") — separate from the 70% TRAINING PASS mark
//   * trend      = from the stored score history (never from the evidence alone)
//
// ENGINE_VERSION changes whenever the maths changes; every history row records the version it used.
const ENGINE_VERSION = 2;

// Evidence kinds. Practical evidence (someone actually performing the skill) is more reliable than
// theoretical evidence (answering a question about it).
const PRACTICAL_TYPES = ['ROLEPLAY', 'VOICE', 'TECHNICAL', 'PROCESS_SIM', 'CALL_ANALYSIS', 'SUPERVISOR_ASSESSMENT'];
const TYPE_LABEL = {
  QUIZ: 'quiz', PRODUCT_KNOWLEDGE: 'product-knowledge exercise', TECHNICAL: 'technical simulation', PROCESS_SIM: 'process simulation',
  ROLEPLAY: 'role-play', VOICE: 'voice practice', CALL_ANALYSIS: 'analyzed real call', SUPERVISOR_ASSESSMENT: 'supervisor assessment', MANUAL: 'manual note',
};
const SOURCE_FALLBACK_TYPE = { ASSESSMENT: 'QUIZ', PRACTICE: 'ROLEPLAY', CALL_REVIEW: 'CALL_ANALYSIS', MANUAL_ADJUSTMENT: 'MANUAL' };

const DEFAULT_ENGINE = {
  version: ENGINE_VERSION,
  // Older evidence that only knows its source (not what was done) uses these.
  sourceWeights: { ASSESSMENT: 1.0, PRACTICE: 1.2, CALL_REVIEW: 1.3, MANUAL_ADJUSTMENT: 0.8 },
  // Reliability of each kind of evidence (multiplies the weight).
  typeWeights: { QUIZ: 0.7, PRODUCT_KNOWLEDGE: 0.8, TECHNICAL: 1.1, PROCESS_SIM: 1.1, ROLEPLAY: 1.3, VOICE: 1.2, CALL_ANALYSIS: 1.3, SUPERVISOR_ASSESSMENT: 1.2, MANUAL: 0.8 },
  difficultyWeights: { 1: 0.8, 2: 0.9, 3: 1.0, 4: 1.15, 5: 1.3 },
  halfLifeDays: 90,
  confidence: {
    mediumMass: 1.5, // effective evidence mass needed for MEDIUM
    highMass: 4, // ... for HIGH
    highPractical: 2, // practical observations needed for HIGH
    highTypes: 2, // distinct kinds of evidence needed for HIGH
    minConsistency: 0.6, // HIGH needs the evidence to agree with itself (0-1)
  },
};

const DEFAULT_BANDS = [
  { min: 0, label: 'Critical', tone: 'danger' },
  { min: 50, label: 'Needs Improvement', tone: 'warning' },
  { min: 70, label: 'Developing', tone: 'warning' },
  { min: 80, label: 'Proficient', tone: 'success' },
  { min: 90, label: 'Strong', tone: 'success' },
];

const DAY_MS = 86400000;

/** The evidence "kind" used for weighting: what was actually done, falling back to where it came from. */
function evidenceKind(e) {
  return e.assessmentType || SOURCE_FALLBACK_TYPE[e.sourceType] || 'MANUAL';
}

const isPractical = (kind) => PRACTICAL_TYPES.includes(kind);

function recency(createdAt, now, halfLifeDays) {
  const age = Math.max(0, (now - new Date(createdAt)) / DAY_MS);
  return Math.pow(0.5, age / halfLifeDays);
}

/**
 * How reliable this kind of evidence is. Evidence that says what was done (assessmentType) uses the
 * per-kind weight; older evidence that only knows its source falls back to the per-source weight.
 */
function kindWeight(e, config = DEFAULT_ENGINE) {
  if (e.assessmentType) return config.typeWeights[e.assessmentType] ?? 1;
  return config.sourceWeights?.[e.sourceType] ?? config.typeWeights[evidenceKind(e)] ?? 1;
}

/** Weight of one piece of evidence BEFORE recency: kind reliability x difficulty. */
function baseWeight(e, config = DEFAULT_ENGINE) {
  const difficulty = config.difficultyWeights[e.difficulty] ?? config.difficultyWeights[3];
  return kindWeight(e, config) * difficulty;
}

/**
 * Computes everything about one skill from its evidence.
 * @param evidence rows with { scoreImpact (0-100), assessmentType, sourceType, difficulty, createdAt, notes?, id? }
 * @returns { score, confidence, evidenceCount, kinds, explain[], lastEvidenceAt, ... } — score is null with no scored evidence.
 */
function computeSkill(evidence, config = DEFAULT_ENGINE, now = new Date()) {
  const scored = evidence.filter((e) => typeof e.scoreImpact === 'number' && Number.isFinite(e.scoreImpact));
  if (!scored.length) return { score: null, confidence: { level: 'NONE', reasons: ['No scored evidence yet.'] }, evidenceCount: 0, kinds: {}, explain: [], lastEvidenceAt: null };

  const explain = scored.map((e) => {
    const kind = evidenceKind(e);
    const weight = baseWeight(e, config);
    const rec = recency(e.createdAt, now, config.halfLifeDays);
    return { id: e.id || null, kind, practical: isPractical(kind), score: Math.max(0, Math.min(100, e.scoreImpact)), difficulty: e.difficulty || null, weight, recency: rec, effective: weight * rec, createdAt: e.createdAt, notes: e.notes || null };
  });
  const totalEffective = explain.reduce((n, x) => n + x.effective, 0);
  const score = totalEffective > 0 ? Math.round(explain.reduce((n, x) => n + x.score * x.effective, 0) / totalEffective) : 0;
  explain.forEach((x) => { x.share = totalEffective > 0 ? x.effective / totalEffective : 0; });

  // ---- confidence
  const cfg = config.confidence;
  const massByRow = scored.map((e, i) => kindWeight(e, config) * explain[i].recency);
  const mass = massByRow.reduce((n, x) => n + x, 0); // amount + quality + recency, not difficulty
  const practical = explain.filter((x) => x.practical).length;
  const kinds = {};
  for (const x of explain) kinds[x.kind] = (kinds[x.kind] || 0) + 1;
  const distinct = Object.keys(kinds).length;
  const mean = explain.reduce((n, x) => n + x.score, 0) / explain.length;
  const stdev = Math.sqrt(explain.reduce((n, x) => n + Math.pow(x.score - mean, 2), 0) / explain.length);
  const consistency = explain.length < 2 ? 1 : Math.max(0, 1 - stdev / 40);

  let level = 'LOW';
  const reasons = [];
  if (mass >= cfg.mediumMass && (practical >= 1 || explain.length >= 3)) level = 'MEDIUM';
  if (mass >= cfg.highMass && practical >= cfg.highPractical && distinct >= cfg.highTypes && consistency >= cfg.minConsistency) level = 'HIGH';
  if (level === 'LOW') reasons.push(explain.length === 1 ? 'Based on a single observation.' : 'Not enough recent, reliable evidence yet.');
  if (level !== 'HIGH') {
    if (practical === 0) reasons.push('No practical evidence (role-play, simulation or real call) yet — theory alone cannot give high confidence.');
    else if (practical < cfg.highPractical) reasons.push('More practical observations would raise confidence.');
    if (distinct < cfg.highTypes) reasons.push('Only one kind of evidence so far.');
  }
  if (consistency < cfg.minConsistency && explain.length >= 2) reasons.push('The evidence conflicts (results vary a lot), so the score is less certain.');
  if (mass < cfg.mediumMass) reasons.push('Little recent evidence; older evidence counts for less.');

  const last = explain.reduce((max, x) => (new Date(x.createdAt) > max ? new Date(x.createdAt) : max), new Date(0));
  return {
    score,
    confidence: { level, mass: Number(mass.toFixed(2)), practical, distinct, consistency: Number(consistency.toFixed(2)), reasons },
    evidenceCount: explain.length,
    kinds,
    explain: explain.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
    lastEvidenceAt: last,
  };
}

/** Status band for a score, from a configurable list of { min, label } bands. */
function statusFor(score, bands = DEFAULT_BANDS) {
  if (score === null || score === undefined) return { label: 'Not assessed', tone: '', min: null };
  const sorted = [...bands].sort((a, b) => a.min - b.min);
  let hit = sorted[0];
  for (const band of sorted) if (score >= band.min) hit = band;
  return hit;
}

/**
 * Trend from the stored score history ([{ score, recordedAt }], any order).
 * Compares the newest point with the newest point that is at least `windowDays` older
 * (or the very first point when the history is shorter than the window).
 */
function trendOf(history, { now = new Date(), windowDays = 30, threshold = 5 } = {}) {
  const points = [...history].filter((h) => typeof h.score === 'number').sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));
  if (points.length < 2) return { direction: 'new', delta: 0, from: null, since: null };
  const latest = points[points.length - 1];
  const cutoff = new Date(new Date(latest.recordedAt).getTime() - windowDays * DAY_MS);
  const older = points.filter((p) => new Date(p.recordedAt) <= cutoff);
  const base = older.length ? older[older.length - 1] : points[0];
  if (base === latest) return { direction: 'new', delta: 0, from: null, since: null };
  const delta = Math.round(latest.score - base.score);
  const stale = (now - new Date(latest.recordedAt)) / DAY_MS > 90;
  const direction = delta >= threshold ? 'improving' : delta <= -threshold ? 'declining' : stale ? 'stagnant' : 'stable';
  return { direction, delta, from: Math.round(base.score), since: base.recordedAt };
}

/** One point per calendar month (the last score of that month) for the timeline chart. */
function monthlyTimeline(history) {
  const byMonth = new Map();
  for (const h of [...history].sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt))) {
    const d = new Date(h.recordedAt);
    byMonth.set(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`, Math.round(h.score));
  }
  return [...byMonth.entries()].map(([month, score]) => ({ month, score }));
}

/** Human explanation of what the numbers are based on, e.g. "4 role-plays, 7 analyzed real calls and 2 quizzes". */
function describeBasis(kinds) {
  const parts = Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([kind, n]) => `${n} ${TYPE_LABEL[kind] || kind.toLowerCase()}${n === 1 ? '' : kind === 'ROLEPLAY' ? 's' : 's'}`);
  if (!parts.length) return 'no evidence yet';
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

module.exports = { ENGINE_VERSION, DEFAULT_ENGINE, DEFAULT_BANDS, PRACTICAL_TYPES, TYPE_LABEL, evidenceKind, isPractical, kindWeight, baseWeight, recency, computeSkill, statusFor, trendOf, monthlyTimeline, describeBasis };
