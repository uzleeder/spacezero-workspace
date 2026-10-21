'use strict';
// iPhone / Safari audio (.m4a, recorded as audio/mp4) is accepted for voice practice and call uploads - still
// only when the file really is an MP4 container - and ffprobe falls back to one that can start when the bundled
// binary cannot (the bundled "darwin/arm64" build is an Intel binary an Apple Silicon Mac cannot run).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateUpload, saveUpload } = require('../lib/storage');
const { couldNotStart } = require('../lib/mediaProbe');

// The first bytes of an .m4a file: an ISO base media "ftyp" box with the M4A brand.
const m4a = () => Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(4), Buffer.from('M4A isommp42'), Buffer.alloc(64)]);
const upload = (buffer, mimetype, originalname = 'response.m4a') => ({ buffer, mimetype, size: buffer.length, originalname });

test('.m4a audio is accepted for voice practice and both kinds of call upload, under every name browsers give it', () => {
  for (const kind of ['AUDIO', 'CALL', 'CALL_RECORDING']) {
    for (const mimetype of ['audio/mp4', 'audio/x-m4a', 'audio/m4a']) assert.equal(validateUpload(kind, upload(m4a(), mimetype)), null, `${kind} ${mimetype}`);
  }
});

test('a file that only claims to be .m4a audio is still refused', () => {
  assert.equal(validateUpload('AUDIO', upload(Buffer.from('MZ this is not audio at all, just bytes......'), 'audio/mp4')), 'File contents do not match the selected format.');
  assert.match(validateUpload('AUDIO', upload(m4a(), 'audio/aac')), /not allowed/);
});

test('an .m4a upload is stored as .m4a under one type (audio/mp4), and a source file named .m4a counts as audio', async () => {
  const saved = await saveUpload(upload(m4a(), 'audio/x-m4a'), 'voice-drafts');
  assert.match(saved.storagePath, /\.m4a$/);
  assert.equal(saved.mimeType, 'audio/mp4');
  const { classify } = require('../lib/sourceFiles');
  assert.equal(classify(upload(m4a(), 'application/octet-stream', 'call.m4a')).contentType, 'AUDIO');
});

test('only a binary that cannot START is skipped; one that ran and failed is a real error', () => {
  assert.equal(couldNotStart(Object.assign(new Error('spawn'), { code: 'Unknown system error -86' })), true); // wrong CPU type
  assert.equal(couldNotStart(Object.assign(new Error('spawn'), { code: 'ENOENT' })), true);
  assert.equal(couldNotStart(Object.assign(new Error('Command failed'), { code: 1 })), false);
  assert.equal(couldNotStart(Object.assign(new Error('timed out'), { code: null, killed: true })), false);
});

/** Runs probeMedia in a fresh process (its own environment and remembered binary). */
function probeIn(env, file) {
  const script = `require(${JSON.stringify(path.join(__dirname, '../lib/mediaProbe'))}).probeMedia(${JSON.stringify(file)}).then((d) => console.log('OK ' + d), (e) => console.log('ERR ' + e.message.split('\\n')[0]))`;
  return spawnSync(process.execPath, ['-e', script], { env: { ...process.env, ...env }, encoding: 'utf8' }).stdout.trim();
}

test('ffprobe falls back to one that can start, and a broken recording still fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffprobe-fallback-'));
  fs.writeFileSync(path.join(dir, 'ffprobe'), '#!/bin/sh\necho \'{"format":{"duration":"12.5"}}\'\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'broken'), '#!/bin/sh\necho "Invalid data found" >&2\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'clip.m4a'), m4a());
  const base = { STORAGE_ROOT: dir, PATH: `${dir}:${process.env.PATH}` };
  // FFPROBE_PATH cannot start -> the next candidate that starts is used (here the one on the PATH)
  assert.equal(probeIn({ ...base, FFPROBE_PATH: path.join(dir, 'missing') }, 'clip.m4a'), 'OK 12.5');
  // an ffprobe that ran and could not read the file is an error - no other binary is tried
  assert.match(probeIn({ ...base, FFPROBE_PATH: path.join(dir, 'broken') }, 'clip.m4a'), /^ERR Command failed/);
});
