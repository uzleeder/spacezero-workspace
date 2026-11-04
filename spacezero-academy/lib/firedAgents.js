'use strict';

// Fired agents. A company account - the work email, the Workspace username and the saved system logins in the vault -
// outlives the people who use it: when "Max" is let go, the next agent takes over Max's account. What must NOT pass on
// is the person: their passport, phones, address, training, scores and history stay with them.
//
// So the account is not the profile. Each person keeps their own profile for ever; firing one marks them as let go
// (Admin-only, with a reason) and remembers which company account they held (`accountKey`, the account's email).
// Giving the account to a new agent creates a FRESH profile with the same email and username and moves only the saved
// system logins to it. Personal data cannot follow even by mistake: it is encrypted against the old profile's own id.
const { prisma } = require('./prisma');
const { logAudit } = require('./audit');
const { decryptText, decryptJson, encryptJson } = require('./credentialCrypto');
const { decryptPassportNumber } = require('./passport');

const keyOf = (email) => String(email || '').trim().toLowerCase();

/** The person's real name as it is written in their passport, else the name they were given in Workspace. */
function passportName(p) {
  const name = [p.passportFirstName, p.passportMiddleName, p.passportLastName].map((s) => String(s || '').trim()).filter(Boolean).join(' ');
  return name || p.fullName;
}

/**
 * Lets an employee go. They can no longer sign in, they leave their team and their supervisor, and they appear under
 * Fired agents with the reason. The company account and its saved logins stay with the record until the account is
 * given to a new agent. Returns { ok } or { error }.
 */
async function fireEmployee(admin, employeeId, reason) {
  const why = String(reason || '').trim().slice(0, 2000);
  if (why.length < 3) return { error: 'Write the reason for letting this agent go.' };
  const employee = await prisma.profile.findFirst({ where: { id: employeeId, organizationId: admin.organizationId } });
  if (!employee) return { error: 'Not found', status: 404 };
  if (employee.role === 'ADMIN') return { error: 'An Admin account cannot be fired here.' };
  if (employee.firedAt) return { error: 'This agent has already been fired.' };
  const now = new Date();
  await prisma.$transaction([
    prisma.profile.update({ where: { id: employee.id }, data: { status: 'ARCHIVED', archivedAt: now, firedAt: now, firedReason: why, firedById: admin.id, accountKey: employee.accountKey || keyOf(employee.email) } }),
    prisma.session.deleteMany({ where: { profileId: employee.id } }),                       // signed out everywhere, at once
    prisma.invitation.updateMany({ where: { profileId: employee.id, status: 'PENDING' }, data: { status: 'REVOKED' } }),
    prisma.supervisorAssignment.updateMany({ where: { OR: [{ agentId: employee.id }, { supervisorId: employee.id }], unassignedAt: null }, data: { unassignedAt: now } }),
    prisma.teamMembership.deleteMany({ where: { profileId: employee.id } }),
  ]);
  await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'employee.fired', targetTable: 'Profile', targetId: employee.id, metadata: { reason: why, account: keyOf(employee.email) } });
  return { ok: true };
}

/** The current holder of a company account: the profile that is not fired and uses that email now. */
const holderOf = (organizationId, accountKey) => prisma.profile.findFirst({ where: { organizationId, email: accountKey, firedAt: null }, select: { id: true, fullName: true, status: true, role: true, employmentStartDate: true } });

/** Fired agents, ONE row per company account: who held it last, how many held it, who holds it now. */
async function accountsList(admin) {
  const fired = await prisma.profile.findMany({ where: { organizationId: admin.organizationId, firedAt: { not: null } }, orderBy: { firedAt: 'desc' } });
  const groups = new Map();
  for (const p of fired) {
    const key = p.accountKey || keyOf(p.email);
    if (!groups.has(key)) groups.set(key, { key, people: [] });
    groups.get(key).people.push(p);
  }
  const rows = [];
  for (const g of groups.values()) {
    const last = g.people[0];
    rows.push({ key: g.key, count: g.people.length, last, lastName: passportName(last), role: last.role, holder: await holderOf(admin.organizationId, g.key) });
  }
  return rows;
}

/** Everyone who ever held one company account and was let go, newest first, with their own (Admin-only) details. */
async function accountDetail(admin, accountKey) {
  const key = keyOf(accountKey);
  const people = await prisma.profile.findMany({ where: { organizationId: admin.organizationId, firedAt: { not: null }, accountKey: key }, orderBy: { firedAt: 'desc' } });
  if (!people.length) return null;
  const firers = new Map((await prisma.profile.findMany({ where: { id: { in: [...new Set(people.map((p) => p.firedById).filter(Boolean))] } }, select: { id: true, fullName: true } })).map((p) => [p.id, p.fullName]));
  const readAddress = (p) => { try { return p.currentAddressEnc ? decryptText(p.currentAddressEnc, `address:${p.id}`) : ''; } catch { return ''; } };
  const readPassport = (p) => { try { return p.passportNumberEnc ? decryptPassportNumber(p.id, p.passportNumberEnc) : ''; } catch { return ''; } };
  const holder = await holderOf(admin.organizationId, key);
  const keeper = holder ? null : people.find((p) => p.email === key) || null;   // the record that still holds the email and saved logins
  const savedLogins = keeper ? await prisma.credential.count({ where: { ownerId: keeper.id } }) : 0;
  return {
    key, holder, keeper, savedLogins, username: keeper ? keeper.username : null,
    people: people.map((p) => ({
      id: p.id, passportName: passportName(p), fullName: p.fullName, role: p.role,
      from: p.employmentStartDate, firedAt: p.firedAt, reason: p.firedReason, firedBy: firers.get(p.firedById) || 'an Admin',
      phones: [p.phonePrimary, p.phoneSecondary, p.localPhone, p.phoneUzbekistan, p.whatsappNumber].filter(Boolean),
      telegram: p.telegramContact || '', address: readAddress(p), passportNumber: readPassport(p), passportExpiresAt: p.passportExpiresAt, dateOfBirth: p.dateOfBirth,
    })),
  };
}

