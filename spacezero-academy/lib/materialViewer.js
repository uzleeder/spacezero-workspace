'use strict';

// How a learner READS / WATCHES material inside the app (Library items and training material), and the rules
// that keep it view-only for everyone except Admins: no download link, no raw-file page, no copy.
//
//  * Videos and audio play with the browser's native player (download / remote-playback buttons switched off).
//  * Images and PDFs are shown inside the page (the PDF viewer's toolbar - with its save/print buttons - is hidden).
//  * Word (DOCX) and PowerPoint (PPTX) files cannot be shown by a browser, and "open" would DOWNLOAD them, so
//    their text is extracted and shown as a readable page instead. Old .doc / .ppt files cannot be read that way.
//
// These controls deter casual copying; they are not DRM. Authorized browsers receive the media bytes,
// and native PDF controls, screenshots and developer tools can bypass UI restrictions. Explicit downloads
// require Admin permission; direct page navigation is refused when the browser identifies it as such.
const path = require('node:path');
const { resolveStoragePath } = require('./storage');

const READABLE_TEXT = ['.docx', '.pptx'];
const LEGACY = ['.doc', '.ppt'];

/** Which viewer a file needs: video | audio | image | pdf | text | unsupported | none. */
function viewerKind({ type, storagePath, mimeType }) {
  if (!storagePath) return 'none';
  const ext = path.extname(String(storagePath)).toLowerCase();
  const mime = String(mimeType || '').toLowerCase();
  if (type === 'VIDEO' || mime.startsWith('video/')) return 'video';
  if (type === 'AUDIO' || type === 'CALL_RECORDING' || mime.startsWith('audio/')) return 'audio';
  if (type === 'IMAGE' || mime.startsWith('image/')) return 'image';
  if (ext === '.pdf' || mime === 'application/pdf' || type === 'PDF') return 'pdf';
  if (READABLE_TEXT.includes(ext)) return 'text';
  if (LEGACY.includes(ext)) return 'unsupported';
  return 'unsupported';
}

/** The text of a DOCX / PPTX for the reading page; null when the file cannot be read that way. */
async function readableText(storagePath) {
  try {
    const text = await require('./documentText').documentText(resolveStoragePath(storagePath));
    return typeof text === 'string' ? text.replace(/\r\n/g, '\n').trim().slice(0, 400000) : null;
  } catch { return null; }
}

