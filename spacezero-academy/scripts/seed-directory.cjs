'use strict';
// Loads the real Above9 employee directory (see prisma/directory.js).
//   node scripts/seed-directory.cjs --dry-run     show what would change, write nothing
//   node scripts/seed-directory.cjs               apply (idempotent, never deletes anyone)
// People are created INVITED with no password and no e-mail is sent; activate them from
// Employees & Teams (Resend invite).
const { PrismaClient } = require('@prisma/client');
const { applyDirectory } = require('../prisma/directory');

async function main() {
  const prisma = new PrismaClient();
  try {
    const dryRun = process.argv.includes('--dry-run');
    const orgArg = process.argv.indexOf('--org');
    const organizationId = orgArg > -1 ? process.argv[orgArg + 1] : 'org_above9travel';
    if (!(await prisma.organization.findUnique({ where: { id: organizationId } }))) throw new Error(`Organization ${organizationId} not found. Run the base seed first.`);
    const report = await applyDirectory(prisma, organizationId, { dryRun });
    console.log(dryRun ? 'DRY RUN — nothing was written.' : 'Directory applied.');
    for (const [key, value] of Object.entries(report)) {
      if (Array.isArray(value)) { console.log(`${key}: ${value.length}`); value.forEach((v) => console.log('  - ' + v)); }
      else console.log(`${key}: ${value}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((err) => { console.error(err.message); process.exit(1); });