'use strict';

// The ready-made Company Standards & Workflow documents (Supervisor, Flight Expert, Travel Agent and
// Management Responsibilities + Workflows, and the General Company Standard). They are plain data held
// by the import scripts; this module lets an Admin add them from Settings → Standards, where each one
// then becomes an ordinary item in the list - opened, edited, previewed, published, versioned and
// archived like anything else. Adding never touches an existing item unless the Admin asks to replace
// it, and never acknowledges anything for anyone.
const { prisma } = require('./prisma');
const { getSetting, setSetting } = require('./orgSettings');
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

/**
 * Runs when the app starts (every deploy). Adds each ready-made document that this organization has not been
 * offered yet - once. A document that already exists (even edited), or that an Admin archived, is left exactly as
 * it is; nothing is ever replaced and nobody is acknowledged. Afterwards each key is remembered, so later deploys
 * never bring back something an Admin edited away, archived or deleted (the Settings → Standards card can still
 * add it again on request).
 */
async function provisionOrganization(organizationId) {
  const done = new Set(await getSetting(organizationId, 'standards.readyProvisioned'));
  const todo = READY.filter((r) => !done.has(r.key));
  if (!todo.length) return { added: 0, skipped: false };
  const admin = await prisma.profile.findFirst({ where: { organizationId, role: 'ADMIN', status: 'ACTIVE', testOwnerAdminId: null }, orderBy: { createdAt: 'asc' } });
  if (!admin) return { added: 0, skipped: true }; // nobody to record as the author yet - try again at the next start
  let added = 0;
  for (const { key, doc } of todo) {
    const { state } = await importer.inspectDocument(organizationId, doc);
    if (state === 'missing') {
      const archived = await prisma.standardsItem.findFirst({ where: { organizationId, contentType: doc.contentType, title: doc.title }, select: { id: true } });
      if (!archived) { await importer.importDocument(admin, doc, { dry: false }); added += 1; }
    }
    done.add(key);
  }
  await setSetting(organizationId, 'standards.readyProvisioned', [...done], admin.id);
  return { added, skipped: false };
}

let provisioning = null;
/** Every organization, once per process; never throws (a failure is logged and the app carries on). */
function provisionAllOrganizations() {
  if (!provisioning) {
    provisioning = (async () => {
      let added = 0;
      for (const org of await prisma.organization.findMany({ select: { id: true } })) added += (await provisionOrganization(org.id)).added;
      if (added) console.log(`[standards] added ${added} ready-made Company Standards & Workflow document${added === 1 ? '' : 's'}`);
    })().catch((err) => console.error('[standards] ready-made documents could not be added at start-up:', err.message));
  }
  return provisioning;
}

module.exports = { READY, readyStatus, applyReady, provisionOrganization, provisionAllOrganizations, prisma };
