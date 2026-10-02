'use strict';

// The ready-made Company Standards & Workflow documents (Supervisor, Flight Expert, Travel Agent and
// Management Responsibilities + Workflows, and the General Company Standard). They are plain data held
// by the import scripts; this module lets an Admin add them from Settings → Standards, where each one
// then becomes an ordinary item in the list - opened, edited, previewed, published, versioned and
// archived like anything else. Adding never touches an existing item unless the Admin asks to replace
// it, and never acknowledges anything for anyone.
const { prisma } = require('./prisma');
const importer = require('../scripts/import-supervisor-standards.cjs');

const SETS = [
  { key: 'supervisor', docs: importer.DOCUMENTS, keys: ['supervisor-responsibilities', 'supervisor-workflow'] },
  { key: 'flight-expert', docs: require('../scripts/import-flight-expert-standards.cjs').DOCUMENTS, keys: ['flight-expert-responsibilities', 'flight-expert-workflow'] },
  { key: 'travel-agent', docs: require('../scripts/import-travel-agent-standards.cjs').DOCUMENTS, keys: ['travel-agent-responsibilities', 'travel-agent-workflow'] },
  { key: 'management', docs: require('../scripts/import-management-standards.cjs').DOCUMENTS, keys: ['management-responsibilities', 'management-workflow'] },
  { key: 'general', docs: require('../scripts/import-general-company-standard.cjs').DOCUMENTS, keys: ['general-company-standard'] },
];
const READY = SETS.flatMap((s) => s.docs.map((doc, i) => ({ key: s.keys[i], doc })));

/** Every ready-made document with where it stands for this organization. */
async function readyStatus(organizationId) {
  return Promise.all(READY.map(async ({ key, doc }) => ({ key, doc, audience: importer.audienceOf(doc), ...(await importer.inspectDocument(organizationId, doc)) })));
}

/**
 * Adds missing documents (all of them, or just `key`). An existing document is only replaced when
 * `replace` is true and a `key` is given - the previous version is archived and kept as history.
 */
async function applyReady(admin, { key = null, replace = false } = {}) {
  const wanted = key ? READY.filter((r) => r.key === key) : READY;
  if (key && !wanted.length) return { added: 0, replaced: 0, kept: 0, unknown: true };
  const out = { added: 0, replaced: 0, kept: 0, unknown: false };
  for (const { doc } of wanted) {
    const { state } = await importer.inspectDocument(admin.organizationId, doc);
    if (state === 'missing') { await importer.importDocument(admin, doc, { dry: false }); out.added += 1; }
    else if (state === 'different' && key && replace) { await importer.importDocument(admin, doc, { dry: false }); out.replaced += 1; }
    else out.kept += 1;
  }
  return out;
}

module.exports = { READY, readyStatus, applyReady, prisma };
