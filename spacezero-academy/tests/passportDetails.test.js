'use strict';
// Passport Details (spec Part 4 of the "final quick fix batch"): Number + Expiration Date only,
// integrated as one mandatory Setup requirement, masked by default for management, full reveal
// gated behind a re-entered password, Supervisor capped at a status word unless explicitly
// granted, and reminders reusing the existing notification system's exactly-once dedupe.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { hashPassword } = require('../lib/password');
const { computeSetup } = require('../lib/employeeSetup');
const { passportStatus, maskPassportNumber, passportAccess, runPassportReminders, addMonths } = require('../lib/passport');
const app = require('../server');

let org, cookies = {};
let admin, sup, supGranted, agentA, agentB, expert, outsiderSup;
const PASSWORD = 'Correct-Horse-9!';
const as = (p) => cookies[p.id];
const get = (p, url) => request(app).get(url).set('Cookie', as(p));
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', as(p)).type('form').send(body);
const denied = (res) => [403, 404].includes(res.status);
const audits = (action, targetId) => prisma.auditLog.findMany({ where: { organizationId: org.id, action, ...(targetId ? { targetId } : {}) }, orderBy: { createdAt: 'asc' } });

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Passport tests' } });
  const passwordHash = await hashPassword(PASSWORD);
  async function user(role, name) {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `PD ${name}`, username: `pd_${name}`, email: `pd_${name}@example.invalid`, role, status: 'ACTIVE', passwordHash, employmentStartDate: new Date() } });
    const token = generateToken();
    await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
    cookies[p.id] = `sz_session=${token.raw}`;
    return p;
  }
  admin = await user('ADMIN', 'admin');
  sup = await user('SUPERVISOR', 'sup');
  supGranted = await user('SUPERVISOR', 'supGranted');
  outsiderSup = await user('SUPERVISOR', 'outsiderSup');
  agentA = await user('TRAVEL_AGENT', 'agentA');
  agentB = await user('TRAVEL_AGENT', 'agentB');
  expert = await user('FLIGHT_EXPERT', 'expert');
  await prisma.supervisorAssignment.create({ data: { supervisorId: sup.id, agentId: agentA.id, assignedById: admin.id } });
  await prisma.supervisorAssignment.create({ data: { supervisorId: supGranted.id, agentId: agentB.id, assignedById: admin.id } });
  // Both supervisors need setup.view just to open the Setup page at all (Passport Details lives on
  // it) — passport.viewNumber is a second, separate grant on top, only for supGranted.
  await prisma.supervisorCapability.create({ data: { organizationId: org.id, supervisorId: sup.id, key: 'setup.view', grantedById: admin.id } });
  await prisma.supervisorCapability.create({ data: { organizationId: org.id, supervisorId: supGranted.id, key: 'setup.view', grantedById: admin.id } });
  await prisma.supervisorCapability.create({ data: { organizationId: org.id, supervisorId: supGranted.id, key: 'passport.viewNumber', grantedById: admin.id } });
  await require('../lib/employeeSetup').ensureDefaultRequirements(org.id);
});
after(async () => { await prisma.$disconnect(); });

test('status model: exactly VALID / EXPIRING_SOON / EXPIRED, calendar-aware (not a 30-day approximation)', () => {
  const now = new Date('2026-06-15T00:00:00.000Z');
  assert.equal(passportStatus(new Date('2027-06-15T00:00:00.000Z'), now), 'VALID'); // >6 months out
  assert.equal(passportStatus(new Date('2026-12-16T00:00:00.000Z'), now), 'VALID'); // just over 6 calendar months out
  assert.equal(passportStatus(new Date('2026-12-15T00:00:00.000Z'), now), 'EXPIRING_SOON'); // exactly 6 calendar months out — the inclusive edge
  assert.equal(passportStatus(new Date('2026-07-01T00:00:00.000Z'), now), 'EXPIRING_SOON'); // well inside 6 months
  assert.equal(passportStatus(new Date('2026-06-14T00:00:00.000Z'), now), 'EXPIRED');
  assert.equal(passportStatus(new Date('2026-06-15T00:00:00.000Z'), now), 'EXPIRED'); // expires today counts as expired
  assert.equal(passportStatus(null, now), null);
});

test('maskPassportNumber never shows more than the last 4 characters', () => {
  assert.equal(maskPassportNumber('AB1234567'), '•••••4567');
  assert.equal(maskPassportNumber('1234'), '1234');
  assert.equal(maskPassportNumber(''), '••••');
});

