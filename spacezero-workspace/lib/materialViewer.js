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

module.exports = { viewerKind, readableText, paragraphs, refusesPageNavigation, VIEW_ONLY_PAGE };
