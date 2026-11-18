'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-tests-'));
fs.writeFileSync(path.join(folder,'test.db'), '');
const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: `file:${path.join(folder,'test.db').replaceAll('\\','/')}`, STORAGE_ROOT: path.join(folder,'storage') };
env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64'); // fixed throwaway key: tests never touch the real one
for (const key of ['SMTP_HOST','SMTP_FROM','SMTP_USER','SMTP_PASSWORD','SMTP_PORT','RESEND_API_KEY','RESEND_API','RESEND_FROM','ACCOUNT_EMAIL_ORIGIN']) env[key] = '';
function run(args) { const result = spawnSync(process.execPath,args,{env,stdio:'inherit'}); if(result.status !== 0) process.exit(result.status || 1); }
run(['node_modules/prisma/build/index.js','migrate','deploy']);
const only = process.argv.find((a) => a.startsWith('--only='));
run(['--test','--test-concurrency=1',...(only ? [`tests/${only.slice(7)}`] : process.argv.includes('--security') ? ['tests/security.test.js','tests/login-as.test.js'] : fs.readdirSync('tests').filter(f=>f.endsWith('.test.js')).map(f=>`tests/${f}`))]);
console.log('Isolated temporary database tested; application data was not used.');
