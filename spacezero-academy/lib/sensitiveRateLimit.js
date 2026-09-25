'use strict';
const { isRateLimited, recordAttempt } = require('./rateLimit');
async function sensitiveRateLimit(req, res, next) {
  if (req.method !== 'POST') return next();
  const sensitive = /^\/(login|forgot-password|accept-invite|reset-password)(\/|$)/.test(req.path) || /\/(resend-invite|reset-password)$/.test(req.path) || req.path === '/profile/password';
  if (!sensitive) return next();
  const bucket = `sensitive:${req.ip}`;
  const options = { maxAttempts: 40, windowMs: 15 * 60 * 1000 };
  if (await isRateLimited(bucket, options)) return res.status(429).send('Too many requests. Try again later.');
  await recordAttempt(bucket, false);
  next();
}
module.exports = { sensitiveRateLimit };
