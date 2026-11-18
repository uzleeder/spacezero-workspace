'use strict';
// Loads desks (Office Management -> Desks by team) from a JSON file into the office manager's organization:
//   node scripts/office-import-desks.cjs <desks.json>
// desks.json: [{ number, team, name, monitor, pcCase, keyboard, mouse, headphone, password, note }, ...]
// The JSON holds computer passwords: keep it OUT of the repository and delete it after loading. Passwords are stored
// encrypted (lib/officeDesks.js). A desk number that already exists is updated; "name" is matched to an active
// employee by full name, else by a first name only one person has; otherwise it is kept as written (e.g. "New").
const fs = require('fs');
const { prisma } = require('../lib/prisma');
const { encryptText } = require('../lib/credentialCrypto');
const { aadOf, FIELDS } = require('../lib/officeDesks');

(async () => {
  const file = process.argv[2];
  if (!file) { console.log('Usage: node scripts/office-import-desks.cjs <desks.json>'); return; }
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  const manager = await prisma.profile.findFirst({ where: { officeManager: true }, select: { organizationId: true, fullName: true } });
  if (!manager) { console.log('No office manager found: nothing loaded.'); return; }
  const people = await prisma.profile.findMany({ where: { organizationId: manager.organizationId, status: { not: 'ARCHIVED' }, testOwnerAdminId: null }, select: { id: true, fullName: true } });
  const lc = (s) => String(s || '').trim().toLowerCase();
  const match = (name) => {
    if (!lc(name)) return null;
    const full = people.filter((p) => lc(p.fullName) === lc(name));
    if (full.length === 1) return full[0];
    const first = people.filter((p) => lc(p.fullName).split(/\s+/)[0] === lc(name));
    return first.length === 1 ? first[0] : null;
  };
  let linked = 0, kept = 0, withPassword = 0;
  for (const r of rows) {
    const person = match(r.name);
    const data = { team: r.team || null, profileId: person ? person.id : null, personName: person ? null : (r.name || null), note: r.note || null };
    for (const f of FIELDS) data[f] = r[f] || null;
    const desk = await prisma.officeDesk.upsert({
      where: { organizationId_number: { organizationId: manager.organizationId, number: Number(r.number) } },
      create: { organizationId: manager.organizationId, number: Number(r.number), ...data },
      update: data,
    });
    if (r.password) { await prisma.officeDesk.update({ where: { id: desk.id }, data: { passwordEnc: encryptText(String(r.password), aadOf(desk.id)) } }); withPassword += 1; }
    if (person) linked += 1; else kept += 1;
  }
  console.log(`Loaded ${rows.length} desks for ${manager.fullName}: ${linked} linked to employees, ${kept} kept by name, ${withPassword} with a computer password.`);
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
