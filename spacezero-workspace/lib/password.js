'use strict';

const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 12;
// Organization decision: passwords must be at least 6 characters long.
const MIN_PASSWORD_LENGTH = 6;

async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// Minimum bar enforced everywhere a user sets their own password
// (invite acceptance + reset). Kept intentionally simple and explainable.
function passwordPolicyErrors(password) {
  const errors = [];
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) errors.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
  if (typeof password === 'string' && Buffer.byteLength(password, 'utf8') > 72) errors.push('Password must not exceed 72 UTF-8 bytes.');
  return errors;
}

module.exports = { hashPassword, verifyPassword, passwordPolicyErrors, MIN_PASSWORD_LENGTH };
