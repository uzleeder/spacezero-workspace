'use strict';
// A probe program that cannot start (wrong CPU type on an Apple Silicon Mac, missing file) is skipped for the next one;
// a program that starts and says the file is bad is the answer.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { probeMedia, candidates } = require('../lib/mediaProbe');
const { resolveStoragePath } = require('../lib/storage');

const saved = process.env.FFPROBE_PATH;
after(() => { if (saved === undefined) delete process.env.FFPROBE_PATH; else process.env.FFPROBE_PATH = saved; });

function wav(seconds) {
  const bytes = 16000 * seconds; const data = Buffer.alloc(44 + bytes);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(bytes, 40);
  return data;
}

test('a probe program that cannot start is skipped; a bad file is still reported as bad', async () => {
  fs.mkdirSync(resolveStoragePath('training'), { recursive: true });
  const good = `training/probe-${Date.now()}.wav`; const bad = `training/probe-${Date.now()}.txt`;
  fs.writeFileSync(resolveStoragePath(good), wav(2)); fs.writeFileSync(resolveStoragePath(bad), '');
  process.env.FFPROBE_PATH = resolveStoragePath('training/no-such-ffprobe');               // the first choice does not exist
  assert.equal(candidates()[0], process.env.FFPROBE_PATH); assert.ok(candidates().length >= 2);
  const seconds = await probeMedia(good);                                                    // ... and the next one answers
  assert.ok(seconds > 1.9 && seconds < 2.1, `duration ${seconds}`);
  await assert.rejects(() => probeMedia(bad));                                               // a started program that rejects the file: an error, not a retry loop
  for (const f of [good, bad]) fs.unlinkSync(resolveStoragePath(f));
});
