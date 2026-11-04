'use strict';
// One-off: loads the SpaceZero office inventory (from "SpaceZero office PC.xlsx", the product summary) into Office
// Management, for the office manager's organization. Every item starts in "Office / storage"; the office manager
// then gives items to people. Safe to run again: it does nothing when the office list already has items.
// Usage: node scripts/office-seed.cjs
const { prisma } = require('../lib/prisma');

// [name, type, quantity] - type: COMPUTER | MONITOR | HEADPHONES | CASE | TV | OTHER
const INVENTORY = [
  ['Monitor Ziffler 24"', 'MONITOR', 28],
  ['Monitor Redmi 27"', 'MONITOR', 6],
  ['Monitor Redmi 24"', 'MONITOR', 14],
  ['Case myPro', 'CASE', 17],
  ['Case Aero BK', 'CASE', 7],
  ['Mouse', 'OTHER', 23],
  ['Keyboard', 'OTHER', 21],
  ['Chair', 'OTHER', 25],
  ['Table', 'OTHER', 24],
  ['TV', 'TV', 1],
  ['Headphone', 'HEADPHONES', 22],
  ['Fridge', 'OTHER', 1],
  ['Microwave', 'OTHER', 1],
  ['Boiler', 'OTHER', 1],
  ['Printer', 'OTHER', 1],
  ['Kitchen table', 'OTHER', 2],
  ['Kitchen chair', 'OTHER', 8],
  ['Mouse pad', 'OTHER', 24],
  ['Coffee Machine', 'OTHER', 1],
];

(async () => {
  const manager = await prisma.profile.findFirst({ where: { officeManager: true }, select: { id: true, organizationId: true, fullName: true } });
  if (!manager) { console.log('No office manager found: nothing loaded.'); return; }
  const existing = await prisma.officeItem.count({ where: { organizationId: manager.organizationId } });
  if (existing) { console.log(`The office list already has ${existing} items: nothing loaded.`); return; }
  const rows = [];
  for (const [name, type, qty] of INVENTORY) {
    for (let i = 1; i <= qty; i++) rows.push({ organizationId: manager.organizationId, name: qty === 1 ? name : `${name} ${i}`, type, condition: 'GOOD', createdById: manager.id });
  }
  await prisma.officeItem.createMany({ data: rows });
  console.log(`Loaded ${rows.length} items (${INVENTORY.length} products) for ${manager.fullName}.`);
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
