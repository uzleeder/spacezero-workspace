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

module.exports = { isRateLimited, recordAttempt, LOGIN_RATE_LIMIT, FORGOT_PASSWORD_RATE_LIMIT };
