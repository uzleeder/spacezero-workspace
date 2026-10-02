'use strict';

// Presentation helpers for the Company Standards & Workflow reading experience. Everything here is
// DERIVED from the existing content and acknowledgement records — it stores nothing, invents no
// completion state and changes no authorization: the reading state is read from the same
// StandardsAcknowledgement rows the acknowledgement feature already writes, and the table of contents,
// principle strip and workflow strip are generated from the existing Heading blocks / responsibility
// entries / workflow steps, so there is no second list of headings to maintain.
const { prisma } = require('./prisma');

const TYPE_INFO = {
  STANDARD: { label: 'Company Standards', description: 'Company-wide expectations and professional standards that apply to your work.', empty: 'No company standards have been published yet.' },
  RESPONSIBILITY: { label: 'My Responsibilities', description: 'What your role is responsible for and what is expected from you.', empty: 'No responsibilities have been published for your role yet.' },
  WORKFLOW: { label: 'Workflows', description: 'Step-by-step guidance for completing important work processes correctly.', empty: 'No workflows have been assigned to your role yet.' },
  DISCLOSURE: { label: 'Required Disclosures', description: 'Approved wording for what you\'re required to communicate.', empty: 'No required disclosures have been published yet.' },
};

// ---------------------------------------------------------------------------------------------
// Reading state (from the existing acknowledgement records)
// ---------------------------------------------------------------------------------------------
/**
 * For each item (with its currentVersion loaded): NONE (no acknowledgement asked for), DONE
 * (acknowledged — an acknowledgement of an earlier version still counts unless the Admin turned on
 * re-acknowledgement for the current one, exactly as lib/standards.js decides), UPDATED (it was
 * acknowledged before but the current version needs another look) or TODO (not acknowledged yet).
 */
async function readingStates(profileId, items) {
  const states = new Map();
  const asked = items.filter((i) => i.currentVersion && i.currentVersion.acknowledgementRequired);
  const acks = asked.length
    ? await prisma.standardsAcknowledgement.findMany({ where: { profileId, itemId: { in: asked.map((i) => i.id) } }, orderBy: { acceptedAt: 'desc' }, select: { itemId: true, versionId: true, acceptedAt: true } })
    : [];
  const byItem = new Map();
  for (const a of acks) { if (!byItem.has(a.itemId)) byItem.set(a.itemId, []); byItem.get(a.itemId).push(a); }
  for (const item of items) {
    const v = item.currentVersion;
    if (!v || !v.acknowledgementRequired) { states.set(item.id, { state: 'NONE', acceptedAt: null }); continue; }
    const mine = byItem.get(item.id) || [];
    const exact = mine.find((a) => a.versionId === v.id);
    const satisfying = exact || (!v.requireReacknowledgement ? mine[0] : null);
    states.set(item.id, satisfying ? { state: 'DONE', acceptedAt: satisfying.acceptedAt } : { state: mine.length ? 'UPDATED' : 'TODO', acceptedAt: null });
  }
  return states;
}

/** "2 of 3 required documents acknowledged" and the first one still to do. */
function progressOf(items, states) {
  const asked = items.filter((i) => states.get(i.id) && states.get(i.id).state !== 'NONE');
  const done = asked.filter((i) => states.get(i.id).state === 'DONE');
  const next = asked.find((i) => states.get(i.id).state !== 'DONE') || null;
  return { required: asked.length, done: done.length, next };
}

const STATE_LABEL = { DONE: '✓ Acknowledged', TODO: 'Acknowledgement needed', UPDATED: 'Updated version — please review' };
const STATE_ACTION = { NONE: 'Read', TODO: 'Read', UPDATED: 'Review', DONE: 'Read again' };

// ---------------------------------------------------------------------------------------------
// Reader model (table of contents, principle strip, workflow strip)
// ---------------------------------------------------------------------------------------------
const HEADING_RE = /^\*\*(.+?)\*\*\s*([\s\S]*)$/;

/** "**1. Team leadership.** Manage the…" -> { head: '1. Team leadership', body: 'Manage the…' }; no bold lead -> head ''. */
function splitHeading(text) {
  const m = HEADING_RE.exec(String(text || ''));
  return m ? { head: m[1].replace(/\s*[.:]\s*$/, ''), body: m[2] } : { head: '', body: String(text || '') };
}

/** Finds an arrow sequence ("Listen → Understand → … → Retain") inside a sentence. Returns null unless there are >= minSteps parts. */
function extractSequence(text, minSteps = 3) {
  const clean = String(text || '').replace(/\*\*/g, '');
  const first = clean.indexOf('→');
  if (first < 0) return null;
  let start = first;
  while (start > 0 && !/[.:;,()"]/.test(clean[start - 1])) start -= 1;
  let end = clean.length;
  const stop = /\.(\s|$)/.exec(clean.slice(first));
  if (stop) end = first + stop.index;
  const steps = clean.slice(start, end).split('→').map((s) => s.trim()).filter(Boolean);
  if (steps.length < minSteps) return null;
  return { steps, before: clean.slice(0, start).trim(), after: clean.slice(end).replace(/^\./, '').trim() };
}

const MIN_TOC_ENTRIES = 5;

function buildReaderModel({ item, version, blocks = [], steps = [] }) {
  const info = TYPE_INFO[item.contentType] || { label: item.contentType, description: '', empty: '' };
  const model = { info, toc: [], blockIds: new Map(), entries: [], principle: null, flow: null, steps: [] };

  if (item.contentType === 'STANDARD') {
    let n = 0;
    blocks.forEach((b, i) => { if (b.type === 'heading') { n += 1; const id = `sec-${n}`; model.blockIds.set(i, id); model.toc.push({ id, label: b.text }); } });
  }

  if (item.contentType === 'RESPONSIBILITY') {
    (version.responsibilities || []).forEach((r, i) => {
      const { head, body } = splitHeading(r.text);
      model.entries.push({ id: `sec-${i + 1}`, head, body, text: r.text });
    });
    // A core principle at the top ("Listen → Understand → …") becomes a small strip instead of a paragraph.
    const first = model.entries[0];
    if (first) {
      const seq = extractSequence(first.body);
      if (seq) {
        model.principle = { label: first.head || 'Core principle', steps: seq.steps, intro: [seq.before, seq.after].filter(Boolean).join(' ') };
        first.asPrinciple = true;
      }
    }
    model.entries.forEach((e) => { if (e.head && !e.asPrinciple) model.toc.push({ id: e.id, label: e.head }); });
  }

  if (item.contentType === 'WORKFLOW') {
    steps.forEach((s, i) => { model.steps.push({ ...s, id: `sec-${i + 1}`, number: String(i + 1).padStart(2, '0') }); model.toc.push({ id: `sec-${i + 1}`, label: `${i + 1}. ${s.title}` }); });
    // The core flow near the top: the first step that is itself a "flow / summary / principle" chain.
    for (const s of steps) {
      if (!/(flow|summary|principle)/i.test(s.title)) continue;
      const seq = extractSequence(s.instruction, 3);
      if (seq) { model.flow = { label: s.title, steps: seq.steps }; break; }
    }
  }

  if (model.toc.length < MIN_TOC_ENTRIES) model.toc = []; // short documents need no contents list
  return model;
}

module.exports = { TYPE_INFO, STATE_LABEL, STATE_ACTION, readingStates, progressOf, splitHeading, extractSequence, buildReaderModel, MIN_TOC_ENTRIES };
