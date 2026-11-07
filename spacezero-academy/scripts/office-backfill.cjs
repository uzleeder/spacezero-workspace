'use strict';
// Office Management backfill for records created before asset tags/models existed (migration 20261106120000).
//   node scripts/office-backfill.cjs                    dry run: prints what would change, changes nothing
//   node scripts/office-backfill.cjs --apply            applies it in one transaction and writes a report file
//   node scripts/office-backfill.cjs --revert <report>  puts back the values recorded in that report
// What it does, per organization:
//   * asset tags: every item without one gets the next free tag (SZ-0001 ...), oldest first, then in the handed-over list's order, then by natural name -
//     never reusing or colliding with an existing tag
//   * model and category: only where the name is EXACTLY a product from the handed-over list (scripts/
//     office-inventory.cjs), or that product followed by a number the import added ("Mouse 7"). Anything else is
//     marked Needs review - nothing is guessed or merged
//   * locations, holders, desks, conditions and physical checks are not touched: an item without a location stays
//     "Needs review" until the office manager records where it is
// Checks before and after: record counts per organization, items pointing at a missing person/desk, duplicate tags.
const fs = require('fs');
const { prisma } = require('../lib/prisma');
const { naturalCompare, formatTag, tagNumber } = require('../lib/office');
const INVENTORY = require('./office-inventory.cjs');

const PRODUCTS = new Map(INVENTORY.map(([product, type]) => [product, type]));
const ORDER = new Map(INVENTORY.map(([product], n) => [product, n]));
const rank = (name) => { const p = productFor(name); return p ? ORDER.get(p) : INVENTORY.length; };
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function productFor(name) {
  if (PRODUCTS.has(name)) return name;
  for (const p of PRODUCTS.keys()) if (new RegExp(`^${escape(p)} \\d+$`).test(name)) return p;
  return null;
}

async function checks() {
  const items = await prisma.officeItem.findMany({ select: { id: true, organizationId: true, assetTag: true, holderId: true, deskId: true } });
  const profiles = new Set((await prisma.profile.findMany({ select: { id: true } })).map((p) => p.id));
  const deskIds = new Set((await prisma.officeDesk.findMany({ select: { id: true } })).map((d) => d.id));
  const perOrg = {};
  const seen = new Map(); let duplicates = 0;
  for (const i of items) {
    perOrg[i.organizationId] = (perOrg[i.organizationId] || 0) + 1;
    if (i.assetTag) { const k = i.organizationId + '|' + i.assetTag; if (seen.has(k)) duplicates++; seen.set(k, true); }
  }
  return {
    total: items.length, perOrganization: perOrg,
    withoutTag: items.filter((i) => !i.assetTag).length,
    orphanHolder: items.filter((i) => i.holderId && !profiles.has(i.holderId)).length,
    orphanDesk: items.filter((i) => i.deskId && !deskIds.has(i.deskId)).length,
    duplicateTags: duplicates,
  };
}

async function plan() {
  const items = await prisma.officeItem.findMany({ select: { id: true, organizationId: true, assetTag: true, name: true, model: true, type: true, needsReview: true, createdAt: true } });
  const byOrg = new Map();
  for (const i of items) { if (!byOrg.has(i.organizationId)) byOrg.set(i.organizationId, []); byOrg.get(i.organizationId).push(i); }
  const changes = [];
  for (const list of byOrg.values()) {
    let next = list.reduce((m, i) => Math.max(m, tagNumber(i.assetTag)), 0);
    const untagged = list.filter((i) => !i.assetTag).sort((a, b) => a.createdAt - b.createdAt || rank(a.name) - rank(b.name) || naturalCompare(a.name, b.name));
    const tagFor = new Map(untagged.map((i) => [i.id, formatTag(++next)]));
    for (const i of list) {
      const data = {};
      if (tagFor.has(i.id)) data.assetTag = tagFor.get(i.id);
      if (!i.model) {
        const product = productFor(i.name);
        if (product) { data.model = product; if (i.type !== PRODUCTS.get(product)) data.type = PRODUCTS.get(product); }
        else if (!i.needsReview) data.needsReview = true;
      }
      if (Object.keys(data).length) changes.push({ id: i.id, name: i.name, before: Object.fromEntries(Object.keys(data).map((k) => [k, i[k] ?? null])), after: data });
    }
  }
  return changes;
}

(async () => {
  const args = process.argv.slice(2);
  if (args[0] === '--revert') {
    const report = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    await prisma.$transaction(report.changes.map((c) => prisma.officeItem.update({ where: { id: c.id }, data: c.before })));
    console.log(`Reverted ${report.changes.length} items from ${args[1]}.`, await checks());
    return;
  }
  const before = await checks();
  const changes = await plan();
  const count = (k) => changes.filter((c) => k in c.after).length;
  console.log('Before:', before);
  console.log(`Plan: ${changes.length} items change - ${count('assetTag')} get an asset tag, ${count('model')} get a model from the handed-over list (${count('type')} of them a new category), ${count('needsReview')} marked Needs review.`);
  for (const c of changes.slice(0, 8)) console.log('  ', c.name, JSON.stringify(c.after));
  if (!args.includes('--apply')) { console.log('Dry run: nothing changed. Run with --apply to apply.'); return; }
  const file = `office-backfill-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), changes }, null, 1));
  await prisma.$transaction(changes.map((c) => prisma.officeItem.update({ where: { id: c.id }, data: c.after })));
  const after = await checks();
  console.log('After:', after);
  if (after.total !== before.total) { console.error('Record count changed - check the database.'); process.exitCode = 1; }
  console.log(`Applied. To undo: node scripts/office-backfill.cjs --revert ${file}`);
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
