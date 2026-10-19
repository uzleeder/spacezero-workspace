'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolveStoragePath } = require('./storage');
async function probeMedia(storagePath) {
  const { stdout } = await promisify(execFile)(process.env.FFPROBE_PATH || require('ffprobe-static').path, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', resolveStoragePath(storagePath)], { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true });
  const duration = Number(JSON.parse(stdout).format?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 8 * 3600) throw new Error('Recording must have a valid duration of up to 8 hours.');
  return duration;
}
module.exports = { probeMedia };
