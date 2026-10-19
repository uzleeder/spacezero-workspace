'use strict';

// Short-lived signed URLs for private media (customer call recordings). A link only works for the
// person it was issued to, for one specific object, for a few minutes — on top of the normal session
// and role checks. The signing key is derived from a server secret; nothing here is stored.
const crypto = require('crypto');

const DEFAULT_TTL_SECONDS = 300;
let devKey; // only used when no server secret is configured (local development)

function signingKey() {
  const secret = process.env.MEDIA_URL_SIGNING_KEY || process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (secret) return crypto.createHmac('sha256', secret).update('signed-media-url/v1').digest();
  if (process.env.NODE_ENV === 'production') throw new Error('No signing secret is configured for media URLs');
  devKey = devKey || crypto.randomBytes(32);
  return devKey;
}

const mac = (purpose, subject, actorId, expires) => crypto.createHmac('sha256', signingKey()).update(`${purpose}|${subject}|${actorId}|${expires}`).digest('base64url');

/** Query string that authorizes `actorId` to fetch `subject` for `purpose` until it expires. */
function signMedia(purpose, subject, actorId, ttlSeconds = DEFAULT_TTL_SECONDS, now = Date.now()) {
  const expires = Math.floor(now / 1000) + ttlSeconds;
  return `exp=${expires}&sig=${mac(purpose, subject, actorId, expires)}`;
}

function verifyMedia(purpose, subject, actorId, query, now = Date.now()) {
  const expires = Number(query && query.exp);
  const sig = typeof (query && query.sig) === 'string' ? query.sig : '';
  if (!Number.isInteger(expires) || expires < Math.floor(now / 1000) || !sig) return false;
  const expected = Buffer.from(mac(purpose, subject, actorId, expires));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

module.exports = { signMedia, verifyMedia, DEFAULT_TTL_SECONDS };