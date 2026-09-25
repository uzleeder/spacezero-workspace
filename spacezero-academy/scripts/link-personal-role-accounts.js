'use strict';
// Explicit ownership mapping supplied by the administrator. Never infer
// ownership from a generic createdById or employee name.
const { prisma } = require('../lib/prisma');
async function main() {
  let linked = 0;
  await prisma.$transaction(async tx => {
    for (const username of ['admin', 'ali', 'joe', 'tom']) {
      const owner = await tx.profile.findUnique({ where: { username } });
      if (!owner || owner.role !== 'ADMIN') throw new Error(`Admin not found: ${username}`);
      for (const [suffix, role] of [['agent', 'TRAVEL_AGENT'], ['supervisor', 'SUPERVISOR'], ['expert', 'FLIGHT_EXPERT']]) {
        const account = await tx.profile.findUnique({ where: { username: `${username}-${suffix}` } });
        if (!account || account.role !== role || account.organizationId !== owner.organizationId || (account.testOwnerAdminId && account.testOwnerAdminId !== owner.id)) throw new Error(`Ownership mismatch: ${username}-${suffix}`);
        if (account.testOwnerAdminId === owner.id) continue;
        await tx.profile.update({ where: { id: account.id }, data: { testOwnerAdminId: owner.id } });
        await tx.session.deleteMany({ where: { profileId: account.id } });
        await tx.auditLog.create({ data: { organizationId: owner.organizationId, action: 'profile.test_owner_mapped', targetTable: 'Profile', targetId: account.id, metadataJson: JSON.stringify({ ownerAdminId: owner.id, source: 'administrator_supplied_mapping' }) } });
        linked++;
      }
    }
  });
  console.log(`Linked ${linked} personal accounts; previous sessions revoked.`);
}
main().catch(() => { console.error('Ownership mapping failed; transaction rolled back.'); process.exitCode = 1; }).finally(() => prisma.$disconnect());
