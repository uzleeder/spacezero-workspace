'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { decryptText } = require('./credentialCrypto');
const file = path.join(process.env.STORAGE_ROOT || path.join(__dirname, '..', 'storage'), 'employee-export-passwords.json');
function exportPasswords(employees, organizationId) {
  if (!fs.existsSync(file)) return employees;
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  return employees.map(e => {
    const entry = saved[e.id];
    if (!entry || entry.organizationId !== organizationId || entry.username !== e.username) return e;
    // One bad/legacy entry must not 500 the whole export (every other decrypt call site in the
    // codebase already guards this) — skip just that employee's password, keep the rest of the row.
    try { return { ...e, exportPassword: decryptText(entry.value, `employee-export:${organizationId}:${e.id}`) }; }
    catch (err) { console.error(`[employeeExportPasswords] could not decrypt entry for ${e.id}:`, err.message || err); return e; }
  });
}
module.exports = { exportPasswords, file };