/**
 * Gives a vacant company account to a new agent: a FRESH profile with the account's email and username (so the
 * invitation goes to the company mailbox), and the saved system logins move to it. Nothing personal moves - the new
 * agent starts with an empty profile and no training history. The fired agent's record keeps everything else, under a
 * freed-up email and username. Returns { profile, invite } or { error }.
 */
async function handOverAccount(admin, accountKey, { fullName, employmentStartDate, teamId = null, supervisorId = null }) {
  const key = keyOf(accountKey);
  const name = String(fullName || '').trim().slice(0, 120);
  if (name.length < 2) return { error: "Write the new agent's full name." };
  const start = new Date(employmentStartDate);
  if (!employmentStartDate || Number.isNaN(start.getTime())) return { error: 'Choose the start date.' };
  if (await holderOf(admin.organizationId, key)) return { error: 'This account already has an agent.' };
  const keeper = await prisma.profile.findFirst({ where: { organizationId: admin.organizationId, firedAt: { not: null }, email: key } });
  if (!keeper) return { error: 'This account cannot be given to a new agent right now.' };
  if (teamId && !await prisma.team.findFirst({ where: { id: teamId, organizationId: admin.organizationId, archivedAt: null } })) return { error: "Choose one of this company's teams." };
  if (supervisorId && !await prisma.profile.findFirst({ where: { id: supervisorId, organizationId: admin.organizationId, role: 'SUPERVISOR', status: { not: 'ARCHIVED' } } })) return { error: 'Choose an active supervisor.' };
  if (keeper.role === 'TRAVEL_AGENT' && !supervisorId) return { error: 'Choose a supervisor: every Travel Agent needs one.' };

  const { generateToken } = require('./tokens');
  const token = generateToken();
  const tail = keeper.id.slice(-8);
  const created = await prisma.$transaction(async (tx) => {
    // free the email and username on the fired record (it stays findable under its account key)
    await tx.profile.update({ where: { id: keeper.id }, data: { email: `fired-${tail}.${key}`, username: `${keeper.username}.fired-${tail}`.slice(0, 120) } });
    const profile = await tx.profile.create({ data: { organizationId: admin.organizationId, fullName: name, username: keeper.username, email: key, accountKey: key, role: keeper.role, status: 'INVITED', employmentStartDate: start, createdById: admin.id } });
    // The passwords go with the account. Each saved login is sealed to its owner (cred:<org>:<owner>), so it is opened
    // with the old owner and sealed again to the new agent - a plain owner change would leave it unreadable.
    const logins = await tx.credential.findMany({ where: { ownerId: keeper.id } });
    for (const c of logins) {
      const payload = decryptJson(c.payloadEnc, `cred:${c.organizationId}:${keeper.id}`);
      await tx.credential.update({ where: { id: c.id }, data: { ownerId: profile.id, payloadEnc: encryptJson(payload, `cred:${c.organizationId}:${profile.id}`), updatedById: admin.id } });
    }
    const moved = { count: logins.length };
    // Setup: the systems whose logins came with the account are already done for the new agent (they have the
    // passwords). Everything personal - passport, phone, address, the other confirmations - stays to do: they fill it in.
    const systems = await tx.setupRequirement.findMany({ where: { organizationId: admin.organizationId, credentialSystem: true }, select: { id: true, key: true, label: true } });
    const byName = new Map(systems.map((r) => [r.label.trim().toLowerCase(), r]));
    const byKey = new Map(systems.map((r) => [r.key, r]));
    const inherited = new Set(logins.map((c) => (byKey.get(c.systemKey) || byName.get(String(c.system || '').trim().toLowerCase()) || {}).id).filter(Boolean));
    const now = new Date();
    for (const requirementId of inherited) {
      await tx.employeeSetupItem.create({ data: { profileId: profile.id, requirementId, status: 'COMPLETED', employeeConfirmedAt: now, verifiedById: admin.id, verifiedAt: now, updatedById: admin.id, note: 'Came with the company account: the saved login was handed over from the previous agent.' } });
    }
    if (teamId) await tx.teamMembership.create({ data: { teamId, profileId: profile.id } });
    if (supervisorId) await tx.supervisorAssignment.create({ data: { supervisorId, agentId: profile.id, teamId: teamId || undefined, assignedById: admin.id } });
    await tx.invitation.create({ data: { profileId: profile.id, tokenHash: token.hash, invitedById: admin.id, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } });
    return { profile, moved: moved.count };
  });
  await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'employee.account_handed_over', targetTable: 'Profile', targetId: created.profile.id, metadata: { account: key, from: keeper.id, savedLogins: created.moved } });
  return { profile: created.profile, invite: token.raw, savedLogins: created.moved };
}

module.exports = { fireEmployee, accountsList, accountDetail, handOverAccount, passportName, keyOf };
