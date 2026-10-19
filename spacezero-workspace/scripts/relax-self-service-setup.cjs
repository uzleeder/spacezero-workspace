'use strict';
// One-time data fix for organizations whose Setup requirements were seeded before the
// self-attestable default items (PC, tool/account access, extensions — see DEFAULT_REQUIREMENTS in
// lib/employeeSetup.js) moved from MANAGEMENT_VERIFICATION to EMPLOYEE_CONFIRMATION: "I Have" on one
// of these previously only set IN_PROGRESS pending a Supervisor/Admin review that was never actually
// needed, since only the employee can really know whether they have a PC or are logged into a tool.
//
// Deliberately NOT run automatically on every request (unlike the Telegram/Passport Details
// migrations in ensureDefaultRequirements): "is this row still MANAGEMENT_VERIFICATION" is not a safe
// signal to recheck forever, since that is the exact value an Admin might deliberately choose again
// later — re-running this every request would silently overwrite that choice. Run it once, by hand,
// against whichever database DATABASE_URL points at (same convention as prisma/seed.js):
//   node scripts/relax-self-service-setup.cjs
const { PrismaClient } = require('@prisma/client');
const { DEFAULT_REQUIREMENTS } = require('../lib/employeeSetup');

const prisma = new PrismaClient();

async function main() {
  const keys = DEFAULT_REQUIREMENTS.filter((r) => r.verification === 'EMPLOYEE_CONFIRMATION').map((r) => r.key);

  const relaxed = await prisma.setupRequirement.updateMany({
    where: { key: { in: keys }, verification: 'MANAGEMENT_VERIFICATION' },
    data: { verification: 'EMPLOYEE_CONFIRMATION' },
  });

  // An employee who already clicked "I Have" under the old stricter rule is sitting at IN_PROGRESS,
  // awaiting a verification step that no longer applies — promote those to COMPLETED now instead of
  // silently waiting for the employee to click "I Have" again.
  const promoted = await prisma.employeeSetupItem.updateMany({
    where: {
      status: 'IN_PROGRESS',
      employeeConfirmedAt: { not: null },
      requirement: { key: { in: keys }, verification: 'EMPLOYEE_CONFIRMATION' },
    },
    data: { status: 'COMPLETED' },
  });

  console.log(`Relaxed ${relaxed.count} requirement row(s); promoted ${promoted.count} pending item(s) to Completed.`);
}

main()
  .catch((err) => { console.error('Migration failed:', err.message); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