/** Splits extracted text into paragraphs (blank-line separated) for rendering. */
const paragraphs = (text) => String(text || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

/**
 * Non-Admins may not open a raw file URL as a page of its own (that is how a "save as" / download button
 * appears). Embedding it - <video>, <audio>, <img>, <iframe>, <embed> - is fine. Browsers that do not send
 * Sec-Fetch-Dest are not blocked, since nothing can be told about them.
 */
function refusesPageNavigation(req) {
  return req.profile && req.profile.role !== 'ADMIN' && req.get('sec-fetch-dest') === 'document';
}

const VIEW_ONLY_PAGE = '<!doctype html><meta charset="utf-8"><title>View only</title><body style="font-family:system-ui;max-width:520px;margin:15vh auto;padding:0 16px"><h1>View only</h1><p>This material can be read or watched inside SpaceZero Workspace. It cannot be opened as a separate file or downloaded.</p><p><a href="javascript:history.back()">Go back</a></p></body>';

// ---- The reading page for TRAINING material (progress-tracked): the file as it was uploaded -------------------------------
// pdf    -> the pages themselves, drawn page by page (PDF.js): .pdf and PDF-based .ai
// image  -> the picture (png jpg gif webp bmp avif and svg)
// docx   -> a Word / OpenDocument text document with its headings, lists, tables and pictures on a paper-like page
// slides -> one card per slide: .pptx and .odp
// sheet  -> every sheet as a table: .xlsx .ods .csv .tsv
// epub   -> the e-book, chapter after chapter
// text   -> .txt .md .rtf and .html (as text)
// font   -> a specimen page set in the font itself: .ttf .otf .woff .woff2
// cad    -> the drawing as vector lines: .dxf
// Old .doc / .ppt cannot be drawn by a browser or in the app: 'unsupported' (the learner then confirms by hand).
const READER_BY_EXT = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.bmp': 'image', '.avif': 'image', '.svg': 'image',
  '.pdf': 'pdf', '.ai': 'pdf', '.docx': 'docx', '.odt': 'docx', '.pptx': 'slides', '.odp': 'slides',
  '.xlsx': 'sheet', '.ods': 'sheet', '.csv': 'sheet', '.tsv': 'sheet', '.epub': 'epub',
  '.txt': 'text', '.md': 'text', '.rtf': 'text', '.html': 'text', '.htm': 'text',
  '.ttf': 'font', '.otf': 'font', '.woff': 'font', '.woff2': 'font', '.dxf': 'cad',
};
function readerKind({ type, storagePath, mimeType }) {
  if (!storagePath) return 'none';
  const ext = path.extname(String(storagePath)).toLowerCase();
  if (READER_BY_EXT[ext]) return READER_BY_EXT[ext];
  const mime = String(mimeType || '').toLowerCase();
  if (type === 'IMAGE' || mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf' || type === 'PDF') return 'pdf';
  return 'unsupported';
}
const MAX_HTML = 20 * 1024 * 1024;

/** A DOCX as HTML: headings, lists, tables, bold / italic and pictures kept. Links are made inert; nothing is executable. */
async function docxHtml(storagePath) {
  try {
    const result = await require('mammoth').convertToHtml({ path: resolveStoragePath(storagePath) });
    let html = String(result.value || '');
    if (html.length > MAX_HTML) return null;
    html = html.replace(/<a\b[^>]*>/gi, '<span class="reader-link">').replace(/<\/a>/gi, '</span>').replace(/\son\w+="[^"]*"/gi, '');
    return html.trim() ? html : null;
  } catch { return null; }
}

const decodeXml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

/** A PPTX as slides: [{ number, title, lines, images: [dataUri] }] in slide order. */
async function slidesData(storagePath) {
  try {
    const zip = new (require('adm-zip'))(resolveStoragePath(storagePath));
    const entries = zip.getEntries();
    const slideEntries = entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName)).sort((a, b) => Number(a.entryName.match(/slide(\d+)/)[1]) - Number(b.entryName.match(/slide(\d+)/)[1]));
    if (slideEntries.reduce((n, e) => n + e.header.size, 0) > 40 * 1024 * 1024) return null;
    let imageBudget = 20 * 1024 * 1024;
    const slides = [];
    for (const entry of slideEntries) {
      const number = Number(entry.entryName.match(/slide(\d+)/)[1]);
      const xml = entry.getData().toString('utf8');
      let title = ''; const lines = [];
      for (const shape of xml.split(/<p:sp[ >]/).slice(1)) {
        const isTitle = /<p:ph[^>]*type="(title|ctrTitle)"/.test(shape);
        const paragraphs = [...shape.matchAll(/<a:p>([\s\S]*?)<\/a:p>|<a:p [^>]*>([\s\S]*?)<\/a:p>/g)].map((m) => [...(m[1] || m[2] || '').matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((x) => decodeXml(x[1])).join('')).filter((s) => s.trim());
        if (isTitle && !title) title = paragraphs.join(' '); else lines.push(...paragraphs);
      }
      const rels = zip.getEntry(`ppt/slides/_rels/slide${number}.xml.rels`);
      const relMap = {};
      if (rels) for (const m of rels.getData().toString('utf8').matchAll(/<Relationship\b[^>]*>/g)) { const id = /Id="([^"]+)"/.exec(m[0]); const target = /Target="([^"]+)"/.exec(m[0]); if (id && target) relMap[id[1]] = target[1]; }
      const images = [];
      for (const m of xml.matchAll(/<a:blip\b[^>]*r:embed="([^"]+)"/g)) {
        const target = relMap[m[1]];
        const mime = target && IMAGE_MIME[path.extname(target).toLowerCase()];
        const file = target && zip.getEntry(path.posix.normalize(`ppt/slides/${target}`));
        if (!mime || !file || file.header.size > 6 * 1024 * 1024 || imageBudget < file.header.size) continue;
        imageBudget -= file.header.size;
        images.push(`data:${mime};base64,${file.getData().toString('base64')}`);
      }
      slides.push({ number, title, lines, images });
    }
    return slides.length ? slides : null;
  } catch { return null; }
}
/** What the reading page shows for a file of this kind: { html } or { slides }; both null when it cannot be read. */
async function readerContent(kind, storagePath) {
  const render = require('./documentRender');
  const ext = path.extname(String(storagePath)).toLowerCase();
  if (kind === 'docx') return { html: ext === '.odt' ? render.odtHtml(storagePath) : await docxHtml(storagePath) };
  if (kind === 'slides') return { slides: ext === '.odp' ? render.odpSlides(storagePath) : await slidesData(storagePath) };
  if (kind === 'sheet') return { html: render.sheetsHtml(storagePath) };
  if (kind === 'epub') return { html: render.epubHtml(storagePath) };
  if (kind === 'text') return { html: render.textHtml(storagePath) };
  if (kind === 'cad') return { html: render.dxfSvg(storagePath) };
  return {};
}

module.exports = { viewerKind, readableText, paragraphs, refusesPageNavigation, VIEW_ONLY_PAGE, readerKind, readerContent, docxHtml, slidesData };