test('passportAccess: self full, admin full, supervisor status-only by default, capability grants view (never manage), everyone else none', async () => {
  const selfAccess = await passportAccess(agentA, agentA);
  assert.deepEqual(selfAccess, { view: true, manage: true, statusVisible: true });
  const adminAccess = await passportAccess(admin, agentA);
  assert.deepEqual(adminAccess, { view: true, manage: true, statusVisible: true });
  const supAccess = await passportAccess(sup, agentA);
  assert.deepEqual(supAccess, { view: false, manage: false, statusVisible: true });
  const grantedAccess = await passportAccess(supGranted, agentB);
  assert.deepEqual(grantedAccess, { view: true, manage: false, statusVisible: true }); // view only — never manage
  const unrelated = await passportAccess(outsiderSup, agentA);
  assert.deepEqual(unrelated, { view: false, manage: false, statusVisible: false });
  const expertLooking = await passportAccess(expert, agentA);
  assert.deepEqual(expertLooking, { view: false, manage: false, statusVisible: false });
});

test('Setup integration: Passport Details is exactly ONE mandatory requirement, not two, and does not reset when expired', async () => {
  const fresh = await prisma.profile.findUnique({ where: { id: agentA.id } });
  const requirements = await prisma.setupRequirement.findMany({ where: { organizationId: org.id } });
  const passportReq = requirements.find((r) => r.key === 'passport_details');
  assert.ok(passportReq, 'passport_details requirement should be auto-seeded');
  assert.equal(passportReq.kind, 'PASSPORT');
  assert.equal(passportReq.required, true);

  const before = computeSetup({ profile: fresh, requirements, items: [], vaultSystemKeys: [], hasAddress: false });
  const passportRowBefore = before.rows.find((r) => r.requirement.key === 'passport_details');
  assert.equal(passportRowBefore.status, 'NOT_SET_UP');
  assert.equal(passportRowBefore.counts, true);

  // Simulate a completed passport (encrypted number + expiration present) via a plain profile
  // object — completion is derived, never a separately-ticked checklist item.
  const withPassport = { ...fresh, passportNumberEnc: 'v1.fake.fake.fake', passportExpiresAt: new Date('2020-01-01T00:00:00.000Z') }; // already expired
  const after1 = computeSetup({ profile: withPassport, requirements, items: [], vaultSystemKeys: [], hasAddress: false });
  const passportRowAfter = after1.rows.find((r) => r.requirement.key === 'passport_details');
  assert.equal(passportRowAfter.status, 'COMPLETED', 'an expired passport is still a COMPLETED Setup item — expiration is a separate, ongoing concern');
  assert.equal(after1.rows.filter((r) => r.requirement.key === 'passport_details').length, 1, 'exactly one row, not a separate Number/Expiration split');
});

test('employee self-service: add, view own full number, update keeps number when left blank, audited without the raw number', async () => {
  const page = await get(agentA, `/employees/${agentA.id}/setup`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Passport Details Required/);

  const add = await post(agentA, `/employees/${agentA.id}/passport`, { passportNumber: 'ab1234567', passportExpiresAt: '2030-01-01' });
  assert.equal(add.status, 302);
  const afterAdd = await prisma.profile.findUnique({ where: { id: agentA.id } });
  assert.ok(afterAdd.passportNumberEnc);
  assert.equal(afterAdd.passportExpiresAt.toISOString().slice(0, 10), '2030-01-01');

  const addedAudits = await audits('passport.details_added', agentA.id);
  assert.equal(addedAudits.length, 1);
  assert.doesNotMatch(JSON.stringify(addedAudits[0]), /AB1234567/i);

  const own = await get(agentA, `/employees/${agentA.id}/setup`);
  assert.match(own.text, /AB1234567/); // self sees their own full number
  assert.doesNotMatch(own.text, /Passport Details Required/);

  // Update expiration only, leaving the number blank — the stored number must be unchanged.
  const upd = await post(agentA, `/employees/${agentA.id}/passport`, { passportNumber: '', passportExpiresAt: '2031-06-15' });
  assert.equal(upd.status, 302);
  const afterUpd = await prisma.profile.findUnique({ where: { id: agentA.id } });
  assert.equal(afterUpd.passportNumberEnc, afterAdd.passportNumberEnc, 'blank number on update keeps the existing encrypted value');
  assert.equal(afterUpd.passportExpiresAt.toISOString().slice(0, 10), '2031-06-15');
  assert.equal((await audits('passport.details_updated', agentA.id)).length, 1);
});

