'use strict';
const fs = require('node:fs');
const path = require('node:path');
function buildConfig(value) {
  let origin;
  try { origin = new URL(value); } catch { throw new Error('Set BACKEND_ORIGIN to the HTTPS origin of the running SpaceZero backend.'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' || ['localhost','127.0.0.1','[::1]'].includes(origin.hostname) || origin.hostname.endsWith('.invalid')) throw new Error('BACKEND_ORIGIN must be a public HTTPS origin without credentials, path or query.');
  return { version: 3, routes: [{ src: '/(.*)', dest: `${origin.origin}/$1`, headers: { 'Cache-Control': 'private, no-store' } }] };
}
if (require.main === module) {
  const config = buildConfig(process.env.BACKEND_ORIGIN);
  const folder = path.join(__dirname, '.vercel', 'output');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'config.json'), JSON.stringify(config, null, 2));
  console.log('Vercel gateway prepared. Application, PostgreSQL, private files and AI jobs run on the backend.');
}
module.exports = { buildConfig };
