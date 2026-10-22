'use strict';

const { prisma } = require('./prisma');

// Organization policies an Admin can change from Settings & Security. Every key has a validator:
// unknown keys and out-of-range values are refused, so a crafted form post can never write
// arbitrary settings or push a setting outside its safe range.
const bool = { default: false, parse: (v) => (typeof v === 'boolean' ? v : undefined) };
const integer = (min, max, fallback) => ({
  default: fallback,
  parse: (v) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : undefined; },
});

const { DEFAULT_ENGINE, DEFAULT_BANDS } = require('./skillEngine');

const SOURCE_KEYS = ['ASSESSMENT', 'PRACTICE', 'CALL_REVIEW', 'MANUAL_ADJUSTMENT'];
const TYPE_KEYS = Object.keys(DEFAULT_ENGINE.typeWeights);
const DEFAULT_SCORING = {
  // How much each source counts (kept for evidence that predates evidence kinds).
  sourceWeights: { ASSESSMENT: 1.0, PRACTICE: 1.2, CALL_REVIEW: 1.3, MANUAL_ADJUSTMENT: 0.8 },
  // How reliable each KIND of evidence is: a quiz answer says less than a role-play or a real call.
  typeWeights: DEFAULT_ENGINE.typeWeights,
  // Harder practice is stronger evidence than easy recall (difficulty levels 1-5).
  difficultyWeights: { 1: 0.8, 2: 0.9, 3: 1.0, 4: 1.15, 5: 1.3 },
  // Evidence loses half its relative weight after this many days.
  halfLifeDays: 90,
  // What it takes for a score to be trusted (LOW / MEDIUM / HIGH evidence confidence).
  confidence: DEFAULT_ENGINE.confidence,
};
const inRange = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const scoring = {
  default: DEFAULT_SCORING,
  parse: (v) => {
    if (!v || typeof v !== 'object') return undefined;
    const sourceWeights = {}; const difficultyWeights = {}; const typeWeights = {};
    for (const k of SOURCE_KEYS) { if (!inRange(v.sourceWeights?.[k], 0.1, 3)) return undefined; sourceWeights[k] = v.sourceWeights[k]; }
    for (const k of [1, 2, 3, 4, 5]) { if (!inRange(v.difficultyWeights?.[k], 0.1, 3)) return undefined; difficultyWeights[k] = v.difficultyWeights[k]; }
    if (!Number.isInteger(v.halfLifeDays) || v.halfLifeDays < 7 || v.halfLifeDays > 730) return undefined;
    for (const k of TYPE_KEYS) {
      const given = v.typeWeights?.[k];
      if (given !== undefined && !inRange(given, 0.1, 3)) return undefined;
      typeWeights[k] = given ?? DEFAULT_ENGINE.typeWeights[k];
    }
    const c = { ...DEFAULT_ENGINE.confidence, ...(v.confidence || {}) };
    if (!inRange(c.mediumMass, 0.5, 20) || !inRange(c.highMass, 1, 40) || c.highMass < c.mediumMass || !Number.isInteger(c.highPractical) || c.highPractical < 0 || c.highPractical > 20 || !Number.isInteger(c.highTypes) || c.highTypes < 1 || c.highTypes > 6 || !inRange(c.minConsistency, 0, 1)) return undefined;
    return { sourceWeights, typeWeights, difficultyWeights, halfLifeDays: v.halfLifeDays, confidence: c };
  },
};

// Skill status bands ("Critical" ... "Strong"): configurable, but always start at 0 and only go up.
const bands = {
  default: DEFAULT_BANDS,
  parse: (v) => {
    if (!Array.isArray(v) || v.length < 2 || v.length > 8) return undefined;
    const out = v.map((b) => ({ min: b?.min, label: typeof b?.label === 'string' ? b.label.trim().slice(0, 30) : '', tone: ['danger', 'warning', 'success', ''].includes(b?.tone) ? b.tone : '' }));
    if (out.some((b) => !Number.isInteger(b.min) || b.min < 0 || b.min > 100 || !b.label)) return undefined;
    out.sort((a, b) => a.min - b.min);
    if (out[0].min !== 0 || new Set(out.map((b) => b.min)).size !== out.length) return undefined;
    return out;
  },
};

