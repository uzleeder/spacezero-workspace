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
    return { ...e, exportPassword: decryptText(entry.value, `employee-export:${organizationId}:${e.id}`) };
  });
}
module.exports = { exportPasswords, file };
