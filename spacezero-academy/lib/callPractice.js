'use strict';

// Call Practice: during their first months new agents listen to real client calls and type every word they hear - the
// whole conversation, agent and client. Typing what you hear keeps you listening, and it builds typing speed.
//   * An Admin uploads the calls (Manage Training -> Call Practice). Each one gets an answer key: made once by the AI
//     from the recording (the same transcription the call analysis uses, numbers removed), correctable by the Admin.
//   * Who: Travel Agents and Flight Experts in the organization's first tenure band ("New Agent", 0-3 months by
//     default - Settings), counted from their start date. Nothing is assigned; it starts on day one.
//   * Every trainee hears the same calls in the same order, at most callPractice.callsPerDay a day - in the New Agent
//     Program, that week's number instead (lib/newAgentPlan.js callsOn). A missed day never piles up: the next call
//     simply waits. A call is only offered once its answer key is ready.
//   * Scoring is lib/callPracticeScore.js (word by word, no AI per trainee).
// planOf() is pure, so the pages and their tests decide "what is open today" the same way.
const { prisma } = require('./prisma');
const { getSetting } = require('./orgSettings');
const { monthsSince } = require('./tenure');
const { registerJobType, STUCK_AFTER_MS } = require('./jobQueue');
const { scoreTranscript } = require('./callPracticeScore');

const ROLES = ['TRAVEL_AGENT', 'FLIGHT_EXPERT'];
const FALLBACK_MONTHS = 3; // only when the organization has no tenure band starting at 0 months
const TIME_ZONE = 'Asia/Tashkent'; // the company's working day (lib/birthdays.js)
const MIN_WORDS = 10; // a transcript needs at least this many words to be submitted
const MAX_TEXT = 100000;

const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
/** The calendar day (Tashkent) a moment falls on, as YYYY-MM-DD. */
const dayKey = (date) => dayFormat.format(new Date(date));

/** The new-agent window: the first tenure band (it starts at 0 months). { label, months } - months null = no end. */
function newAgentWindow(bands) {
  const first = [...(bands || [])].sort((a, b) => a.minMonths - b.minMonths)[0];
  if (!first || first.minMonths !== 0) return { label: null, months: FALLBACK_MONTHS };
  return { label: first.label, months: first.maxMonths ?? null };
}

/** May this person do Call Practice now? Active Travel Agents and Flight Experts inside the new-agent window. */
function isEligible(profile, window) {
  if (!profile || !ROLES.includes(profile.role) || profile.status !== 'ACTIVE' || !profile.employmentStartDate) return false;
  if (window.months === null) return true;
  return monthsSince(new Date(profile.employmentStartDate)) < window.months;
}

/**
 * Where a trainee stands. calls = the calls they can see, in order (open ones with a ready answer key, plus any they
 * already did); transcripts = their rows. Returns the numbered items, the next call, and whether it is open today:
 * it is when fewer than perDay calls were submitted today - or when the trainee already started it.
 */
function planOf({ calls, transcripts, perDay, now = new Date() }) {
  const byCall = new Map(transcripts.map((t) => [t.callId, t]));
  const today = dayKey(now);
  const doneToday = transcripts.filter((t) => t.submittedAt && dayKey(t.submittedAt) === today).length;
  const items = calls.map((call, i) => {
    const transcript = byCall.get(call.id) || null;
    return { call, number: i + 1, transcript, done: Boolean(transcript && transcript.submittedAt) };
  });
  const done = items.filter((i) => i.done);
  const next = items.find((i) => !i.done) || null;
  const started = Boolean(next && next.transcript);
  const scored = done.filter((i) => i.transcript.accuracy != null);
  const timed = done.filter((i) => i.transcript.wordsPerMinute != null);
  const average = (rows, key) => (rows.length ? Math.round(rows.reduce((sum, r) => sum + r.transcript[key], 0) / rows.length) : null);
  return {
    items, done, next, started,
    open: Boolean(next) && (doneToday < perDay || started),
    perDay, doneToday,
    total: items.length, doneCount: done.length,
    averageAccuracy: average(scored, 'accuracy'),
    averageWpm: average(timed, 'wordsPerMinute'),
    accuracyTrend: scored.slice(-10).map((i) => Math.round(i.transcript.accuracy)),
  };
}

async function windowFor(organizationId) {
  return newAgentWindow(await prisma.tenureBand.findMany({ where: { organizationId } }));
}

/** The calls one person sees, in order: the open ones whose answer key is ready, and any they already submitted. */
function callsFor(profile) {
  return prisma.practiceCall.findMany({
    where: { organizationId: profile.organizationId, OR: [{ archivedAt: null, referenceStatus: 'READY' }, { transcripts: { some: { profileId: profile.id, submittedAt: { not: null } } } }] },
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, title: true, note: true, durationSeconds: true, archivedAt: true },
  });
}

