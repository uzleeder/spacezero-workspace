'use strict';

// Shared by the Admin employee list and the Supervisor team list: readiness filters are applied to
// the server-computed setup result (never to anything the client sends beyond the filter choice).
const { prisma } = require('./prisma');

const SETUP_FILTERS = {
  fully: 'Fully set up',
  required: 'Setup required',
  issue: 'Has an issue',
  notstarted: 'Setup not started (not activated)',
};

function parseSetupQuery(query) {
  const setup = Object.hasOwn(SETUP_FILTERS, query.setup) ? query.setup : '';
  const missing = typeof query.missing === 'string' ? query.missing.slice(0, 60) : '';
  return { setup, missing };
}

function matchesSetup(result, { setup, missing }) {
  if (setup === 'fully' && !result.fullySetUp) return false;
  if (setup === 'required' && (result.fullySetUp || result.notStarted)) return false;
  if (setup === 'notstarted' && !result.notStarted) return false;
  if (setup === 'issue' && !result.hasIssue) return false;
  if (missing && !result.missingKeys.includes(missing)) return false;
  return true;
}

async function requirementOptions(organizationId) {
  return prisma.setupRequirement.findMany({
    where: { organizationId, archivedAt: null },
    orderBy: { displayOrder: 'asc' },
    select: { key: true, label: true },
  });
}

module.exports = { SETUP_FILTERS, parseSetupQuery, matchesSetup, requirementOptions };
