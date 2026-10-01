'use strict';
// Employee self-setup redesign: "I Have / I Don't Have" batched into one Save, replacing the
// individual confirm-button cards, while preserving the existing verification-rule split
// (EMPLOYEE_CONFIRMATION completes outright; MANAGEMENT_VERIFICATION only requests verification)
// and the existing withdraw/audit/concurrency guarantees.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { hashPassword } = require('../lib/password');
const app = require('../server');

let org, admin, agent, selfTool, checkedTool, cookies = {};
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);
const state = (requirementId) => prisma.employeeSetupItem.findFirst({ where: { profileId: agent.id, requirementId } });

async function makeUser(role, name) {
  const passwordHash = await hashPassword('Correct-Horse-9!');
  const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `HD ${name}`, username: `hd_${org.id}_${name}`, email: `hd_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', passwordHash, employmentStartDate: new Date() } });
  const token = generateToken();
  await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
  cookies[p.id] = `sz_session=${token.raw}`;
  return p;
}

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Have DontHave tests' } });
  admin = await makeUser('ADMIN', 'admin');
  agent = await makeUser('TRAVEL_AGENT', 'agent');
  await post(admin, '/admin/setup-requirements', { label: 'HD Self Tool', category: 'Equipment', audience: 'ALL_EMPLOYEES', required: 'required', verification: 'EMPLOYEE_CONFIRMATION' });
  await post(admin, '/admin/setup-requirements', { label: 'HD Checked Tool', category: 'Equipment', audience: 'ALL_EMPLOYEES', required: 'required', verification: 'MANAGEMENT_VERIFICATION' });
  await post(admin, '/admin/setup-requirements', { label: 'HD Admin Only Tool', category: 'Equipment', audience: 'ALL_EMPLOYEES', required: 'required', verification: 'MANAGEMENT_ONLY' });
  selfTool = await prisma.setupRequirement.findFirst({ where: { organizationId: org.id, label: 'HD Self Tool' } });
  checkedTool = await prisma.setupRequirement.findFirst({ where: { organizationId: org.id, label: 'HD Checked Tool' } });
});
after(async () => { await prisma.$disconnect(); });

test('COMPACT: the self setup page shows the I Have / I Don\'t Have bulk form', async () => {
  const page = await get(agent, `/employees/${agent.id}/setup`);
  assert.equal(page.status, 200);
  assert.match(page.text, /data-self-bulk-form/);
  assert.match(page.text, /I Have/);
  assert.match(page.text, /I Don&#39;t Have|I Don't Have/);
});

test('MANAGEMENT_ONLY item never appears in the self bulk form', async () => {
  const page = await get(agent, `/employees/${agent.id}/setup`);
  const bulkFormSection = page.text.split('data-self-bulk-form')[1].split('</form>')[0];
  assert.doesNotMatch(bulkFormSection, /HD Admin Only Tool/);
  assert.match(page.text, /Only your supervisor or an administrator can mark this as completed/);
});

test('I HAVE + EMPLOYEE_CONFIRMATION: completes the item outright, in one batched request', async () => {
  const res = await post(agent, `/employees/${agent.id}/setup/self-bulk`, { [`choice_${selfTool.id}`]: 'have' });
  assert.equal(res.status, 302);
  const row = await state(selfTool.id);
  assert.equal(row.status, 'COMPLETED');
  assert.ok(row.employeeConfirmedAt);
  assert.equal(row.verifiedById, null, 'self-confirmation is not the same as management verification');
});

test('I HAVE + MANAGEMENT_VERIFICATION: only requests verification, never completes it directly', async () => {
  const res = await post(agent, `/employees/${agent.id}/setup/self-bulk`, { [`choice_${checkedTool.id}`]: 'have' });
  assert.equal(res.status, 302);
  const row = await state(checkedTool.id);
  assert.equal(row.status, 'IN_PROGRESS');
  assert.ok(row.employeeConfirmedAt);
  assert.equal(row.verifiedById, null);
  const page = await get(agent, `/employees/${agent.id}/setup`);
  assert.match(page.text, /awaiting verification/);
  assert.match(page.text, /Withdraw my confirmation/);
});

// Regression test for a real bug: the "Withdraw my confirmation" control used to be rendered as a
// <form> nested inside the self-bulk <form> for any row awaiting verification. Nested <form>
// elements are invalid HTML5 — the browser closes the OUTER form the instant it hits the first
// inner </form>, silently detaching every later row (and the Save Changes button itself) from the
// real form, so most of a batch save was dropped on submit with no visible error. Supertest posts
// a body directly and never parses/renders the page, so it cannot catch this class of bug — only
// checking the actual HTML structure can. checkedTool is awaiting verification at this point
// (previous test), so its row renders the "Withdraw" control that used to break this.
test('HTML STRUCTURE: no <form> is nested inside the self-bulk form (would silently break Save)', async () => {
  const page = await get(agent, `/employees/${agent.id}/setup`);
  const start = page.text.indexOf('data-self-bulk-form');
  assert.ok(start >= 0, 'self-bulk form must be present');
  const rest = page.text.slice(start);
  const body = rest.slice(rest.indexOf('>') + 1); // past the opening <form ...> tag itself
  let depth = 1; // inside the self-bulk form
  let i = 0;
  let closeIndex = -1;
  while (depth > 0) {
    const nextOpen = body.indexOf('<form', i);
    const nextClose = body.indexOf('</form>', i);
    assert.ok(nextClose >= 0, 'self-bulk form is never closed');
    if (nextOpen >= 0 && nextOpen < nextClose) { depth += 1; i = nextOpen + 5; }
    else { depth -= 1; i = nextClose + 7; if (depth === 0) closeIndex = nextClose; }
  }
  assert.equal(depth, 0);
  const formSection = body.slice(0, closeIndex);
  assert.doesNotMatch(formSection, /<form\b/, 'no nested <form> may appear inside the self-bulk form');
  assert.match(formSection, /data-self-bulk-save/, 'the Save Changes button must be inside the real form');
});

test('I DON\'T HAVE without a note: the ENTIRE batch is rejected, nothing is saved', async () => {
  const before1 = await state(selfTool.id);
  const res = await post(agent, `/employees/${agent.id}/setup/self-bulk`, { [`choice_${selfTool.id}`]: 'dontHave', [`note_${selfTool.id}`]: '   ' });
  assert.equal(res.status, 200); // re-rendered with an error, not redirected
  assert.match(res.text, /note is required/);
  const after1 = await state(selfTool.id);
  assert.deepEqual(after1.updatedAt, before1.updatedAt, 'nothing changed');
});

test('I DON\'T HAVE with a note: sets ISSUE with that note, batched with other changes in one audit trail', async () => {
  await prisma.auditLog.deleteMany({ where: { organizationId: org.id, targetId: agent.id } });
  const res = await post(agent, `/employees/${agent.id}/setup/self-bulk`, {
    [`choice_${selfTool.id}`]: 'dontHave', [`note_${selfTool.id}`]: 'Waiting for IT to issue one',
  });
  assert.equal(res.status, 302);
  const row = await state(selfTool.id);
  assert.equal(row.status, 'ISSUE');
  assert.equal(row.note, 'Waiting for IT to issue one');
  assert.equal(row.employeeConfirmedAt, null);

  const entries = await prisma.auditLog.findMany({ where: { organizationId: org.id, targetId: agent.id, action: 'setup.employee_flagged_issue' } });
  assert.equal(entries.length, 1);
  assert.equal(JSON.parse(entries[0].metadataJson).requirement, 'hd_self_tool');
});

test('UNTOUCHED ITEMS: an item with no choice submitted is left exactly as-is', async () => {
  const before1 = await state(checkedTool.id);
  await post(agent, `/employees/${agent.id}/setup/self-bulk`, {}); // empty batch
  const after1 = await state(checkedTool.id);
  assert.deepEqual(after1, before1);
});

test('CONCURRENCY: a stale timestamp is skipped, not silently overwritten', async () => {
  const res1 = await post(agent, `/employees/${agent.id}/setup/self-bulk`, { [`choice_${checkedTool.id}`]: 'have', [`ts_${checkedTool.id}`]: '2020-01-01T00:00:00.000Z' });
  assert.equal(res1.status, 302);
  assert.match(res1.headers.location, /conflicts=1/);
});

test('CANNOT SELF-BULK ANOTHER EMPLOYEE, and impersonation is blocked', async () => {
  const other = await makeUser('TRAVEL_AGENT', 'other');
  const res = await post(agent, `/employees/${other.id}/setup/self-bulk`, { [`choice_${selfTool.id}`]: 'have' });
  assert.equal(res.status, 403);
});

test('MANAGEMENT-VERIFIED items are excluded from the self bulk form and cannot be touched via it', async () => {
  await post(admin, `/employees/${agent.id}/setup/${checkedTool.id}`, { status: 'COMPLETED', note: 'verified by admin' });
  const verified = await state(checkedTool.id);
  assert.equal(verified.status, 'COMPLETED');
  assert.ok(verified.verifiedById);

  const page = await get(agent, `/employees/${agent.id}/setup`);
  const bulkFormSection = page.text.split('data-self-bulk-form')[1].split('</form>')[0];
  assert.doesNotMatch(bulkFormSection, /HD Checked Tool/);

  await post(agent, `/employees/${agent.id}/setup/self-bulk`, { [`choice_${checkedTool.id}`]: 'dontHave', [`note_${checkedTool.id}`]: 'trying to undo' });
  const stillVerified = await state(checkedTool.id);
  assert.equal(stillVerified.status, 'COMPLETED');
  assert.equal(stillVerified.verifiedById, admin.id, 'a management-verified item is not the employee\'s to change here');
});
