'use strict';
// One-off clean-up of people who were given the same training twice (the older copy stays Overdue and keeps sending
// reminders). Keeps the copy that was worked on (else the newest) and removes older copies nobody has touched.
//   node scripts/merge-duplicate-assignments.cjs            -> only counts (dry run)
//   node scripts/merge-duplicate-assignments.cjs --apply    -> removes them
const { prisma } = require('../lib/prisma');
const { mergeDuplicateOpenCopies } = require('../lib/assignmentMerge');

(async () => {
  const apply = process.argv.includes('--apply');
  for (const org of await prisma.organization.findMany({ select: { id: true, name: true } })) {
    const result = await mergeDuplicateOpenCopies(org.id, { dryRun: !apply });
    console.log(`${org.name}: ${result.people} people with duplicate open copies, ${result.removed} ${apply ? 'removed' : 'would be removed'}`);
  }
  if (!apply) console.log('Dry run only. Add --apply to remove them.');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
