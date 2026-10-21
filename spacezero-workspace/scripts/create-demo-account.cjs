'use strict';
// LOCAL DEMO ONLY. Creates (or refreshes) a ready-to-use demo Admin, "demo", plus that Admin's personal test
// accounts (demo-agent, demo-supervisor, demo-expert), so My Profile → My role accounts can switch into every
// role's view of the app.
//
//   node --env-file=.env scripts/create-demo-account.cjs
//
// Refuses to run in production or against PostgreSQL. No password is hard-coded in this repository: every run
// generates a new random one, shared by the four demo accounts, and writes it with the sign-in details to
// storage/demo-account.txt (private storage, gitignored). It is never printed. Re-running replaces the password
// and signs the demo accounts out everywhere. Nothing else in the organization is touched.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { prisma } = require('../lib/prisma');
const { hashPassword } = require('../lib/password');
const { logAudit } = require('../lib/audit');

const ADMIN = { username: 'demo', fullName: 'Demo Admin', role: 'ADMIN' };
const TEST_ACCOUNTS = [
  { username: 'demo-agent', fullName: 'Demo Travel Agent', role: 'TRAVEL_AGENT' },
  { username: 'demo-supervisor', fullName: 'Demo Supervisor', role: 'SUPERVISOR' },
  { username: 'demo-expert', fullName: 'Demo Flight Expert', role: 'FLIGHT_EXPERT' },
];
const STORAGE_ROOT = path.resolve(process.env.STORAGE_ROOT || path.join(__dirname, '..', 'storage'));
const OUTPUT = path.join(STORAGE_ROOT, 'demo-account.txt');

async function upsertAccount(organizationId, account, passwordHash, testOwnerAdminId = null) {
  const existing = await prisma.profile.findUnique({ where: { username: account.username } });
  if (existing && existing.organizationId !== organizationId) throw new Error(`${account.username} belongs to another organization`);
  if (existing && existing.role !== account.role) throw new Error(`${account.username} exists with role ${existing.role}, expected ${account.role}`);
  const data = { passwordHash, status: 'ACTIVE', archivedAt: null, testOwnerAdminId };
  if (existing) return prisma.profile.update({ where: { id: existing.id }, data });
  return prisma.profile.create({
    data: {
      ...data,
      organizationId,
      username: account.username,
      fullName: account.fullName,
      email: `${account.username}@example.com`,
      role: account.role,
      employmentStartDate: new Date(),
    },
  });
}

async function main() {
  if (process.env.NODE_ENV === 'production' || /^postgres(?:ql)?:/.test(process.env.DATABASE_URL || '')) {
    throw new Error('Demo accounts are for local development only (NODE_ENV=production or a PostgreSQL DATABASE_URL was found).');
  }
  const organization = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!organization) throw new Error('No organization found. Run the seed first: node --env-file=.env prisma/seed.js');

  const password = crypto.randomBytes(12).toString('base64url');
  const passwordHash = await hashPassword(password);
  const admin = await upsertAccount(organization.id, ADMIN, passwordHash);
  const testAccounts = [];
  for (const account of TEST_ACCOUNTS) testAccounts.push(await upsertAccount(organization.id, account, passwordHash, admin.id));
  await prisma.session.deleteMany({ where: { profileId: { in: [admin.id, ...testAccounts.map((a) => a.id)] } } });
  await logAudit({ organizationId: organization.id, actorId: admin.id, action: 'profile.demo_accounts_refreshed', targetTable: 'Profile', targetId: admin.id, metadata: { source: 'scripts/create-demo-account.cjs' } });

  const origin = process.env.APP_ORIGIN || 'http://localhost:3000';
  fs.mkdirSync(STORAGE_ROOT, { recursive: true });
  fs.writeFileSync(OUTPUT, [
    'SpaceZero demo accounts (local development only)',
    '',
    `Sign in:       ${origin}/login`,
    'Company code:  above9',
    `Password:      ${password}   (the same for every demo account below)`,
    '',
    `Admin:         ${ADMIN.username}`,
    ...TEST_ACCOUNTS.map((a) => `${a.fullName.replace('Demo ', '')}:`.padEnd(15) + a.username),
    '',
    'Signed in as "demo", open My Profile → My role accounts and use Switch to … to view the app as each role.',
    'Running scripts/create-demo-account.cjs again replaces this password.',
    '',
  ].join('\n'), { mode: 0o600 });

  console.log(`Demo accounts ready in ${organization.name}: ${[ADMIN, ...TEST_ACCOUNTS].map((a) => a.username).join(', ')}.`);
  console.log(`Password and sign-in details: ${OUTPUT}`);
}

main()
  .catch((err) => {
    console.error(`Demo accounts were not created: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
