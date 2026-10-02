'use strict';
// Cache-busting URLs for the app's own CSS/JS. Every asset URL carries a short hash of the file
// contents, so the browser may keep it for a year and never asks the server again — until a deploy
// actually changes the file, which changes the hash and therefore the URL.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PRODUCTION = process.env.NODE_ENV === 'production';
const cache = new Map(); // url -> { mtimeMs, hash }

function hashOf(url) {
  const full = path.join(PUBLIC_DIR, url.replace(/^\/static\//, ''));
  try {
    const mtimeMs = PRODUCTION ? 0 : fs.statSync(full).mtimeMs;
    const known = cache.get(url);
    if (known && known.mtimeMs === mtimeMs) return known.hash;
    const hash = crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex').slice(0, 10);
    cache.set(url, { mtimeMs, hash });
    return hash;
  } catch { return 'x'; }
}

/**
 * '/static/js/app.js' -> '/static/js/app.js?v=3fa9c1d2e0' (other urls are returned unchanged).
 * In production the hash is computed once per process (files only change on deploy, which restarts
 * the app); in development it follows the file, so edits show up without a restart.
 */
function asset(url) {
  if (!/^\/static\/(js|css)\//.test(url)) return url;
  return `${url}?v=${hashOf(url)}`;
}

module.exports = { asset };
