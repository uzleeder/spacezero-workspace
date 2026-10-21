'use strict';
// Phase 1 correction: navigation, setup checklist, credential vault, leave, training permissions,
// and the authorization rules behind them. Everything here goes through the real Express app.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { hashPassword } = require('../lib/password');
const { navForRole } = require('../lib/nav');
const { computeSetup, DEFAULT_REQUIREMENTS, ensureDefaultRequirements } = require('../lib/employeeSetup');
const { credentialAccess } = require('../lib/employeeAccess');
const { courseState, callState } = require('../lib/aiPracticeState');
const { setSetting } = require('../lib/orgSettings');
const { encryptText, decryptText } = require('../lib/credentialCrypto');
const app = require('../server');

const PASSWORD = 'Correct-Horse-9!';
const SECRET = 'S3cr3t-Pa55word-XYZ';
const ADDRESS = '742 Evergreen Terrace, Springfield';
let org, otherOrg, cookies = {};
let admin, admin2, supA, supB, agentA, agentB, expertA, outsider, teamA, teamB;

const as = (p) => cookies[p.id];
const get = (p, url) => request(app).get(url).set('Cookie', as(p));
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', as(p)).type('form').send(body);
const denied = (res) => [403, 404].includes(res.status);
const isoIn = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

before(async () => {
  org = await prisma.organization.create({ data: { name: 'P1C tests' } });
  otherOrg = await prisma.organization.create({ data: { name: 'P1C other org' } });
  const passwordHash = await hashPassword(PASSWORD);
  async function user(role, name, organizationId = org.id) {
    const p = await prisma.profile.create({ data: { organizationId, fullName: `P1C ${name}`, username: `p1c_${org.id}_${name}`, email: `p1c_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', passwordHash, employmentStartDate: new Date() } });
    const token = generateToken();
    await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
    cookies[p.id] = `sz_session=${token.raw}`;
    return p;
  }
  admin = await user('ADMIN', 'admin'); admin2 = await user('ADMIN', 'admin2');
  supA = await user('SUPERVISOR', 'supA'); supB = await user('SUPERVISOR', 'supB');
  for (const supervisor of [supA, supB]) await post(admin, '/admin/supervisor-permissions/' + supervisor.id, { capabilities: ['setup.view', 'setup.manage', 'setup.verify', 'training.assign'] });
  agentA = await user('TRAVEL_AGENT', 'agentA'); agentB = await user('TRAVEL_AGENT', 'agentB'); expertA = await user('FLIGHT_EXPERT', 'expertA');
  outsider = await user('ADMIN', 'outsider', otherOrg.id);
  teamA = await prisma.team.create({ data: { organizationId: org.id, name: 'P1C Team A' } });
  teamB = await prisma.team.create({ data: { organizationId: org.id, name: 'P1C Team B' } });
  for (const [team, members] of [[teamA, [agentA, expertA]], [teamB, [agentB]]]) for (const m of members) await prisma.teamMembership.create({ data: { teamId: team.id, profileId: m.id } });
  for (const [sup, team, members] of [[supA, teamA, [agentA, expertA]], [supB, teamB, [agentB]]]) for (const m of members) await prisma.supervisorAssignment.create({ data: { supervisorId: sup.id, agentId: m.id, teamId: team.id, assignedById: admin.id } });
  await ensureDefaultRequirements(org.id);
});
after(async () => { await prisma.$disconnect(); });

// ---------------------------------------------------------------- navigation
test('sidebar shows only the simplified sections and never Call Intelligence or Calls & Library', async () => {
  const labels = (role) => navForRole(role).flatMap((s) => s.items.map((i) => i.label));
  assert.deepEqual(labels('ADMIN'), ['Dashboard', 'My Training', 'AI Practice', 'Library', 'Employees & Teams', 'Training', 'Company Standards & Workflow', 'SpaceZero AI', 'Settings']);
  assert.deepEqual(labels('SUPERVISOR'), ['Dashboard', 'My Training', 'Library', 'Employees & Teams', 'Training', 'Company Standards & Workflow', 'SpaceZero AI']); // AI Practice is Admin-only
  assert.deepEqual(labels('TRAVEL_AGENT'), ['Dashboard', 'My Training', 'Library', 'Company Standards & Workflow', 'SpaceZero AI']);
  for (const role of ['ADMIN', 'SUPERVISOR', 'TRAVEL_AGENT', 'FLIGHT_EXPERT']) {
    assert.ok(!labels(role).some((l) => /Call Intelligence|Calls & Library/i.test(l)));
  }
  const page = await get(admin, '/dashboard');
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /Call Intelligence|Calls &amp; Library/);
});

test('old Call Intelligence links still work by redirecting into AI Practice', async () => {
  const res = await get(admin, '/call-intelligence');
  assert.equal(res.status, 302); assert.equal(res.headers.location, '/ai-practice');
});

test('the top-right user menu is one compact "Profile & Settings" entry, which itself organizes profile, setup, leave and account security', async () => {
  const page = await get(agentA, '/dashboard');
  assert.match(page.text, /Profile &amp; Settings/);
  assert.match(page.text, /Log out/);
  // the old duplicated shortcuts are gone from the dropdown itself (they live inside Profile & Settings now)
  assert.doesNotMatch(page.text, /role="menuitem">My Profile</);
  assert.doesNotMatch(page.text, /role="menuitem">My Setup</);
  assert.doesNotMatch(page.text, /role="menuitem">My Vacation/);
  assert.doesNotMatch(page.text, /role="menuitem">Account \/ Security</);
  assert.equal((await get(agentA, '/account')).headers.location, '/profile?section=security#account-security');
  const profilePage = await get(agentA, '/profile');
  for (const label of ['Profile', 'Setup', 'Vacation &amp; Leave', 'Account &amp; Security']) assert.match(profilePage.text, new RegExp(label));
});

// ---------------------------------------------------------------- setup calculation
test('setup percentage is computed from stored facts: derived items, verification rules, company control, role scope, exemptions', () => {
  const base = { archivedAt: null, audience: 'ALL_EMPLOYEES', rolesJson: null, required: true, verification: 'MANAGEMENT_VERIFICATION', companyControlled: false };
  const reqs = [
    { ...base, id: 'r1', key: 'pc', label: 'PC', kind: 'MANUAL' },
    { ...base, id: 'r2', key: 'whatsapp', label: 'WhatsApp', kind: 'MANUAL', companyControlled: true },
    { ...base, id: 'r3', key: 'local_phone', label: 'Phone', kind: 'LOCAL_PHONE' },
    { ...base, id: 'r4', key: 'sup_only', label: 'Supervisor only', kind: 'MANUAL', audience: 'ROLES', rolesJson: JSON.stringify(['SUPERVISOR']) },
    { ...base, id: 'r5', key: 'nice', label: 'Nice to have', kind: 'MANUAL', required: false },
  ];
  const agent = { role: 'TRAVEL_AGENT', status: 'ACTIVE', localPhone: '+998 90 123 45 67' };
  const verified = (id, extra = {}) => ({ requirementId: id, status: 'COMPLETED', verifiedById: 'someone', verifiedAt: new Date(), ...extra });
  const calc = (items, profile = agent) => computeSetup({ profile, requirements: reqs, items, vaultSystemKeys: [], hasAddress: false });
  let r = calc([verified('r1')]);
  assert.equal(r.required, 3); assert.equal(r.completed, 2); // pc + derived phone; supervisor-only and optional excluded
  assert.equal(r.percent, 67); assert.equal(r.fullySetUp, false); assert.equal(r.label, 'Setup Required');
  // Ticked with no management proof (forged row): not counted under MANAGEMENT_VERIFICATION.
  assert.equal(calc([{ requirementId: 'r1', status: 'COMPLETED' }]).completed, 1);
  // WhatsApp verified but the company has not confirmed control of the number: still not complete.
  assert.equal(calc([verified('r1'), verified('r2')]).percent, 67);
  r = calc([verified('r1'), verified('r2', { companyControlConfirmed: true })]);
  assert.equal(r.percent, 100); assert.equal(r.label, 'Fully Set Up');
  // A NOT_REQUIRED exemption removes an item from the denominator.
  r = calc([verified('r1'), { requirementId: 'r2', status: 'NOT_REQUIRED' }]);
  assert.equal(r.required, 2); assert.equal(r.percent, 100);
  // Items the employee confirmed themselves (awaiting verification) move the percentage, but are
  // never "completed" and never reach 100 until a supervisor/admin verifies them.
  r = calc([{ requirementId: 'r1', status: 'IN_PROGRESS', employeeConfirmedAt: new Date() }, { requirementId: 'r2', status: 'IN_PROGRESS', employeeConfirmedAt: new Date() }]);
  assert.equal(r.completed, 1); assert.equal(r.awaitingVerification, 2); assert.equal(r.percent, 99); assert.equal(r.fullySetUp, false);
  r = calc([{ requirementId: 'r1', status: 'IN_PROGRESS', employeeConfirmedAt: new Date() }]);
  assert.equal(r.percent, 67); assert.equal(r.completed, 1);
  // The role-specific item does count for a supervisor.
  r = calc([], { role: 'SUPERVISOR', status: 'ACTIVE', localPhone: '' });
  assert.ok(r.missingKeys.includes('sup_only')); assert.ok(r.missingKeys.includes('local_phone'));
  assert.equal(DEFAULT_REQUIREMENTS.length, 19); // 18 original + Passport Details
});

test('an employee sees their own setup progress with text, never colour alone; others cannot open it', async () => {
  const mine = await get(agentA, `/employees/${agentA.id}/setup`);
  assert.equal(mine.status, 200); assert.match(mine.text, /\d+% — (Setup Required|Setup Issue|Fully Set Up)/);
  assert.ok(denied(await get(agentB, `/employees/${agentA.id}/setup`)));
  assert.ok(denied(await get(supB, `/employees/${agentA.id}/setup`)));
  assert.ok(denied(await get(outsider, `/employees/${agentA.id}/setup`)));
  assert.equal((await get(agentA, '/my/setup')).headers.location, `/employees/${agentA.id}/setup`);
});

test('setup cannot be forged: no self-verification, no ticking derived items, company control needs confirmation', async () => {
  const pc = await prisma.setupRequirement.findFirst({ where: { organizationId: org.id, key: 'pc' } });
  const vault = await prisma.setupRequirement.findFirst({ where: { organizationId: org.id, key: 'credential_vault' } });
  const whatsapp = await prisma.setupRequirement.findFirst({ where: { organizationId: org.id, key: 'whatsapp' } });
  const stored = (requirementId) => prisma.employeeSetupItem.findFirst({ where: { profileId: agentA.id, requirementId } });

  assert.equal((await post(agentA, `/employees/${agentA.id}/setup/${pc.id}`, { status: 'COMPLETED' })).status, 403); // employee cannot verify themselves
  assert.equal(await stored(pc.id), null);
  assert.equal((await post(supA, `/employees/${supA.id}/setup/${pc.id}`, { status: 'COMPLETED' })).status, 403); // a supervisor still cannot verify their own setup
  assert.ok(denied(await post(supB, `/employees/${agentA.id}/setup/${pc.id}`, { status: 'COMPLETED' }))); // another team's supervisor
  assert.equal(await stored(pc.id), null);

  const forged = await post(supA, `/employees/${agentA.id}/setup/${vault.id}`, { status: 'COMPLETED' });
  assert.match(forged.text, /calculated automatically/); assert.equal(await stored(vault.id), null);

  const unconfirmed = await post(supA, `/employees/${agentA.id}/setup/${whatsapp.id}`, { status: 'COMPLETED' });
  assert.match(unconfirmed.text, /Confirm that the company owns/); assert.equal(await stored(whatsapp.id), null);

  assert.equal((await post(supA, `/employees/${agentA.id}/setup/${pc.id}`, { status: 'NOT_REQUIRED' })).status, 403); // only an admin may exempt
  const ok = await post(supA, `/employees/${agentA.id}/setup/${pc.id}`, { status: 'COMPLETED', note: 'PC checked' });
  assert.equal(ok.status, 302);
  const row = await stored(pc.id);
  assert.equal(row.status, 'COMPLETED'); assert.equal(row.verifiedById, supA.id); assert.ok(row.verifiedAt);
  assert.ok(await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'setup.item_verified', targetId: agentA.id } }));
});

test('ADMIN SELF-SETUP: an Admin may bulk-manage and individually verify their own setup, but a Supervisor still cannot', async () => {
  const pc = await prisma.setupRequirement.findFirst({ where: { organizationId: org.id, key: 'pc' } });
  const egf = await prisma.setupRequirement.findFirst({ where: { organizationId: org.id, key: 'egf' } });

  const page = await get(admin, `/employees/${admin.id}/setup`);
  assert.equal(page.status, 200);
  assert.match(page.text, /data-bulk-setup-form/, 'an admin viewing their own setup sees the compact manage checklist, not the self-confirm cards');

  const bulk = await post(admin, `/employees/${admin.id}/setup/bulk`, { checked: [pc.id] });
  assert.equal(bulk.status, 302);
  const pcRow = await prisma.employeeSetupItem.findFirst({ where: { profileId: admin.id, requirementId: pc.id } });
  assert.equal(pcRow.status, 'COMPLETED');
  assert.equal(pcRow.verifiedById, admin.id, 'the admin verified their own item');

  const individual = await post(admin, `/employees/${admin.id}/setup/${egf.id}`, { status: 'COMPLETED', note: 'self' });
  assert.equal(individual.status, 302);
  const egfRow = await prisma.employeeSetupItem.findFirst({ where: { profileId: admin.id, requirementId: egf.id } });
  assert.equal(egfRow.status, 'COMPLETED');

  // A Supervisor is a different story: still blocked from self-managing, exactly as before.
  const supPage = await get(supA, `/employees/${supA.id}/setup`);
  assert.doesNotMatch(supPage.text, /setup\/bulk" data-bulk-setup-form/, 'no manage checklist for a Supervisor on their own setup (they see the self checklist)');
  assert.equal((await post(supA, `/employees/${supA.id}/setup/bulk`, { checked: [pc.id] })).status, 403);
});

test('WhatsApp only counts once company ownership is confirmed', async () => {
  const whatsapp = await prisma.setupRequirement.findFirst({ where: { organizationId: org.id, key: 'whatsapp' } });
  const ok = await post(admin, `/employees/${agentA.id}/setup/${whatsapp.id}`, { status: 'COMPLETED', companyControlConfirmed: '1' });
  assert.equal(ok.status, 302);
  const row = await prisma.employeeSetupItem.findFirst({ where: { profileId: agentA.id, requirementId: whatsapp.id } });
  assert.equal(row.companyControlConfirmed, true);
});

// ---------------------------------------------------------------- address / phone
test('the address is encrypted at rest, shown only on the authorized profile view, and never audited or listed', async () => {
  const saved = await post(agentA, `/employees/${agentA.id}/contact`, { localPhone: '+998 90 555 12 34', currentAddress: ADDRESS });
  assert.equal(saved.status, 302);
  const row = await prisma.profile.findUnique({ where: { id: agentA.id } });
  assert.ok(row.currentAddressEnc && !row.currentAddressEnc.includes('Evergreen'));
  assert.equal(decryptText(row.currentAddressEnc, `address:${agentA.id}`), ADDRESS);

  assert.match((await get(agentA, `/employees/${agentA.id}/setup`)).text, /Evergreen/);
  assert.match((await get(supA, `/employees/${agentA.id}/setup`)).text, /Evergreen/);
  assert.match((await get(admin, `/employees/${agentA.id}/setup`)).text, /Evergreen/);
  for (const [who, url] of [[admin, '/admin/employees'], [supA, '/team'], [admin, '/dashboard'], [admin, '/admin/audit-logs'], [admin, '/notifications']]) {
    assert.doesNotMatch((await get(who, url)).text, /Evergreen/, `${url} must not show addresses`);
  }
  assert.ok(denied(await get(supB, `/employees/${agentA.id}/setup`)));
  assert.ok(denied(await get(agentB, `/employees/${agentA.id}/setup`)));
  const audits = JSON.stringify(await prisma.auditLog.findMany({ where: { organizationId: org.id } }));
  assert.ok(!audits.includes('Evergreen')); assert.ok(!audits.includes('555 12 34'));
  assert.ok(await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'employee.contact_updated', targetId: agentA.id } }));
  assert.equal((await post(agentB, `/employees/${agentA.id}/contact`, { currentAddress: 'hijack' })).status === 302, false);
  assert.equal((await post(agentA, `/employees/${agentA.id}/contact`, { localPhone: 'not a phone' })).status, 200); // invalid phone is rejected with a message
});

// ---------------------------------------------------------------- credential vault
test('credentials are encrypted at rest and never appear in lists, pages or audit rows', async () => {
  const created = await post(admin, `/employees/${agentA.id}/credentials`, { system: 'gmail', username: 'agent.a@example.invalid', password: SECRET });
  assert.equal(created.status, 302);
  const cred = await prisma.credential.findFirst({ where: { ownerId: agentA.id, systemKey: 'gmail' } });
  assert.ok(cred.payloadEnc.startsWith('v1.')); assert.ok(!cred.payloadEnc.includes(SECRET));
  const page = await get(admin, `/employees/${agentA.id}/credentials`);
  assert.equal(page.status, 200); assert.doesNotMatch(page.text, new RegExp(SECRET)); assert.match(page.text, /Gmail/);
  assert.match(page.headers['cache-control'], /no-store/);
  const setup = await get(admin, `/employees/${agentA.id}/setup`);
  assert.doesNotMatch(setup.text, new RegExp(SECRET));
  const audits = JSON.stringify(await prisma.auditLog.findMany({ where: { organizationId: org.id } }));
  assert.ok(!audits.includes(SECRET));
  // encryption is authenticated and bound to the owner: the same blob cannot be opened for another employee
  assert.throws(() => decryptText(encryptText('x', 'cred:a'), 'cred:b'));
});

test('reveal needs the viewer password, is audited without the secret, and wrong passwords are logged', async () => {
  const cred = await prisma.credential.findFirst({ where: { ownerId: agentA.id, systemKey: 'gmail' } });
  const wrong = await post(admin, `/credentials/${cred.id}/reveal`, { password: 'nope' });
  assert.equal(wrong.status, 401);
  assert.ok(await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'credential.reveal_failed', targetId: cred.id } }));
  assert.equal((await post(admin, `/credentials/${cred.id}/reveal`, {})).status, 401); // no password at all
  const ok = await post(admin, `/credentials/${cred.id}/reveal`, { password: PASSWORD });
  assert.equal(ok.status, 200); assert.equal(ok.body.password, SECRET);
  assert.match(ok.headers['cache-control'], /no-store/);
  const viewed = await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'credential.viewed', targetId: cred.id } });
  assert.equal(viewed.actorId, admin.id);
  assert.ok(!JSON.stringify(viewed).includes(SECRET));
});

test('credential access matrix: owner and admin yes; the agent\'s own supervisor is denied by default; everyone else looks like a missing record', async () => {
  const cred = await prisma.credential.findFirst({ where: { ownerId: agentA.id, systemKey: 'gmail' } });
  const reveal = (who) => post(who, `/credentials/${cred.id}/reveal`, { password: PASSWORD });
  assert.equal((await reveal(agentA)).status, 200);  // owner (org policy allows it by default)
  // supA already holds setup.view/manage/verify (granted in before()) but NOT credentials.view_team —
  // "Manage Team Setup" must never imply Credential Vault access.
  assert.equal((await reveal(supA)).status, 404);
  for (const stranger of [supB, agentB, expertA, outsider]) assert.equal((await reveal(stranger)).status, 404);
  // direct-ID manipulation of update/delete by unauthorized users is indistinguishable from a bad ID
  const before = cred.payloadEnc;
  for (const who of [supA, supB, agentB, expertA, outsider]) {
    assert.equal((await post(who, `/credentials/${cred.id}/update`, { password: 'hacked' })).status, 404);
    assert.equal((await post(who, `/credentials/${cred.id}/delete`)).status, 404);
  }
  assert.equal((await post(supB, '/credentials/does-not-exist/update', { password: 'x' })).status, 404);
  assert.equal((await prisma.credential.findUnique({ where: { id: cred.id } })).payloadEnc, before);
  // the owner can write to (add / change / delete) their own vault; strangers still see a missing record
  assert.equal((await post(agentA, `/credentials/${cred.id}/update`, { password: 'mine' })).status, 302);
  assert.equal((await post(agentA, `/credentials/${cred.id}/reveal`, { password: PASSWORD })).body.password, 'mine');
  assert.equal((await post(admin, `/credentials/${cred.id}/update`, { password: SECRET })).status, 302); // restore the value later tests expect
  assert.ok(await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'credential.access_denied' } }));
  // vault pages: unauthorized viewers get nothing
  for (const who of [supA, supB, agentB, outsider]) assert.ok(denied(await get(who, `/employees/${agentA.id}/credentials`)));
});

test('credentials.view_team: an explicit Admin grant (never the setup capabilities) unlocks a Supervisor\'s own-team credential access, scoped to their own team only', async () => {
  const cred = await prisma.credential.findFirst({ where: { ownerId: agentA.id, systemKey: 'gmail' } });
  const reveal = (who) => post(who, `/credentials/${cred.id}/reveal`, { password: PASSWORD });
  assert.equal((await reveal(supA)).status, 404); // still denied — not yet granted
  const grant = await post(admin, '/admin/supervisor-permissions/' + supA.id, { capabilities: ['setup.view', 'setup.manage', 'setup.verify', 'training.assign', 'credentials.view_team'] });
  assert.equal(grant.status, 302);
  assert.equal((await reveal(supA)).status, 200); // now unlocked
  assert.equal((await reveal(supB)).status, 404); // supB's own grant is unaffected — this never widens WHO, only WHAT
  assert.ok(await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'supervisor.capability_granted', targetId: supA.id, metadataJson: { contains: 'credentials.view_team' } } }));
  // revoking it (back to just the setup capabilities) immediately blocks it again
  await post(admin, '/admin/supervisor-permissions/' + supA.id, { capabilities: ['setup.view', 'setup.manage', 'setup.verify', 'training.assign'] });
  assert.equal((await reveal(supA)).status, 404);
  // re-grant: later tests in this file exercise supA as an authorized vault viewer (impersonation
  // blocking, the owner-view policy toggle, the Credentials tab) — that authorization now comes
  // from this explicit capability rather than the old unconditional role check.
  await post(admin, '/admin/supervisor-permissions/' + supA.id, { capabilities: ['setup.view', 'setup.manage', 'setup.verify', 'training.assign', 'credentials.view_team'] });
  assert.equal((await reveal(supA)).status, 200);
});

test('a Flight Expert or Supervisor vault is visible only to the owner and admins; admin vaults need an explicit grant', async () => {
  await post(admin, `/employees/${expertA.id}/credentials`, { system: 'crm', password: 'expert-secret' });
  const expertCred = await prisma.credential.findFirst({ where: { ownerId: expertA.id } });
  assert.equal((await post(supA, `/credentials/${expertCred.id}/reveal`, { password: PASSWORD })).status, 404); // a supervisor does not get expert vaults
  assert.equal((await post(expertA, `/credentials/${expertCred.id}/reveal`, { password: PASSWORD })).status, 200);

  await post(admin, `/employees/${admin.id}/credentials`, { customSystem: 'Bank portal', password: 'admin-secret' });
  const adminCred = await prisma.credential.findFirst({ where: { ownerId: admin.id } });
  assert.equal((await post(admin2, `/credentials/${adminCred.id}/reveal`, { password: PASSWORD })).status, 404); // no implicit admin-to-admin access
  assert.ok(denied(await get(admin2, `/employees/${admin.id}/credentials`)));
  assert.equal((await post(supA, `/employees/${admin.id}/credentials/grants`, { granteeId: supA.id })).status, 403);
  await post(admin, `/employees/${admin.id}/credentials/grants`, { granteeId: admin2.id });
  assert.equal((await post(admin2, `/credentials/${adminCred.id}/reveal`, { password: PASSWORD })).status, 200);
  await post(admin, `/employees/${admin.id}/credentials/grants/${admin2.id}/delete`);
  assert.equal((await post(admin2, `/credentials/${adminCred.id}/reveal`, { password: PASSWORD })).status, 404);
});

test('impersonated sessions and the owner-view policy cannot be used to read secrets', async () => {
  assert.deepEqual(await credentialAccess(admin, agentA, { impersonating: true }), { view: false, manage: false });
  const cred = await prisma.credential.findFirst({ where: { ownerId: agentA.id, systemKey: 'gmail' } });
  await setSetting(org.id, 'credentials.ownerCanView', false, admin.id);
  assert.equal((await post(agentA, `/credentials/${cred.id}/reveal`, { password: PASSWORD })).status, 404);
  assert.equal((await post(supA, `/credentials/${cred.id}/reveal`, { password: PASSWORD })).status, 200);
  await setSetting(org.id, 'credentials.ownerCanView', true, admin.id);
});

test('credential vault completes the setup checklist item only when every required system has an entry', async () => {
  const before = await get(admin, `/employees/${agentA.id}/setup`);
  assert.match(before.text, /Passwords \/ Credential Vault/);
  const vault = await prisma.setupRequirement.findFirst({ where: { organizationId: org.id, key: 'credential_vault' } });
  const items = await prisma.employeeSetupItem.findMany({ where: { profileId: agentA.id } });
  const reqs = await prisma.setupRequirement.findMany({ where: { organizationId: org.id } });
  const systems = reqs.filter((r) => r.credentialSystem && r.required).map((r) => r.key);
  const partial = computeSetup({ profile: agentA, requirements: reqs, items, vaultSystemKeys: ['gmail'], hasAddress: true }).rows.find((r) => r.requirement.id === vault.id);
  assert.equal(partial.status, 'IN_PROGRESS');
  const full = computeSetup({ profile: agentA, requirements: reqs, items, vaultSystemKeys: systems, hasAddress: true }).rows.find((r) => r.requirement.id === vault.id);
  assert.equal(full.status, 'COMPLETED');
});

// ---------------------------------------------------------------- vacation / leave
test('employees request leave; nobody files it for someone else; scope follows the supervisor assignment', async () => {
  const body = { leaveType: 'VACATION', startDate: isoIn(20), endDate: isoIn(24), note: 'Family trip' };
  assert.equal((await post(agentB, `/employees/${agentA.id}/leave`, body)).status, 403);
  assert.equal((await post(agentA, `/employees/${agentA.id}/leave`, { ...body, endDate: isoIn(10) })).status, 200); // end before start is rejected
  assert.equal((await post(agentA, `/employees/${agentA.id}/leave`, { ...body, leaveType: 'NOPE' })).status, 200);
  assert.equal((await post(agentA, `/employees/${agentA.id}/leave`, body)).status, 302);
  const request_ = await prisma.leaveRequest.findFirst({ where: { profileId: agentA.id } });
  assert.equal(request_.days, 5); assert.equal(request_.status, 'PENDING'); assert.equal(request_.supervisorId, supA.id); assert.equal(request_.teamId, teamA.id);
  assert.equal((await post(agentA, `/employees/${agentA.id}/leave`, body)).status, 200); // overlapping duplicate refused

  assert.match((await get(supA, '/leave')).text, /P1C agentA/);
  assert.doesNotMatch((await get(supB, '/leave')).text, /P1C agentA/);
  assert.match((await get(admin, '/leave')).text, /P1C agentA/);
  assert.equal((await get(admin, '/leave?view=calendar')).status, 200);
  assert.ok(denied(await get(agentB, '/leave')));
  assert.ok(denied(await get(supB, `/leave/${request_.id}`)));
  assert.ok(denied(await get(agentB, `/employees/${agentA.id}/leave`)));
});

test('supervisors recommend by default; only an admin (or an enabled policy) decides; nobody reviews their own request', async () => {
  const req_ = await prisma.leaveRequest.findFirst({ where: { profileId: agentA.id } });
  assert.ok(denied(await post(supB, `/leave/${req_.id}/review`, { action: 'approve' })));
  assert.equal((await post(supA, `/leave/${req_.id}/review`, { action: 'approve' })).status, 403);
  assert.equal((await post(supA, `/leave/${req_.id}/review`, { action: 'recommend_approve', note: 'Fine by me' })).status, 302);
  assert.equal((await prisma.leaveRequest.findUnique({ where: { id: req_.id } })).recommendation, 'RECOMMEND_APPROVE');
  assert.ok(denied(await post(agentA, `/leave/${req_.id}/review`, { action: 'approve' })));
  await setSetting(org.id, 'leave.supervisorFinalApproval', true, admin.id);
  assert.equal((await post(supA, `/leave/${req_.id}/review`, { action: 'approve' })).status, 302);
  await setSetting(org.id, 'leave.supervisorFinalApproval', false, admin.id);
  const decided = await prisma.leaveRequest.findUnique({ where: { id: req_.id } });
  assert.equal(decided.status, 'APPROVED'); assert.equal(decided.reviewedById, supA.id);
  assert.equal((await post(admin, `/leave/${req_.id}/review`, { action: 'reject' })).status, 409); // already decided
  assert.ok(await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'leave.approved', targetId: req_.id } }));
});

test('team overlap is informational: it is shown but never blocks a request', async () => {
  await prisma.leaveRequest.create({ data: { organizationId: org.id, profileId: expertA.id, teamId: teamA.id, supervisorId: supA.id, leaveType: 'VACATION', startDate: new Date(`${isoIn(40)}T00:00:00Z`), endDate: new Date(`${isoIn(44)}T00:00:00Z`), days: 5, status: 'APPROVED' } });
  const ok = await post(agentA, `/employees/${agentA.id}/leave`, { leaveType: 'VACATION', startDate: isoIn(41), endDate: isoIn(42) });
  assert.equal(ok.status, 302);
  const created = await prisma.leaveRequest.findFirst({ where: { profileId: agentA.id, days: 2 } });
  assert.match((await get(supA, `/leave/${created.id}`)).text, /P1C expertA/);
  assert.equal((await post(agentA, `/leave/${created.id}/cancel`)).status, 302);
  assert.ok(denied(await post(agentB, `/leave/${created.id}/cancel`)));
});

// ---------------------------------------------------------------- training permissions
test('drafts are never assignable; assigning follows the per-training policy and stays inside the supervisor scope', async () => {
  const course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'P1C course', createdById: admin.id, status: 'DRAFT', trainingCategory: 'PRODUCT' } });
  const assign = (who, ids) => post(who, '/assignments', { courseId: course.id, scope: 'INDIVIDUAL', targetProfileIds: ids });
  const count = () => prisma.trainingAssignment.count({ where: { courseId: course.id } });

  assert.ok(denied(await assign(admin, [agentA.id])) || (await count()) === 0); assert.equal(await count(), 0); // AI Practice drafts cannot be assigned even by an admin
  await post(admin, `/admin/training/${course.id}/send-to-training`);
  assert.equal((await prisma.trainingCourse.findUnique({ where: { id: course.id } })).status, 'PUBLISHED');
  assert.ok(await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'training.sent_to_training', targetId: course.id } }));

  // Admin only (default): a supervisor can see it but not assign it.
  assert.equal((await prisma.trainingCourse.findUnique({ where: { id: course.id } })).assignPolicy, 'ADMIN_ONLY');
  await assign(supA, [agentA.id]); assert.equal(await count(), 0);
  assert.match((await get(supA, '/admin/training')).text, /View only/);

  // Only an admin can change who may assign.
  assert.ok(denied(await post(supA, `/admin/training/${course.id}/assign-permissions`, { assignPolicy: 'ALL_SUPERVISORS' })));
  assert.equal((await prisma.trainingCourse.findUnique({ where: { id: course.id } })).assignPolicy, 'ADMIN_ONLY');

  // Selected supervisors: only supB is granted.
  await post(admin, `/admin/training/${course.id}/assign-permissions`, { assignPolicy: 'SELECTED_SUPERVISORS', supervisorIds: [supB.id] });
  await assign(supA, [agentA.id]); assert.equal(await count(), 0);
  await assign(supB, [agentA.id]); assert.equal(await count(), 0); // granted, but agentA is outside supB's scope
  await assign(supB, [agentB.id]); assert.equal(await count(), 1);

  // All supervisors: supA can assign, still only to their own people.
  await post(admin, `/admin/training/${course.id}/assign-permissions`, { assignPolicy: 'ALL_SUPERVISORS' });
  await assign(supA, [agentB.id]); assert.equal(await count(), 1);
  await assign(supA, [agentA.id]); assert.equal(await count(), 2);
  assert.ok(await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'training.permission_granted', targetId: course.id } }));
  assert.ok(await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'training.assign_policy_changed', targetId: course.id } }));

  // Employees cannot assign anything.
  assert.ok(denied(await assign(agentA, [agentA.id])));
  // The catalog opens the Assign form with the course preselected.
  assert.match((await get(supA, `/assignments?courseId=${course.id}`)).text, new RegExp(`value="${course.id}" selected`));
});

// ---------------------------------------------------------------- AI Practice / Library separation
test('AI Practice status is derived from real records and Training only receives sent material', () => {
  const draft = { id: 'c1', status: 'DRAFT', publishedVersion: 0, draftVersion: 1 };
  const key = (course, ctx) => courseState({ ...draft, ...course }, ctx).key;
  assert.equal(key({ analysis: null }), 'SAVED');
  assert.equal(key({ analysis: { status: 'MAPPING', updatedAt: new Date() } }), 'ANALYZING');
  assert.equal(key({ analysis: { status: 'FAILED' } }), 'FAILED');
  assert.equal(key({ analysis: { status: 'READY_FOR_REVIEW' } }), 'ANALYSIS_READY');
  assert.equal(key({ analysis: { status: 'APPROVED' } }, { components: [] }), 'ANALYSIS_READY');
  assert.equal(key({ analysis: { status: 'APPROVED' } }, { components: [{ status: 'AI_GENERATED' }] }), 'READY_FOR_REVIEW');
  assert.equal(key({ analysis: { status: 'APPROVED' } }, { components: [{ status: 'AI_GENERATED' }], build: { status: 'FAILED' } }), 'PRACTICE_DRAFT');
  assert.equal(key({ analysis: { status: 'APPROVED' } }, { components: [{ status: 'AI_GENERATED' }], build: { status: 'RUNNING' } }), 'BUILDING');
  assert.equal(key({ analysis: { status: 'APPROVED' } }, { components: [{ status: 'APPROVED' }] }), 'APPROVED');
  assert.equal(key({ status: 'PUBLISHED', publishedVersion: 1, analysis: { status: 'APPROVED' } }), 'SENT');
  assert.equal(callState({ status: 'UPLOADED', analysisRequestedAt: null, recordings: [] }).key, 'SAVED');
  assert.equal(callState({ status: 'TRANSCRIBING', analysisRequestedAt: new Date(), updatedAt: new Date(), recordings: [] }).key, 'ANALYZING');
  assert.equal(callState({ status: 'READY_FOR_REVIEW', recordings: [] }).key, 'ANALYSIS_READY');
  assert.equal(callState({ status: 'FAILED', recordings: [] }).key, 'FAILED');
});

test('raw customer calls never become Library items automatically or by hand', async () => {
  const before = await prisma.libraryItem.count({ where: { organizationId: org.id } });
  await prisma.callBatch.create({ data: { organizationId: org.id, uploadedById: admin.id, mode: 'BEST_PRACTICE', status: 'UPLOADED' } });
  assert.equal(await prisma.libraryItem.count({ where: { organizationId: org.id } }), before);
  const attempt = await request(app).post('/admin/library').set('Cookie', as(admin)).field('title', 'Raw call').field('itemType', 'CALL');
  assert.notEqual(attempt.status, 302);
  assert.equal(await prisma.libraryItem.count({ where: { organizationId: org.id } }), before);
  assert.doesNotMatch((await get(agentA, '/library')).text, /Raw call/);
  assert.equal((await get(admin, '/ai-practice')).status, 200);
  assert.ok(denied(await get(agentA, '/ai-practice')));
  for (const url of ['/ai-practice', '/ai-practice?section=review', '/ai-practice/new', '/ai-practice/calls', '/admin/training/new']) assert.ok(denied(await get(supA, url)), `supervisor must not open ${url}`);
  assert.ok(denied(await post(supA, '/ai-practice/calls', { mode: 'BEST_PRACTICE' })));
  const supDash = await get(supA, '/dashboard');
  assert.doesNotMatch(supDash.text, /AI Practice/); assert.doesNotMatch((await get(supA, '/admin/training')).text, /Open AI Practice/);
  assert.match((await get(admin, '/admin/training')).text, /Open AI Practice/);
});

// ---------------------------------------------------------------- employees & teams, dashboards, settings
test('the employee list shows setup state and filters by setup, missing item, team and supervisor inside the caller scope', async () => {
  const all = await get(admin, '/admin/employees');
  assert.equal(all.status, 200); assert.match(all.text, /Setup Required|Fully Set Up/);
  assert.match((await get(admin, '/admin/employees?setup=required')).text, /P1C agentB/);
  assert.match((await get(admin, `/admin/employees?teamId=${teamB.id}`)).text, /P1C agentB/);
  // Boundary-anchored: the topbar notification dropdown (Part 1) legitimately shows the viewer's
  // own recent notification text (e.g. a leave request naming another employee) on every page now,
  // so a bare-name check is no longer specific to the employee TABLE row it means to assert on.
  assert.doesNotMatch((await get(admin, `/admin/employees?teamId=${teamB.id}`)).text, />P1C agentA</);
  assert.doesNotMatch((await get(admin, `/admin/employees?supervisorId=${supB.id}`)).text, />P1C expertA</);
  assert.doesNotMatch((await get(admin, '/admin/employees?setup=fully')).text, />P1C agentB</);
  assert.match((await get(admin, '/admin/employees?missing=pc')).text, /P1C agentB/);
  const mine = await get(supA, '/team');
  assert.match(mine.text, /P1C agentA/); assert.doesNotMatch(mine.text, />P1C agentB</);
  assert.doesNotMatch((await get(supA, '/team?setup=required&missing=pc')).text, />P1C agentB</);
  assert.ok(denied(await get(agentA, '/admin/employees')));
  assert.ok(denied(await get(supA, '/admin/employees')));
});

test('the employee record tabs render for authorized viewers and hide Credentials from the unauthorized', async () => {
  const ownPage = await get(agentA, '/profile');
  assert.match(ownPage.text, /Vacation &amp; Leave/);
  const supPage = await get(supA, `/team/${agentA.id}`);
  assert.equal(supPage.status, 200); assert.match(supPage.text, /Credentials/);
  assert.ok(denied(await get(supB, `/team/${agentA.id}`)));
  assert.equal((await get(admin, `/admin/employees/${agentA.id}`)).status, 200);
  for (const tab of ['training', 'skills', 'activity']) {
    assert.equal((await get(supA, `/employees/${agentA.id}/${tab}`)).status, 200);
    assert.ok(denied(await get(supB, `/employees/${agentA.id}/${tab}`)));
  }
});

test('dashboards show role-appropriate operational cards that link to management views', async () => {
  const adminPage = await get(admin, '/dashboard');
  // "Needs your attention" lists only what needs doing, each with a link to where it is done
  assert.match(adminPage.text, /Needs your attention/); assert.match(adminPage.text, /Employees needing setup/);
  assert.match(adminPage.text, /href="\/admin\/employees\?readiness=SETUP_REQUIRED"/);
  const supPage = await get(supA, '/dashboard');
  assert.match(supPage.text, /Needs your attention/); assert.match(supPage.text, /href="\/team\?readiness=SETUP_REQUIRED"/); assert.doesNotMatch(supPage.text, /\/admin\/employees\?/);
  const agentPage = await get(agentA, '/dashboard');
  assert.match(agentPage.text, /My setup/); assert.doesNotMatch(agentPage.text, /Pending vacation requests/);
});

test('setup requirements are admin-editable, role-specific, reorderable and archivable without losing history', async () => {
  assert.ok(denied(await get(supA, '/admin/setup-requirements')));
  assert.ok(denied(await post(supA, '/admin/setup-requirements', { label: 'Sneaky' })));
  assert.ok(denied(await post(agentA, '/admin/policies', { 'leave.supervisorFinalApproval': '1' })));
  assert.equal((await get(admin, '/admin/setup-requirements')).status, 200);

  const created = await post(admin, '/admin/setup-requirements', { label: 'Headset', audience: 'ROLES', roles: ['TRAVEL_AGENT'], required: 'required', verification: 'MANAGEMENT_VERIFICATION' });
  assert.equal(created.status, 302);
  const req_ = await prisma.setupRequirement.findFirst({ where: { organizationId: org.id, label: 'Headset' } });
  assert.deepEqual(JSON.parse(req_.rolesJson), ['TRAVEL_AGENT']);
  assert.ok(await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'setup.requirement_created', targetId: req_.id } }));
  assert.match((await get(admin, `/employees/${agentB.id}/setup`)).text, /Headset/);
  assert.doesNotMatch((await get(admin, `/employees/${supB.id}/setup`)).text, /Headset/); // role-specific

  await post(admin, `/admin/setup-requirements/${req_.id}`, { label: 'Headset (USB)', audience: 'ROLES', roles: ['TRAVEL_AGENT'], required: 'optional' });
  const optional = await prisma.setupRequirement.findUnique({ where: { id: req_.id } });
  assert.equal(optional.label, 'Headset (USB)'); assert.equal(optional.required, false);

  const first = await prisma.setupRequirement.findFirst({ where: { organizationId: org.id, archivedAt: null }, orderBy: { displayOrder: 'asc' } });
  const second = await prisma.setupRequirement.findFirst({ where: { organizationId: org.id, archivedAt: null }, orderBy: { displayOrder: 'asc' }, skip: 1 });
  await post(admin, `/admin/setup-requirements/${first.id}/move`, { direction: 'down' });
  assert.ok((await prisma.setupRequirement.findUnique({ where: { id: first.id } })).displayOrder > (await prisma.setupRequirement.findUnique({ where: { id: second.id } })).displayOrder);

  await post(admin, `/admin/setup-requirements/${req_.id}/archive`);
  assert.ok((await prisma.setupRequirement.findUnique({ where: { id: req_.id } })).archivedAt);
  assert.doesNotMatch((await get(admin, `/employees/${agentB.id}/setup`)).text, /Headset/);
  await post(admin, `/admin/setup-requirements/${req_.id}/restore`);
  assert.equal((await prisma.setupRequirement.findUnique({ where: { id: req_.id } })).archivedAt, null);
  // another organization's admin cannot touch this requirement by ID
  assert.ok(denied(await post(outsider, `/admin/setup-requirements/${req_.id}/archive`)));
  assert.equal((await prisma.setupRequirement.findUnique({ where: { id: req_.id } })).archivedAt, null);
});

test('policy changes are admin-only and audited', async () => {
  // Everyday access & approval policies live under Settings → Security (Task 4) — plain Admin, no
  // System Configuration Access needed; the deeper Training/Skill-scoring form stays at /admin/policies.
  await post(admin, '/admin/settings/security', { 'credentials.ownerCanView': '1' }); // final-approval box left unticked
  const audit = await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'policy.changed' } });
  assert.equal(audit, null); // nothing changed from the defaults, so nothing is logged
  await post(admin, '/admin/settings/security', { 'credentials.ownerCanView': '1', 'leave.supervisorFinalApproval': '1' });
  assert.ok(await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'policy.changed', targetId: 'leave.supervisorFinalApproval' } }));
  await post(admin, '/admin/settings/security', { 'credentials.ownerCanView': '1' });
  assert.equal((await get(admin, '/admin/settings?tab=security&saved=1')).status, 200);
  assert.ok(denied(await post(agentA, '/admin/settings/security', { 'credentials.ownerCanView': '0' })));
});

test('employee, role, team and supervisor changes are audited', async () => {
  const res = await post(admin, `/admin/employees/${agentB.id}`, { fullName: agentB.fullName, role: 'TRAVEL_AGENT', teamId: teamA.id, supervisorId: supA.id, employmentStartDate: isoIn(-100) });
  assert.equal(res.status, 302);
  for (const action of ['employee.team_changed', 'employee.supervisor_changed']) assert.ok(await prisma.auditLog.findFirst({ where: { organizationId: org.id, action, targetId: agentB.id } }), action);
  const flip = await post(admin, `/admin/employees/${agentB.id}`, { fullName: agentB.fullName, role: 'FLIGHT_EXPERT', teamId: teamA.id, supervisorId: supA.id, employmentStartDate: isoIn(-100) });
  assert.equal(flip.status, 302);
  assert.ok(await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'employee.role_changed', targetId: agentB.id } }));
  assert.ok(denied(await post(supA, `/admin/employees/${agentA.id}`, { fullName: 'x', role: 'ADMIN', employmentStartDate: isoIn(-1) })));
  assert.equal((await prisma.profile.findUnique({ where: { id: agentA.id } })).role, 'TRAVEL_AGENT');
  const audits = await prisma.auditLog.findMany({ where: { organizationId: org.id } });
  assert.ok(!JSON.stringify(audits).includes(PASSWORD));
});

// ---------------------------------------------------------------- closing the review gaps
test('an impersonated session (HTTP) can never open the vault, even for the employee being viewed', async () => {
  const cred = await prisma.credential.findFirst({ where: { ownerId: agentA.id, systemKey: 'gmail' } });
  const adminRaw = cookies[admin.id].replace('sz_session=', '');
  const viaLoginAs = (who) => `${cookies[who.id]}; sz_admin_session=${adminRaw}`;
  // Same supervisor session: allowed normally, refused the moment it is an admin's "view as" session.
  assert.equal((await post(supA, `/credentials/${cred.id}/reveal`, { password: PASSWORD })).status, 200);
  const impersonated = await request(app).post(`/credentials/${cred.id}/reveal`).set('Cookie', viaLoginAs(supA)).type('form').send({ password: PASSWORD });
  assert.ok([403, 404].includes(impersonated.status), `status ${impersonated.status}`);   // refused: look-only while viewing as someone else (or not found)
  const asAgent = await request(app).get(`/employees/${agentA.id}/credentials`).set('Cookie', viaLoginAs(agentA));
  assert.ok(denied(asAgent));
  assert.doesNotMatch(asAgent.text, /Credentials<\/a>/);
  const tabs = await request(app).get(`/employees/${agentA.id}/setup`).set('Cookie', viaLoginAs(agentA));
  assert.equal(tabs.status, 200); assert.doesNotMatch(tabs.text, /href="\/employees\/[^"]+\/credentials"/);
});

test('offboarding preserves setup history, revokes access and keeps vault data with admins only', async () => {
  const leaver = await prisma.profile.create({ data: { organizationId: org.id, fullName: 'P1C leaver', username: `p1c_${org.id}_leaver`, email: `p1c_${org.id}_leaver@example.invalid`, role: 'TRAVEL_AGENT', status: 'ACTIVE', passwordHash: await hashPassword(PASSWORD), employmentStartDate: new Date() } });
  const token = generateToken(); await prisma.session.create({ data: { profileId: leaver.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookies[leaver.id] = `sz_session=${token.raw}`;
  const pc = await prisma.setupRequirement.findFirst({ where: { organizationId: org.id, key: 'pc' } });
  await post(admin, `/employees/${leaver.id}/setup/${pc.id}`, { status: 'COMPLETED' });
  await post(admin, `/employees/${leaver.id}/credentials`, { customSystem: 'Old CRM', password: 'leaver-secret' });
  assert.equal((await get(leaver, '/dashboard')).status, 200);

  assert.equal((await post(admin, `/admin/employees/${leaver.id}/archive`)).status, 200);
  assert.equal(await prisma.session.count({ where: { profileId: leaver.id } }), 0);           // sessions revoked
  assert.notEqual((await get(leaver, '/dashboard')).status, 200);                             // and the old cookie stops working
  assert.equal(await prisma.employeeSetupItem.count({ where: { profileId: leaver.id, status: 'COMPLETED' } }), 1); // history kept
  const setupPage = await get(admin, `/employees/${leaver.id}/setup`);
  assert.equal(setupPage.status, 200); assert.match(setupPage.text, /Verified by/);
  assert.match((await get(admin, '/admin/employees?status=ARCHIVED')).text, /P1C leaver/);
  assert.doesNotMatch((await get(admin, '/dashboard')).text, /P1C leaver/);
  const vault = await prisma.credential.findFirst({ where: { ownerId: leaver.id } });
  assert.equal((await post(admin, `/credentials/${vault.id}/reveal`, { password: PASSWORD })).status, 200); // admin can still rotate what the leaver knew
  assert.equal((await post(leaver, `/credentials/${vault.id}/reveal`, { password: PASSWORD })).status === 200, false);
  assert.ok(await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'employee.status_archived', targetId: leaver.id } }));
});

test('the admin list shows each employee training status and custom credential-system requirements feed the vault check', async () => {
  const list = await get(admin, '/admin/employees');
  assert.match(list.text, /<th>Training<\/th>/); assert.match(list.text, /Nothing assigned|completed|retake/);
  await post(admin, '/admin/setup-requirements', { label: 'Zoom login', required: '1', credentialSystem: '1' });
  const zoom = await prisma.setupRequirement.findFirst({ where: { organizationId: org.id, label: 'Zoom login' } });
  assert.equal(zoom.credentialSystem, true);
  assert.match((await get(admin, `/employees/${agentA.id}/credentials`)).text, /Zoom login/); // offered as a vault system
});