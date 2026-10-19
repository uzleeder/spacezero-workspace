'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ejs = require('ejs');
let count = 0;
function walk(dir) { for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
  const file = path.join(dir,entry.name);
  if(entry.isDirectory()) walk(file);
  else if(file.endsWith('.ejs')) { ejs.compile(fs.readFileSync(file,'utf8'),{filename:file}); count++; }
  else if(/\.(?:js|cjs)$/.test(file)) { const check = spawnSync(process.execPath,['--check',file],{stdio:'inherit'}); if(check.status) process.exit(check.status); }
} }
for(const dir of ['lib','routes','views','public/js']) walk(dir);
if (process.argv.includes('--production')) require('../lib/productionConfig').validateProductionConfig();
console.log(`Validated JavaScript syntax and ${count} EJS templates.`);
