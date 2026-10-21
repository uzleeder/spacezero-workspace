'use strict';

const { prisma } = require('./prisma');

// Persisted (SQLite-backed) fixed-window limiter. Good enough for a
// single-instance localhost deployment; swap for Redis if this app is ever
// run across multiple server instances.
async function isRateLimited(bucketKey, options) {
  const windowStart = new Date(Date.now() - options.windowMs);
  const count = await prisma.rateLimitAttempt.count({
    where: { bucketKey, createdAt: { gte: windowStart } },
  });
  return count >= options.maxAttempts;
}

async function recordAttempt(bucketKey, succeeded) {
  await prisma.rateLimitAttempt.create({ data: { bucketKey, succeeded } });
}

const LOGIN_RATE_LIMIT = { maxAttempts: 8, windowMs: 15 * 60 * 1000 };
const FORGOT_PASSWORD_RATE_LIMIT = { maxAttempts: 5, windowMs: 60 * 60 * 1000 };
// Gemini calls are the most expensive/abusable operation in the app (AI Practice analysis/build
// triggers, call-batch processing, and the SpaceZero AI assistant) — per-profile, not per-IP,
// since these routes always run behind requireSession.
const AI_RATE_LIMIT = { maxAttempts: 20, windowMs: 10 * 60 * 1000 };
// ... and a ceiling over a whole day, per person and for the whole company, so a loop of requests (or a bug) cannot run up the bill.
const AI_DAY_LIMIT = { maxAttempts: 200, windowMs: 24 * 60 * 60 * 1000 };
const AI_ORG_DAY_LIMIT = { maxAttempts: 1500, windowMs: 24 * 60 * 60 * 1000 };
// Learners trigger AI themselves (role-play turns, scoring, voice practice, "practice these skills now"): a tighter hourly limit.
const AI_LEARNER_LIMIT = { maxAttempts: 60, windowMs: 60 * 60 * 1000 };

/**
 * Asks for one AI request. Returns true and COUNTS it when the person and the company are inside their limits, false
 * (nothing counted) when not. Every route that calls Gemini asks this first - a limit that is only checked, never counted, never trips.
 */
async function takeAiSlot(actor, { learner = false } = {}) {
  const buckets = [[`ai:${actor.id}`, AI_RATE_LIMIT], [`ai-day:${actor.id}`, AI_DAY_LIMIT], [`ai-org:${actor.organizationId}`, AI_ORG_DAY_LIMIT]];
  if (learner) buckets.push([`ai-learner:${actor.id}`, AI_LEARNER_LIMIT]);
  for (const [key, options] of buckets) if (await isRateLimited(key, options)) return false;
  for (const [key] of buckets) await recordAttempt(key, true);
  return true;
}

module.exports = { isRateLimited, recordAttempt, takeAiSlot, LOGIN_RATE_LIMIT, FORGOT_PASSWORD_RATE_LIMIT, AI_RATE_LIMIT, AI_DAY_LIMIT, AI_ORG_DAY_LIMIT, AI_LEARNER_LIMIT };
