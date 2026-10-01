'use strict';

// Builds a shareable/deployable ZIP of the project that can never carry secrets or local data:
//   * NOT included: .env files (only .env.production.example, which holds placeholders), local databases,
//     uploaded/private files (storage, public/uploads), logs, sessions/temp data, node_modules, editor/agent
//     folders, generated clients, earlier release ZIPs, private keys, ngrok logs.
//   * After the list is built, every text file that WILL be included is scanned for secret-looking values
//     (API keys, private keys, real-looking key assignments). Any hit stops the build.
// Usage: node scripts/package-release.cjs [--check]   (--check verifies without writing a ZIP)
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// Directory names that are never packaged, at any depth.
const EXCLUDED_DIRS = new Set(['node_modules', '.git', '.claude', '.codex', '.vercel', '.idea', '.vscode', 'storage', 'uploads', 'generated', 'coverage', 'dist', 'tmp', 'temp', 'sessions', '.next', 'build', 'deploy', 'logs']);
// File names / patterns that are never packaged.
const EXCLUDED_FILE = [
  /^\.env(\..*)?$/,            // .env, .env.local, .env.production ...
  /\.(db|sqlite|sqlite3)(-journal|-wal|-shm)?$/i, // local databases
  /\.(log|tmp|swp)$/i,
  /\.(zip|tgz|tar|gz)$/i,      // earlier packages
  /\.(pem|key|p12|pfx)$/i,     // private keys / certificates
  /^ngrok/i,
  /^\.DS_Store$/, /^Thumbs\.db$/i,
  /-Demo\.html$/i,             // shareable demo builds are produced separately and may embed data
];
const ALLOWED_ENV = new Set(['.env.production.example']); // placeholders only

function shouldExclude(relPath) {
  const parts = relPath.split(/[\\/]/);
  const name = parts[parts.length - 1];
  if (ALLOWED_ENV.has(name)) return false;
  if (parts.slice(0, -1).some((d) => EXCLUDED_DIRS.has(d))) return true;
  return EXCLUDED_FILE.some((re) => re.test(name));
}

function collectFiles(root = ROOT) {
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) { if (!EXCLUDED_DIRS.has(entry.name)) walk(full); continue; }
      if (entry.isFile() && !shouldExclude(rel)) out.push(rel.split(path.sep).join('/'));
    }
  })(root);
  return out.sort();
}

// Secret-looking content. Placeholders ("...", "change-me", "your-key", empty) are fine.
const SECRET_PATTERNS = [
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'Slack/Stripe-style token', re: /\b(?:xox[abp]-|sk_live_|rk_live_)[0-9A-Za-z-]{10,}/ },
  { name: 'assigned secret', re: /^[ \t]*(?:GEMINI_API_KEY|CREDENTIAL_ENCRYPTION_KEY|SMTP_PASSWORD|DATABASE_URL|SESSION_SECRET)[ \t]*=[ \t]*["']?(?!\s|["']|$|<|\$|\.\.\.|change|your|example|placeholder|xxx|postgres(?:ql)?:\/\/USER|postgres(?:ql)?:\/\/user|file:)[^\s"']{12,}/im },
];
const TEXT_EXT = /\.(js|cjs|mjs|json|md|ejs|css|html|txt|yml|yaml|toml|prisma|sql|example|env|conf|sh|ps1|gitignore|dockerignore|vercelignore)$/i;

function scanForSecrets(files, root = ROOT) {
  const hits = [];
  for (const rel of files) {
    if (!TEXT_EXT.test(rel) && !/(^|\/)(Dockerfile|\.[a-z.]*ignore|\.env\.production\.example)$/i.test(rel)) continue;
    const full = path.join(root, rel);
    if (fs.statSync(full).size > 2 * 1024 * 1024) continue;
    const text = fs.readFileSync(full, 'utf8');
    for (const p of SECRET_PATTERNS) if (p.re.test(text)) hits.push({ file: rel, pattern: p.name });
  }
  return hits;
}

/** Everything the release would contain, plus any problem found. */
function plan(root = ROOT) {
  const files = collectFiles(root);
  const forbidden = files.filter((f) => shouldExclude(f));
  return { files, forbidden, secrets: scanForSecrets(files, root) };
}

function build(root = ROOT) {
  const result = plan(root);
  if (result.forbidden.length || result.secrets.length) {
    const lines = [...result.forbidden.map((f) => `forbidden file: ${f}`), ...result.secrets.map((s) => `secret-looking content (${s.pattern}): ${s.file}`)];
    throw new Error(`Release blocked:\n  ${lines.join('\n  ')}`);
  }
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  for (const rel of result.files) zip.addLocalFile(path.join(root, rel), path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel));
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  const target = path.join(dist, `spacezero-academy-${new Date().toISOString().slice(0, 10)}.zip`);
  zip.writeZip(target);
  return { target, count: result.files.length };
}

if (require.main === module) {
  try {
    if (process.argv.includes('--check')) {
      const r = plan();
      if (r.forbidden.length || r.secrets.length) { console.error(JSON.stringify({ forbidden: r.forbidden, secrets: r.secrets }, null, 2)); process.exit(1); }
      console.log(`OK: ${r.files.length} files would be packaged; no secrets, env files, databases, uploads or logs.`);
    } else {
      const { target, count } = build();
      console.log(`Packaged ${count} files -> ${path.relative(ROOT, target)}`);
    }
  } catch (err) { console.error(err.message); process.exit(1); }
}

module.exports = { shouldExclude, collectFiles, scanForSecrets, plan, build, EXCLUDED_DIRS };