// Days after a training is completed at which a follow-up (reinforcement / retention check) is scheduled.
const schedule = {
  default: [7, 30],
  parse: (v) => (Array.isArray(v) && v.length <= 6 && v.every((d) => Number.isInteger(d) && d >= 1 && d <= 365) && new Set(v).size === v.length ? [...v].sort((a, b) => a - b) : undefined),
};

// The one-line description shown directly under the page title of Company Standards & Workflow
// (the page header's description). Plain text; an empty text shows no description.
const DEFAULT_STANDARDS_PAGE_DESCRIPTION = 'SpaceZero Workspace is the company\u2019s internal platform for employee readiness, training and continuous development. It brings company standards, role responsibilities, workflows, AI-powered practice, call review and operational guidance into one place so employees can learn, apply what they learn, improve their skills and perform consistently.';
const standardsPageDescription = {
  default: DEFAULT_STANDARDS_PAGE_DESCRIPTION,
  parse: (v) => (typeof v === 'string' && v.trim().length <= 600 ? v.trim() : undefined),
};

// Keys of the ready-made Standards & Workflow documents (lib/readyStandards.js) that were already offered to this
// organization when the app started - each is added at most ONCE, so an Admin who edits, archives or deletes one
// is never overruled by a later deploy.
const readyProvisioned = {
  default: [],
  parse: (v) => (Array.isArray(v) && v.length <= 100 && v.every((k) => typeof k === 'string' && k.length <= 80) ? [...new Set(v)] : undefined),
};

const SCHEMA = {
  'standards.readyProvisioned': readyProvisioned,
  'setup.selfServiceRelaxed': bool, // internal marker: the one-time "employees confirm their own default Setup items" migration has run
  'standards.pageDescription': standardsPageDescription, // description under the title of the Company Standards & Workflow page
  'credentials.ownerCanView': { ...bool, default: true }, // may a credential's owner reveal their own credentials?
  'leave.supervisorFinalApproval': bool, // may a supervisor approve/reject leave, or only recommend?
  'training.minPassingScore': integer(50, 100, 70), // lowest passing score a mandatory training may use
  'training.retakeWaitMinutes': integer(0, 1440, 10), // minutes a learner waits after failing a practice before trying it again
  'calls.retentionDays': integer(0, 3650, 0), // 0 = keep customer calls until an Admin deletes them
  'scoring.config': scoring, // Skill Graph evidence weighting
  'skills.statusBands': bands, // Critical / Needs Improvement / Developing / Proficient / Strong
  'retention.schedule': schedule, // follow-up days after a training is completed
  'retention.declinePoints': integer(3, 50, 10), // a drop of this many points after training counts as a decline
  'dev.dueSoonDays': integer(1, 30, 3), // "due soon" notification window
  'onboarding.dueDays': integer(1, 180, 14), // onboarding training is due this many days after the employee's start date
};
const DEFAULTS = Object.fromEntries(Object.entries(SCHEMA).map(([k, v]) => [k, v.default]));

async function getSetting(organizationId, key) {
  if (!(key in SCHEMA)) throw new Error(`Unknown setting: ${key}`);
  const row = await prisma.orgSetting.findUnique({ where: { organizationId_key: { organizationId, key } } });
  if (!row) return SCHEMA[key].default;
  try {
    const parsed = SCHEMA[key].parse(JSON.parse(row.valueJson));
    return parsed === undefined ? SCHEMA[key].default : parsed;
  } catch { return SCHEMA[key].default; }
}

async function setSetting(organizationId, key, value, updatedById) {
  if (!(key in SCHEMA)) throw new Error(`Unknown setting: ${key}`);
  const parsed = SCHEMA[key].parse(value);
  if (parsed === undefined) throw new Error(`Invalid value for ${key}`);
  const valueJson = JSON.stringify(parsed);
  return prisma.orgSetting.upsert({
    where: { organizationId_key: { organizationId, key } },
    update: { valueJson, updatedById },
    create: { organizationId, key, valueJson, updatedById },
  });
}

/** True when `value` is acceptable for `key`. Lets a multi-field form check everything before writing anything. */
function isValidSetting(key, value) { return key in SCHEMA && SCHEMA[key].parse(value) !== undefined; }

module.exports = { DEFAULTS, DEFAULT_SCORING, DEFAULT_BANDS, SOURCE_KEYS, TYPE_KEYS, getSetting, setSetting, isValidSetting };