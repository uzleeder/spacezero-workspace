'use strict';

// Validation and storage of uploaded source files, shared by every AI Practice upload path.
// The extension only decides which checks run; the declared type and the file's real content (magic bytes,
// size, duration for media) are always verified by lib/storage.validateUpload, so a renamed file is refused.
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { prisma } = require('./prisma');
const { validateUpload, saveUpload, resolveStoragePath, sampleOf } = require('./storage');
const { probeMedia } = require('./mediaProbe');

const clip = (v, n) => String(v ?? '').trim().slice(0, n);

const EXT = {
  '.mp4': ['VIDEO', 'video/mp4'], '.webm': ['VIDEO', 'video/webm'], '.mov': ['VIDEO', 'video/quicktime'],
  '.mp3': ['AUDIO', 'audio/mpeg'], '.wav': ['AUDIO', 'audio/wav'], '.ogg': ['AUDIO', 'audio/ogg'],
  '.pdf': ['PDF', 'application/pdf'], '.ppt': ['PPT', 'application/vnd.ms-powerpoint'], '.pptx': ['PPT', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  '.doc': ['DOC', 'application/msword'], '.docx': ['DOC', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.png': ['IMAGE', 'image/png'], '.jpg': ['IMAGE', 'image/jpeg'], '.jpeg': ['IMAGE', 'image/jpeg'], '.webp': ['IMAGE', 'image/webp'], '.gif': ['IMAGE', 'image/gif'],
};
const fileTypes = require('./fileTypes');
// Every kind of file the app can show: the original set plus audio, video, pictures, vectors, documents, e-books, presentations,
// spreadsheets, fonts and CAD drawings (see lib/fileTypes.js).
const ACCEPT = [...new Set([...Object.keys(EXT), ...fileTypes.ALL_EXTENSIONS])].join(',');
const MEDIA = ['VIDEO', 'AUDIO'];

/** The kind of source a file is, from its extension. The extension only chooses which checks run — the content is always verified. */
function classify(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const entry = EXT[ext];
  if (!entry) {
    const extra = fileTypes.lookup(file.originalname);
    if (extra) return { contentType: extra.contentType, extra };          // one of the newer kinds: checked by lib/fileTypes.js
    const hint = fileTypes.hint(file.originalname);
    return { error: hint ? `"${file.originalname}": ${hint}.` : `"${file.originalname}" is not a supported file type.` };
  }
  const [contentType, mime] = entry;
  // Browsers sometimes send a generic type; the extension picks the expected one and the magic-byte check still has to agree.
  if (!file.mimetype || file.mimetype === 'application/octet-stream') file.mimetype = mime;
  return { contentType };
}

/** Validates and stores every file; returns module rows or an error message. Cleans up after itself on failure. */
async function storeFiles(files, { subdir = 'training' } = {}) {
  const saved = []; const modules = [];
  try {
    for (const [i, file] of files.entries()) {
      const kind = classify(file);
      if (kind.error) throw new Error(kind.error);
      // the original kinds keep their own checks; the newer kinds are checked from the real content by lib/fileTypes.js
      const problem = kind.extra ? fileTypes.validateContent(kind.extra, file, sampleOf(file)) : validateUpload(kind.contentType, file);
      if (problem) throw new Error(kind.extra ? problem : `${file.originalname}: ${problem}`);
      const stored = await saveUpload(file, subdir, kind.extra ? { ext: kind.extra.ext } : {});
      saved.push(stored.storagePath);
      let seconds = null;
      if (MEDIA.includes(kind.contentType)) {
        try { seconds = Math.ceil(await probeMedia(stored.storagePath)); } catch { throw new Error(`${file.originalname}: the recording could not be read. Upload a valid audio or video file.`); }
      }
      modules.push({ title: clip(path.basename(file.originalname, path.extname(file.originalname)), 120) || `Material ${i + 1}`, contentType: kind.contentType, storagePath: stored.storagePath, displayOrder: i, ...(seconds ? { sourceRefJson: JSON.stringify({ durationSeconds: seconds }) } : {}) });
    }
    return { modules };
  } catch (err) {
    for (const p of saved) await fsp.unlink(resolveStoragePath(p)).catch(() => undefined);
    return { error: err.message };
  }
}

/** A stored file may be shared with an older raw upload; only remove it when nothing else points at it. */
async function releaseFile(storagePath) {
  if (!storagePath) return;
  const [modules, materials, recordings] = await Promise.all([
    prisma.trainingModule.count({ where: { storagePath } }), prisma.practiceMaterial.count({ where: { storagePath } }), prisma.callRecording.count({ where: { storagePath } }),
  ]);
  if (modules + materials + recordings === 0) await fsp.unlink(resolveStoragePath(storagePath)).catch(() => undefined);
}


/** SHA-256 of an upload, read in pieces from disk (or from memory for a small in-memory upload). */
function hashOf(file) {
  if (file.buffer) return Promise.resolve(crypto.createHash('sha256').update(file.buffer).digest('hex'));
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    require('fs').createReadStream(file.path).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

/** Stores customer-call recordings (audio/video only), rejecting duplicates within the batch. */
async function storeCallFiles(files) {
  const seen = new Set(); const saved = [];
  try {
    for (const file of files) {
      const kind = classify(file);
      if (kind.error || !MEDIA.includes(kind.contentType)) throw new Error(kind.error || `"${file.originalname}" is not an audio or video recording.`);
      const problem = validateUpload('CALL', file);
      if (problem) throw new Error(`${file.originalname}: ${problem}`);
      const hash = await hashOf(file);
      if (seen.has(hash)) throw new Error('The same recording was included more than once.');
      seen.add(hash);
      const stored = await saveUpload(file, 'calls');
      saved.push({ ...stored, originalFilename: clip(file.originalname, 200) });
      try { saved.at(-1).durationSeconds = Math.ceil(await probeMedia(stored.storagePath)); } catch { throw new Error(`${file.originalname}: the recording could not be read. Upload a valid audio or video file.`); }
    }
    return { recordings: saved };
  } catch (err) {
    for (const s of saved) await fsp.unlink(resolveStoragePath(s.storagePath)).catch(() => undefined);
    return { error: err.message };
  }
}

module.exports = { EXT, ACCEPT, MEDIA, classify, storeFiles, storeCallFiles, releaseFile, clip };
