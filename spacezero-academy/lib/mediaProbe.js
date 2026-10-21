'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolveStoragePath } = require('./storage');

const run = promisify(execFile);

// Which ffprobe to try, in order: the one named by FFPROBE_PATH (the production image uses the system one), the one
// bundled with the app, and the system's own. The bundled "arm64" binary is really an x86-64 program on Apple Silicon
// Macs (it cannot even start: "spawn Unknown system error -86"), so a program that fails to START is skipped and the next
// is tried - a program that starts and says the FILE is bad is the answer, and is not retried.
function candidates() {
  let bundled = null;
  try { bundled = require('ffprobe-static').path; } catch { /* not installed here: the system one is used */ }
  return [...new Set([process.env.FFPROBE_PATH, bundled, 'ffprobe'].filter(Boolean))];
}
const failedToStart = (err) => /^spawn/.test(String(err.syscall || '')) || ['ENOENT', 'EACCES', 'EBADARCH', 'ENOEXEC'].includes(err.code) || err.errno === -86;

async function probeMedia(storagePath) {
  const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', resolveStoragePath(storagePath)];
  let stdout; let lastError;
  for (const program of candidates()) {
    try { ({ stdout } = await run(program, args, { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true })); lastError = null; break; }
    catch (err) { lastError = err; if (!failedToStart(err)) break; }
  }
  if (lastError) throw lastError;
  const duration = Number(JSON.parse(stdout).format?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 8 * 3600) throw new Error('Recording must have a valid duration of up to 8 hours.');
  return duration;
}
module.exports = { probeMedia, candidates };
