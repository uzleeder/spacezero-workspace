'use strict';

// Prisma "contains" is case-insensitive on SQLite (LIKE) but case-sensitive on Postgres, so a
// search for "ali" would miss "Ali" in production. Postgres needs mode: 'insensitive'
// (SQLite rejects the option), so it is added only for the Postgres client.
const isPostgres = () => /^postgres(?:ql)?:/.test(process.env.DATABASE_URL || '');

function containsText(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return isPostgres() ? { contains: text, mode: 'insensitive' } : { contains: text };
}

module.exports = { containsText };
