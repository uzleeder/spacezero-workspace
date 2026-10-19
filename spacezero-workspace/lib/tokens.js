'use strict';

const crypto = require('crypto');

// A generated token has two lives:
// - the raw value is shown to the admin / put in a link once
// - only its SHA-256 hash is ever persisted, so a leaked database never
//   yields usable tokens
function generateToken() {
  const raw = crypto.randomBytes(32).toString('base64url');
  return { raw, hash: hashToken(raw) };
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

module.exports = { generateToken, hashToken };
