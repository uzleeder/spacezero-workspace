'use strict';
// Admin-granted Supervisor management permissions: a Supervisor has no capability by default,
// an Admin grants/revokes each individually, and a capability never widens WHO a Supervisor may
// act on — only WHAT they may do to people already in their own team scope.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { hashPassword } = require('../lib/password');
const app = require('../server');

let org, admin, sup1, sup2, agent1, agent2, tool, verifyTool, cookies = {};
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);
const denied = (res) => [403, 404].includes(res.status);
const grantedKeys = async (supervisorId) => new Set((await prisma.supervisorCapability.findMany({ where: { supervisorId } })).map((r) => r.key));

async function makeUser(role, name) {
  const passwordHash = await hashPassword('Correct-Horse-9!');
  const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `SP ${name}`, username: `sp_${org.id}_${name}`, email: `sp_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', passwordHash, employmentStartDate: new Date() } });
  const token = generateToken();
  await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
  cookies[p.id] = `sz_session=${token.raw}`;
  return p;
}

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Supervisor permission tests' } });
  admin = await makeUser('ADMIN', 'admin');
  sup1 = await makeUser('SUPERVISOR', 'sup1');
  agent1 = await makeUser('TRAVEL_AGENT', 'agent1');
  await prisma.supervisorAssignment.create({ data: { supervisorId: sup1.id, agentId: agent1.id, assignedById: admin.id } });
  await post(admin, '/admin/setup-requirements', { label: 'SP Tool', category: 'Equipment', audience: 'ALL_EMPLOYEES', required: 'required', verification: 'EMPLOYEE_CONFIRMATION' });
  await post(admin, '/admin/setup-requirements', { label: 'SP Verify Tool', category: 'Equipment', audience: 'ALL_EMPLOYEES', required: 'required', verification: 'MANAGEMENT_VERIFICATION' });
  tool = await prisma.setupRequirement.findFirst({ where: { organizationId: org.id, label: 'SP Tool' } });
  verifyTool = await prisma.setupRequirement.findFirst({ where: { organizationId: org.id, label: 'SP Verify Tool' } });

  // Explicit admin grant for the first supervisor; opening pages grants nothing.
  await post(admin, '/admin/supervisor-permissions/' + sup1.id, { capabilities: ['setup.view', 'setup.manage', 'setup.verify'] });

  sup2 = await makeUser('SUPERVISOR', 'sup2');
  agent2 = await makeUser('TRAVEL_AGENT', 'agent2');
  await prisma.supervisorAssignment.create({ data: { supervisorId: sup2.id, agentId: agent2.id, assignedById: admin.id } });
});
after(async () => { await prisma.$disconnect(); });

test('opening permission screens never grants rights, including after all rights are revoked', async () => {
  // Scoped to the two Supervisors specifically: the org-wide table also holds each Admin's own
  // System Configuration Access grant (Task 3) — a different concept sharing the same table/audit
  // pattern, seeded lazily the first time any Admin Configuration route is visited (below).
  const supervisorGrantCount = () => prisma.supervisorCapability.count({ where: { organizationId: org.id, supervisorId: { in: [sup1.id, sup2.id] } } });
  await post(admin, `/admin/supervisor-permissions/${sup1.id}`, {});
  await post(admin, `/admin/supervisor-permissions/${sup2.id}`, {});
  assert.equal(await supervisorGrantCount(), 0);
  assert.equal((await get(admin, '/admin/supervisor-permissions')).status, 200);
  assert.equal((await get(sup1, `/employees/${agent1.id}/setup`)).status, 403);
  assert.equal(await supervisorGrantCount(), 0);
  await post(admin, `/admin/supervisor-permissions/${sup1.id}`, { capabilities: ['setup.view', 'setup.manage', 'setup.verify'] });
});

test('EXPLICIT ADMIN GRANT: sup1 can manage their team\'s setup', async () => {
  const keys = await grantedKeys(sup1.id);
  assert.ok(keys.has('setup.view') && keys.has('setup.manage') && keys.has('setup.verify'));
  const page = await get(sup1, `/employees/${agent1.id}/setup`);
  assert.equal(page.status, 200);
  assert.match(page.text, /data-bulk-setup-form/);
});

test('NEW SUPERVISOR STARTS WITH NOTHING: sup2 cannot view or manage setup until granted', async () => {
  assert.equal((await grantedKeys(sup2.id)).size, 0);
  const viewRes = await get(sup2, `/employees/${agent2.id}/setup`);
  assert.equal(viewRes.status, 403);
  const manageRes = await post(sup2, `/employees/${agent2.id}/setup/bulk`, { checked: [tool.id] });
  assert.ok(denied(manageRes));
  assert.equal((await prisma.employeeSetupItem.findFirst({ where: { profileId: agent2.id, requirementId: tool.id } })), null);
});

test('SUPERVISOR CANNOT SELF-GRANT: only an Admin can reach the permissions screen', async () => {
  assert.ok(denied(await get(sup2, '/admin/supervisor-permissions')));
  assert.ok(denied(await get(sup2, `/admin/supervisor-permissions/${sup2.id}`)));
  assert.ok(denied(await post(sup2, `/admin/supervisor-permissions/${sup2.id}`, { capabilities: ['setup.view', 'setup.manage', 'setup.verify'] })));
  assert.equal((await grantedKeys(sup2.id)).size, 0);
});

test('ADMIN GRANTS setup.view + setup.manage: sup2 can now view and manage ONLY their own team', async () => {
  const res = await post(admin, `/admin/supervisor-permissions/${sup2.id}`, { capabilities: ['setup.view', 'setup.manage'] });
  assert.equal(res.status, 302);
  const keys = await grantedKeys(sup2.id);
  assert.ok(keys.has('setup.view') && keys.has('setup.manage') && !keys.has('setup.verify'));

  const own = await post(sup2, `/employees/${agent2.id}/setup/bulk`, { checked: [tool.id] });
  assert.equal(own.status, 302);
  assert.equal((await prisma.employeeSetupItem.findFirst({ where: { profileId: agent2.id, requirementId: tool.id } })).status, 'COMPLETED');

  const other = await post(sup2, `/employees/${agent1.id}/setup/bulk`, { checked: [tool.id] });
  assert.ok(denied(other), 'setup.manage never widens WHO a Supervisor may act on — sup2 still cannot touch sup1\'s agent');

  const audit = await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'supervisor.capability_granted', targetId: sup2.id, metadataJson: { contains: 'setup.manage' } } });
  assert.ok(audit);
});

test('setup.verify gates approving an employee\'s pending self-confirmation into Completed', async () => {
  // Neither the advanced editor nor a bulk checkbox may verify a fresh item without a grant.
  const direct = await post(sup2, `/employees/${agent2.id}/setup/${verifyTool.id}`, { status: 'COMPLETED' });
  assert.match(direct.text, /do not have permission to verify/);
  const bulk = await post(sup2, `/employees/${agent2.id}/setup/bulk`, { checked: [tool.id, verifyTool.id] });
  assert.match(bulk.text, /do not have permission to verify/);
  assert.equal(await prisma.employeeSetupItem.findFirst({ where: { profileId: agent2.id, requirementId: verifyTool.id } }), null);
  await post(agent2, `/employees/${agent2.id}/setup/${verifyTool.id}/confirm`, {});
  const pending = await prisma.employeeSetupItem.findFirst({ where: { profileId: agent2.id, requirementId: verifyTool.id } });
  assert.equal(pending.status, 'IN_PROGRESS');

  // sup2 has setup.manage but not setup.verify: cannot approve the pending confirmation.
  const blocked = await post(sup2, `/employees/${agent2.id}/setup/${verifyTool.id}`, { status: 'COMPLETED' });
  assert.equal(blocked.status, 200);
  assert.match(blocked.text, /do not have permission to verify/);
  assert.equal((await prisma.employeeSetupItem.findFirst({ where: { profileId: agent2.id, requirementId: verifyTool.id } })).status, 'IN_PROGRESS');

  await post(admin, `/admin/supervisor-permissions/${sup2.id}`, { capabilities: ['setup.view', 'setup.manage', 'setup.verify'] });
  const allowed = await post(sup2, `/employees/${agent2.id}/setup/${verifyTool.id}`, { status: 'COMPLETED' });
  assert.equal(allowed.status, 302);
  const done = await prisma.employeeSetupItem.findFirst({ where: { profileId: agent2.id, requirementId: verifyTool.id } });
  assert.equal(done.status, 'COMPLETED');
  assert.equal(done.verifiedById, sup2.id);
});

test('REVOKE: removing setup.manage immediately blocks further management, and is audited', async () => {
  const res = await post(admin, `/admin/supervisor-permissions/${sup2.id}`, { capabilities: ['setup.view'] });
  assert.equal(res.status, 302);
  const keys = await grantedKeys(sup2.id);
  assert.ok(keys.has('setup.view') && !keys.has('setup.manage') && !keys.has('setup.verify'));

  const view = await get(sup2, `/employees/${agent2.id}/setup`);
  assert.equal(view.status, 200); // still allowed to view
  assert.doesNotMatch(view.text, /setup\/bulk" data-bulk-setup-form/);

  const manage = await post(sup2, `/employees/${agent2.id}/setup/bulk`, { checked: [] });
  assert.ok(denied(manage));

  const revoked = await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'supervisor.capability_revoked', targetId: sup2.id, metadataJson: { contains: 'setup.manage' } } });
  assert.ok(revoked);
});
