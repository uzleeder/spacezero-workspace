'use strict';

// Company Standards & Workflow body content is stored as small typed BLOCKS (contentJson on
// StandardsVersion), never as raw HTML or Markdown. This makes uncontrolled HTML structurally
// impossible: a template only ever renders a block by its known `type`, and the only inline
// markup allowed inside a block's text is **bold**, converted by renderInline() below after
// everything else has been HTML-escaped. There is no code path that turns arbitrary user input
// into raw HTML.

const BLOCK_TYPES = ['heading', 'paragraph', 'bullets', 'numbered', 'callout_important', 'callout_warning'];
const BLOCK_TYPE_LABEL = {
  heading: 'Heading',
  paragraph: 'Paragraph',
  bullets: 'Bullet list',
  numbered: 'Numbered list',
  callout_important: 'Important note',
  callout_warning: 'Warning / caution',
};
const LIST_TYPES = new Set(['bullets', 'numbered']);

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Escapes everything, then converts the one inline affordance the spec asks for: **bold**.
// Safe to use with <%- %> in views — nothing but <strong> can ever appear in the output.
function renderInline(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function asList(v) {
  return Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v];
}

/**
 * Reconstructs the ordered block array from posted form fields. The block editor posts
 * parallel arrays: blockType[], blockText[] (heading/paragraph/callouts — one string), and
 * blockItems[] (bullets/numbered — one newline-separated string per block, split into lines).
 * Empty blocks (no text/items) are dropped. Pure — never touches the database.
 */
function parseBlocksFromForm(body) {
  const types = asList(body.blockType).map(String);
  const texts = asList(body.blockText).map(String);
  const items = asList(body.blockItems).map(String);
  const blocks = [];
  for (let i = 0; i < types.length; i += 1) {
    const type = BLOCK_TYPES.includes(types[i]) ? types[i] : null;
    if (!type) continue;
    if (LIST_TYPES.has(type)) {
      const lines = (items[i] || '').split('\n').map((s) => s.trim()).slice(0, 40).filter(Boolean);
      if (lines.length) blocks.push({ type, items: lines });
    } else {
      const text = (texts[i] || '').trim().slice(0, 4000);
      if (text) blocks.push({ type, text });
    }
  }
  return blocks;
}

function parseBlocks(contentJson) {
  if (!contentJson) return [];
  try {
    const parsed = JSON.parse(contentJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function blocksToJson(blocks) {
  return blocks && blocks.length ? JSON.stringify(blocks) : null;
}

module.exports = { BLOCK_TYPES, BLOCK_TYPE_LABEL, escapeHtml, renderInline, parseBlocksFromForm, parseBlocks, blocksToJson };
