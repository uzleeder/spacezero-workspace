'use strict';
// One-off: loads the SpaceZero office inventory (scripts/office-inventory.cjs) into Office Management for the office
// manager's organization. Each item gets its own asset tag (SZ-0001 ...), its model and category; all start in
// "Storage", unassigned and NOT marked as physically checked (the office manager checks them). Safe to run again: it does
// nothing when the office list already has items.
// Usage: node scripts/office-seed.cjs
const { prisma } = require('../lib/prisma');
const { nextTags } = require('../lib/office');
const INVENTORY = require('./office-inventory.cjs');

(async () => {
  const manager = await prisma.profile.findFirst({ where: { officeManager: true }, select: { id: true, organizationId: true, fullName: true } });
  if (!manager) { console.log('No office manager found: nothing loaded.'); return; }
  const existing = await prisma.officeItem.count({ where: { organizationId: manager.organizationId } });
  if (existing) { console.log(`The office list already has ${existing} items: nothing loaded.`); return; }
  const total = INVENTORY.reduce((n, [, , qty]) => n + qty, 0);
  const tags = await nextTags(prisma, manager.organizationId, total);
  const rows = [];
  for (const [product, type, qty] of INVENTORY) {
    for (let i = 1; i <= qty; i++) {
      rows.push({ organizationId: manager.organizationId, assetTag: tags[rows.length], name: qty === 1 ? product : `${product} ${i}`, model: product, type, location: 'Storage', condition: 'GOOD', createdById: manager.id });
    }
  }
  await prisma.officeItem.createMany({ data: rows });
  console.log(`Loaded ${rows.length} items (${INVENTORY.length} products, tags ${rows[0].assetTag} to ${rows[rows.length - 1].assetTag}) for ${manager.fullName}.`);
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