/** Everything the pages need about one person: { window, eligible, plan }. */
async function stateFor(profile, now = new Date()) {
  const [window, setting, programCalls, calls, transcripts] = await Promise.all([
    windowFor(profile.organizationId),
    getSetting(profile.organizationId, 'callPractice.callsPerDay'),
    require('./newAgentProgram').callsQuota(profile, now), // in the New Agent Program: that week's number of calls
    callsFor(profile),
    prisma.practiceCallTranscript.findMany({ where: { profileId: profile.id } }),
  ]);
  return { window, eligible: isEligible(profile, window), plan: planOf({ calls, transcripts, perDay: programCalls ?? setting, now }) };
}

/** For the line on My Training: null unless the person is in Call Practice and there is at least one call. */
async function summaryFor(profile) {
  if (!ROLES.includes(profile.role)) return null;
  const state = await stateFor(profile);
  return state.eligible && state.plan.total ? state.plan : null;
}

/** For the employee's Training tab: null when they are not in Call Practice and never did a call. */
async function reportFor(employee) {
  if (!ROLES.includes(employee.role)) return null;
  const state = await stateFor(employee);
  return state.eligible || state.plan.doneCount ? { ...state.plan, eligible: state.eligible, window: state.window } : null;
}

/** "6:12" - whole seconds, rounded down like the player shows them */
function clock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60;
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(r).padStart(2, '0')}`;
}

/** The answer key as text: one line per turn, "Agent: ..." / "Client: ...", consecutive pieces of one speaker joined. */
function answerKeyFrom(segments) {
  const lines = [];
  for (const s of segments) {
    const speaker = s.speaker === 'Customer' ? 'Client' : s.speaker === 'Agent' ? 'Agent' : 'Speaker';
    const text = String(s.text || '').trim();
    if (!text) continue;
    if (lines.length && lines[lines.length - 1].speaker === speaker) lines[lines.length - 1].text += ` ${text}`;
    else lines.push({ speaker, text });
  }
  return lines.map((l) => `${l.speaker}: ${l.text}`).join('\n');
}

/**
 * Makes (or makes again) a call's answer key with the AI. Leaves the call READY or FAILED, never in between - unless an
 * Admin typed the answer key themselves meanwhile: theirs is kept (only a call still PROCESSING is written to).
 */
async function makeAnswerKey(callId) {
  const call = await prisma.practiceCall.findUnique({ where: { id: callId } });
  if (!call) return;
  const stillMine = { id: call.id, referenceStatus: 'PROCESSING' };
  try {
    const segments = await require('./callIntelligence').transcribe(call);
    const referenceText = answerKeyFrom(segments);
    if (!referenceText) throw new Error('The transcript was empty.');
    const saved = await prisma.practiceCall.updateMany({ where: stillMine, data: { referenceText, referenceStatus: 'READY', referenceError: null } });
    if (saved.count) await rescore(call.id);
  } catch (err) {
    console.error(`[callPractice] answer key failed for call ${call.id}:`, err.message || err);
    await prisma.practiceCall.updateMany({ where: stillMine, data: { referenceStatus: 'FAILED', referenceError: 'The AI could not make the answer key. Try again, or type it yourself.' } });
  }
}

/** Scores every submitted transcript of a call again (after its answer key changed). Returns how many. */
async function rescore(callId) {
  const call = await prisma.practiceCall.findUnique({ where: { id: callId }, select: { referenceText: true } });
  const rows = await prisma.practiceCallTranscript.findMany({ where: { callId, submittedAt: { not: null } } });
  for (const row of rows) {
    const s = scoreTranscript(call.referenceText, row.submittedText, row.typingSeconds);
    await prisma.practiceCallTranscript.update({ where: { id: row.id }, data: { accuracy: s.accuracy, wordCount: s.wordCount, wordsPerMinute: s.wordsPerMinute } });
  }
  return rows.length;
}

// The answer key of a new upload is made in the background, one call at a time (lib/jobQueue.js).
registerJobType({
  name: 'callPractice',
  async findNext() {
    const row = await prisma.practiceCall.findFirst({ where: { referenceStatus: 'PENDING', archivedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    if (!row) return null;
    const claimed = await prisma.practiceCall.updateMany({ where: { id: row.id, referenceStatus: 'PENDING' }, data: { referenceStatus: 'PROCESSING' } });
    return claimed.count ? { id: row.id, run: () => makeAnswerKey(row.id) } : null;
  },
  async requeueStuck() {
    await prisma.practiceCall.updateMany({ where: { referenceStatus: 'PROCESSING', updatedAt: { lt: new Date(Date.now() - STUCK_AFTER_MS) } }, data: { referenceStatus: 'FAILED', referenceError: 'Making the answer key was interrupted. Try again.' } });
  },
});

module.exports = { ROLES, FALLBACK_MONTHS, MIN_WORDS, MAX_TEXT, dayKey, newAgentWindow, isEligible, planOf, windowFor, stateFor, summaryFor, reportFor, clock, answerKeyFrom, makeAnswerKey, rescore };
