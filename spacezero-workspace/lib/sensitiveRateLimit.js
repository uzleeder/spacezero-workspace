'use strict';
const crypto = require('crypto');
const { isRateLimited, recordAttempt } = require('./rateLimit');

// Brute-force protection for the sign-in / password / invitation POSTs.
//
// The bucket is per PERSON (the account being signed in to, or the signed-in session, or the invitation
// token in the URL), not per IP: behind the reverse proxy every colleague arrives from the same address,
// so an IP bucket let one busy shift start ("40 sign-ins in 15 minutes") lock the WHOLE company out.
// A guessing attack on one account is still stopped after 40 POSTs, and the login route keeps its own,
// stricter per-account-and-IP limit (8 failures). Only a request that identifies nobody falls back to the IP.
function whoIsAsking(req) {
  const named = String((req.body && (req.body.identifier || req.body.email)) || '').trim().toLowerCase();
  if (named) return `user:${named.slice(0, 120)}`;
  const session = req.cookies && req.cookies.sz_session;
  if (session) return `session:${crypto.createHash('sha256').update(String(session)).digest('hex').slice(0, 32)}`; // never store the cookie itself
  const token = /^\/(accept-invite|reset-password)\/([^/]+)/.exec(req.path);
  if (token) return `token:${crypto.createHash('sha256').update(token[2]).digest('hex').slice(0, 32)}`;
  return `ip:${req.ip}`;
}

async function sensitiveRateLimit(req, res, next) {
  if (req.method !== 'POST') return next();
  const sensitive = /^\/(login|forgot-password|accept-invite|reset-password)(\/|$)/.test(req.path) || /\/(resend-invite|reset-password)$/.test(req.path) || req.path === '/profile/password';
  if (!sensitive) return next();
  const bucket = `sensitive:${whoIsAsking(req)}`;
  const options = { maxAttempts: 40, windowMs: 15 * 60 * 1000 };
  if (await isRateLimited(bucket, options)) return res.status(429).send('Too many requests. Try again later.');
  await recordAttempt(bucket, false);
  next();
}
module.exports = { sensitiveRateLimit };
