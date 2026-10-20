'use strict';

// Training uploads (AI Practice material, training files, call recordings, Library items) have NO size or count limit.
//
// The files are streamed straight to disk while they arrive instead of being held in memory, so a very large video
// cannot exhaust the server's memory, and the content checks in lib/storage.js read only the beginning and the end of
// the file. The temporary copy sits inside the private storage folder (same disk, so storing it is a rename) and is
// removed when the request ends, whatever the outcome; anything left by a crash is swept at start-up.
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const { STORAGE_ROOT } = require('./storage');

const TMP_DIR = path.join(STORAGE_ROOT, '.uploading');
const DAY_MS = 24 * 60 * 60 * 1000;

const storage = multer.diskStorage({
  destination: (req, file, cb) => fsp.mkdir(TMP_DIR, { recursive: true, mode: 0o700 }).then(() => cb(null, TMP_DIR), cb),
  filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.part`),
});

/** multer with no file-size and no file-count limit (a generous cap on ordinary form fields only). */
function unlimitedUpload({ fields = 200 } = {}) {
  return multer({ storage, limits: { fields, fieldSize: 2 * 1024 * 1024 } });
}

/** Removes the temporary copies of this request's files once the response is done (stored files were renamed away). */
function cleanupWhenDone(req, res) {
  const files = () => [].concat(req.files || [], req.file || []).filter((f) => f && f.path);
  const remove = () => { for (const f of files()) fsp.unlink(f.path).catch(() => undefined); };
  res.once('close', remove);
}

/** Wraps a multer handler so temp files never outlive the request. */
const withCleanup = (handler) => (req, res, next) => { cleanupWhenDone(req, res); handler(req, res, next); };

/** Deletes temporary upload files older than a day (left behind by a crash or a cut connection). */
async function sweepStaleUploads() {
  let names;
  try { names = await fsp.readdir(TMP_DIR); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    const file = path.join(TMP_DIR, name);
    try { const stat = await fsp.stat(file); if (Date.now() - stat.mtimeMs > DAY_MS) { await fsp.unlink(file); removed += 1; } } catch { /* already gone */ }
  }
  return removed;
}

module.exports = { TMP_DIR, unlimitedUpload, withCleanup, sweepStaleUploads };
