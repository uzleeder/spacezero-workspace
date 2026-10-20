'use strict';

const { mkdir, writeFile } = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

// Files live outside `public/`, so Express never serves them as static
// assets — every read goes through an authenticated route handler, which
// enforces role visibility before streaming.
const STORAGE_ROOT = path.resolve(process.env.STORAGE_ROOT || path.join(__dirname, '..', 'storage'));

const ALLOWED_MIME = {
  VIDEO: ['video/mp4', 'video/webm', 'video/quicktime'],
  PDF: ['application/pdf'],
  PPT: ['application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  DOC: ['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  IMAGE: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  NOTE: [],
  LINK: [],
  // audio/mp4 (.m4a) is what iPhone / Safari record and what phones export; browsers also call .m4a audio/x-m4a.
  CALL_RECORDING: ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'video/mp4', 'video/webm'],
  AUDIO: ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/x-m4a', 'audio/m4a'],
  // AI Practice upload types (Phase 1: upload/organize only, no AI scoring)
  CALL: ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'video/mp4', 'video/webm'],
  SLIDES: ['application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
};

const MAX_SIZE_BYTES = {
  VIDEO: 300 * 1024 * 1024,
  PDF: 40 * 1024 * 1024,
  PPT: 60 * 1024 * 1024,
  DOC: 25 * 1024 * 1024,
  IMAGE: 15 * 1024 * 1024,
  NOTE: 0,
  LINK: 0,
  CALL_RECORDING: 150 * 1024 * 1024,
  CALL: 150 * 1024 * 1024,
  AUDIO: 150 * 1024 * 1024,
  SLIDES: 60 * 1024 * 1024,
};

function validateUpload(itemType, file) {
  const allowed = ALLOWED_MIME[itemType] || [];
  if (!file || !allowed.length || !file.buffer || !file.size || file.size !== file.buffer.length) return 'Invalid upload.';
  if (allowed.length > 0 && !allowed.includes(file.mimetype)) {
    return `File type "${file.mimetype || 'unknown'}" is not allowed for ${itemType}.`;
  }
  const max = MAX_SIZE_BYTES[itemType] || 0;
  if (max > 0 && file.size > max) {
    return `File is too large. Maximum allowed size is ${Math.round(max / (1024 * 1024))} MB.`;
  }
  const b = file.buffer;
  const hex = b.subarray(0, 12).toString('hex');
  const text = b.subarray(0, 12).toString('ascii');
  const matches = {
    'application/pdf': text.startsWith('%PDF-'),
    'image/png': hex.startsWith('89504e470d0a1a0a'),
    'image/jpeg': hex.startsWith('ffd8ff'),
    'image/gif': text.startsWith('GIF87a') || text.startsWith('GIF89a'),
    'image/webp': text.startsWith('RIFF') && text.slice(8) === 'WEBP',
    'audio/wav': text.startsWith('RIFF') && text.slice(8) === 'WAVE',
    'audio/ogg': text.startsWith('OggS'),
    'audio/mpeg': text.startsWith('ID3') || (b[0] === 255 && (b[1] & 224) === 224),
    'audio/mp3': text.startsWith('ID3') || (b[0] === 255 && (b[1] & 224) === 224),
    'video/mp4': text.slice(4,8) === 'ftyp',
    // .m4a is an MP4 file holding audio: the same container signature
    'audio/mp4': text.slice(4,8) === 'ftyp',
    'audio/x-m4a': text.slice(4,8) === 'ftyp',
    'audio/m4a': text.slice(4,8) === 'ftyp',
    'video/quicktime': ['ftyp', 'moov', 'mdat'].includes(text.slice(4,8)),
    'video/webm': hex.startsWith('1a45dfa3'),
    'audio/webm': hex.startsWith('1a45dfa3'),
    'application/msword': hex.startsWith('d0cf11e0a1b11ae1'),
    'application/vnd.ms-powerpoint': hex.startsWith('d0cf11e0a1b11ae1'),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': hex.startsWith('504b0304') && b.includes(Buffer.from('word/')),
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': hex.startsWith('504b0304') && b.includes(Buffer.from('ppt/')),
  };
  if (!matches[file.mimetype]) return 'File contents do not match the selected format.';
  return null;
}

async function saveUpload(file, subdir) {
  const dir = resolveStoragePath(subdir);
  await mkdir(dir, { recursive: true });
  const ext = ({ 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg', 'audio/webm': '.webm', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/m4a': '.m4a', 'application/msword': '.doc', 'application/vnd.ms-powerpoint': '.ppt', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx' })[file.mimetype] || '.bin';
  const id = crypto.randomUUID();
  const filename = `${id}${ext}`;
  await writeFile(path.join(dir, filename), file.buffer, { mode: 0o600, flag: 'wx' });
  // One name for .m4a audio, however the browser labelled it - used for playback and when the AI receives the file.
  return { storagePath: path.posix.join(subdir, filename), mimeType: ['audio/x-m4a', 'audio/m4a'].includes(file.mimetype) ? 'audio/mp4' : file.mimetype };
}

function resolveStoragePath(storagePath) {
  if (typeof storagePath !== 'string' || !storagePath || path.isAbsolute(storagePath) || storagePath.includes(':') || storagePath.includes('\0')) throw new Error('Invalid storage path');
  const resolved = path.resolve(STORAGE_ROOT, storagePath);
  const relative = path.relative(STORAGE_ROOT, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid storage path');
  return resolved;
}

module.exports = { validateUpload, saveUpload, resolveStoragePath };