test('masking, reveal and access boundaries for management viewers', async () => {
  // agentB gets a passport of their own for this test.
  await post(agentB, `/employees/${agentB.id}/passport`, { passportNumber: 'CD9988776', passportExpiresAt: '2029-05-01' });

  // Admin sees the page with the number masked by default, never the raw value inline.
  const adminPage = await get(admin, `/employees/${agentB.id}/setup`);
  assert.match(adminPage.text, /••••••8776|•••••8776/);
  assert.doesNotMatch(adminPage.text, /CD9988776/);

  // Admin reveal: wrong password fails and is audited; correct password succeeds and is audited,
  // and the raw number never appears in any audit row.
  const wrong = await post(admin, `/employees/${agentB.id}/passport/reveal`, { password: 'wrong-password' });
  assert.equal(wrong.status, 401);
  assert.equal((await audits('passport.reveal_failed', agentB.id)).length, 1);

  const right = await post(admin, `/employees/${agentB.id}/passport/reveal`, { password: PASSWORD });
  assert.equal(right.status, 200);
  assert.equal(right.body.passportNumber, 'CD9988776');
  const viewedAudits = await audits('passport.viewed', agentB.id);
  assert.equal(viewedAudits.length, 1);
  assert.doesNotMatch(JSON.stringify(viewedAudits[0]), /CD9988776/);

  // Plain supervisor (no capability): status word only, no number anywhere on the page, reveal denied.
  const supPage = await get(sup, `/employees/${agentA.id}/setup`);
  assert.equal(supPage.status, 200);
  assert.doesNotMatch(supPage.text, /AB1234567|CD9988776/);
  assert.ok(denied(await post(sup, `/employees/${agentA.id}/passport/reveal`, { password: PASSWORD })));
  assert.ok(denied(await post(sup, `/employees/${agentA.id}/passport`, { passportNumber: 'ZZ0000000', passportExpiresAt: '2030-01-01' })), 'a supervisor can never edit passport details, even with the capability');

  // Supervisor WITH the explicit grant: can view masked + reveal for their own team member only.
  const grantedPage = await get(supGranted, `/employees/${agentB.id}/setup`);
  assert.match(grantedPage.text, /••••••8776|•••••8776/);
  const grantedReveal = await post(supGranted, `/employees/${agentB.id}/passport/reveal`, { password: PASSWORD });
  assert.equal(grantedReveal.status, 200);
  assert.equal(grantedReveal.body.passportNumber, 'CD9988776');
  // ...but never for an employee outside their own team.
  assert.ok(denied(await post(supGranted, `/employees/${agentA.id}/passport/reveal`, { password: PASSWORD })));

  // A Flight Expert (or any unrelated actor) cannot even reach another employee's Setup page.
  assert.ok(denied(await get(expert, `/employees/${agentB.id}/setup`)));
});

test('the Passport Number never appears in the Employees & Teams list, and Passport Status filters correctly', async () => {
  const list = await get(admin, '/admin/employees');
  assert.doesNotMatch(list.text, /CD9988776|AB1234567/);

  const expired = await get(admin, '/admin/employees?passportStatus=EXPIRED');
  assert.doesNotMatch(expired.text, /PD agentB/); // agentB's passport expires 2029, not expired
  const valid = await get(admin, '/admin/employees?passportStatus=VALID');
  assert.match(valid.text, /PD agentB/);
  assert.doesNotMatch(valid.text, /CD9988776/);
});

test('reminders fire exactly once per milestone via notifyOnce, reach the employee + their supervisor + admins (never an unrelated supervisor), and never include the number', async () => {
  const now = new Date('2026-06-15T00:00:00.000Z');
  const expiresIn5Months = addMonths(now, 5); // inside the 6-month window, outside the 3-month one
  await prisma.profile.update({ where: { id: agentA.id }, data: { passportExpiresAt: expiresIn5Months } });

  const firstRun = await runPassportReminders(org.id, now);
  assert.ok(firstRun > 0);
  const employeeNotifs = await prisma.notification.findMany({ where: { profileId: agentA.id, type: 'passport.expiring' } });
  assert.equal(employeeNotifs.length, 1);
  assert.doesNotMatch(employeeNotifs[0].body, /[A-Z0-9]{6,}/); // no number-shaped token in the body

  const supNotifs = await prisma.notification.findMany({ where: { profileId: sup.id, type: 'passport.expiring' } });
  assert.equal(supNotifs.length, 1, 'agentA\'s own supervisor should be notified');
  const adminNotifs = await prisma.notification.findMany({ where: { profileId: admin.id, type: 'passport.expiring' } });
  assert.ok(adminNotifs.length >= 1);
  const unrelatedSupNotifs = await prisma.notification.findMany({ where: { profileId: outsiderSup.id, type: 'passport.expiring' } });
  assert.equal(unrelatedSupNotifs.length, 0, 'an unrelated supervisor must never be notified');

  // Running again the same day must not create duplicates (notifyOnce dedupe).
  await runPassportReminders(org.id, now);
  assert.equal((await prisma.notification.count({ where: { profileId: agentA.id, type: 'passport.expiring' } })), 1);

  // Renewing the passport (a new expiration date) must not be blocked by the old dedupe key, and
  // must not resend an already-passed milestone for the new date.
  const renewedFarOut = addMonths(now, 24); // renewed far into the future: no milestone due yet
  await prisma.profile.update({ where: { id: agentA.id }, data: { passportExpiresAt: renewedFarOut } });
  await runPassportReminders(org.id, now);
  assert.equal((await prisma.notification.count({ where: { profileId: agentA.id, type: 'passport.expiring' } })), 1, 'no new reminder is due yet for the renewed date');
});
