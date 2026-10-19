'use strict';

// Application-level authenticated encryption (AES-256-GCM) for work-system credentials and other
// sensitive profile fields. The key comes from the CREDENTIAL_ENCRYPTION_KEY environment variable
// (32 random bytes, base64) and is deliberately NEVER stored in the database — a database dump
// alone cannot decrypt anything.
//
// Ciphertext format:  v1.<iv b64>.<auth tag b64>.<ciphertext b64>
// A per-record "aad" string (organization/owner/record binding) is authenticated but not stored,
// so ciphertext copied onto another row fails to decrypt instead of silently revealing data.
// Key rotation: add a v2 key alongside and bump CURRENT_VERSION; readers dispatch on the prefix.
const crypto = require('node:crypto');

const CURRENT_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';

function keyFor(version) {
  if (version !== 1) throw new Error('Unsupported credential key version');
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) throw new Error('CREDENTIAL_ENCRYPTION_KEY is not configured');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('CREDENTIAL_ENCRYPTION_KEY must be 32 bytes, base64 encoded');
  return key;
}

function encryptText(plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, keyFor(CURRENT_VERSION), iv);
  cipher.setAAD(Buffer.from(String(aad)));
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `v${CURRENT_VERSION}.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ciphertext.toString('base64')}`;
}

function decryptText(stored, aad) {
  const [prefix, iv, tag, ciphertext] = String(stored).split('.');
  const version = Number(/^v(\d+)$/.exec(prefix || '')?.[1]);
  const decipher = crypto.createDecipheriv(ALGORITHM, keyFor(version), Buffer.from(iv, 'base64'));
  decipher.setAAD(Buffer.from(String(aad)));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

const encryptJson = (value, aad) => encryptText(JSON.stringify(value), aad);
const decryptJson = (stored, aad) => JSON.parse(decryptText(stored, aad));

module.exports = { encryptText, decryptText, encryptJson, decryptJson, CURRENT_VERSION };
