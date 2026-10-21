'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolveStoragePath } = require('./storage');

// Which ffprobe to run: FFPROBE_PATH, else the bundled ffprobe-static binary, else one installed on the computer
// (Homebrew, then the PATH). The bundled "darwin/arm64" build is an Intel binary that an Apple Silicon Mac without
// Rosetta cannot start - every upload used to fail there. Only a binary that cannot START is skipped; a file
// ffprobe ran on and could not read is still an error. The first binary that starts is remembered.
const bundled = () => { try { return require('ffprobe-static').path; } catch { return null; } };
const candidates = () => [...new Set([process.env.FFPROBE_PATH, bundled(), '/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe', 'ffprobe'].filter(Boolean))];
// A spawn failure (missing, not executable, wrong CPU type) has a string code; a run that exited badly has a number.
const couldNotStart = (err) => Boolean(err) && typeof err.code === 'string';
let working = null;

async function runFfprobe(args, options) {
  const order = working ? [working, ...candidates().filter((c) => c !== working)] : candidates();
  for (const bin of order) {
    try {
      const out = await promisify(execFile)(bin, args, options);
      working = bin;
      return out;
    } catch (err) {
      if (!couldNotStart(err)) throw err;
      if (bin === working) working = null;
    }
  }
  throw new Error('ffprobe could not be started. Install ffmpeg (for example "brew install ffmpeg") or set FFPROBE_PATH.');
}

async function probeMedia(storagePath) {
  const { stdout } = await runFfprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', resolveStoragePath(storagePath)], { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true });
  const duration = Number(JSON.parse(stdout).format?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 8 * 3600) throw new Error('Recording must have a valid duration of up to 8 hours.');
  return duration;
}
module.exports = { probeMedia, candidates, couldNotStart };
