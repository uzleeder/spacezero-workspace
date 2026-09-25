'use strict';
// Admin-managed employee setup requirements: the checklist is configuration, not code.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { hashPassword } = require('../lib/password');
const { computeSetup, requirementApplies } = require('../lib/employeeSetup');
const app = require('../server');

let org, otherOrg, cookies = {};
let admin, sup, agentA, agentB, agentC, expert, invited, outsider, team;
const as = (p) => cookies[p.id];
const get = (p, url) => request(app).get(url).set('Cookie', as(p));
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', as(p)).type('form').send(body);
const denied = (res) => [403, 404].includes(res.status);
const req = (label) => prisma.setupRequirement.findFirst({ where: { organizationId: org.id, label } });
const percentText = async (who, subject) => (await get(who, `/employees/${subject.id}/setup`)).text.match(/(\d+)% — ([A-Za-z ]+)/);
const audits = (action, targetId) => prisma.auditLog.findMany({ where: { organizationId: org.id, action, ...(targetId ? { targetId } : {}) }, orderBy: { createdAt: 'asc' } });

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Setup config tests' } });
  otherOrg = await prisma.organization.create({ data: { name: 'Setup config other org' } });
  const passwordHash = await hashPassword('Correct-Horse-9!');
  async function user(role, name, { status = 'ACTIVE', organizationId = org.id } = {}) {
    const p = await prisma.profile.create({ data: { organizationId, fullName: `SC ${name}`, username: `sc_${organizationId}_${name}`, email: `sc_${organizationId}_${name}@example.invalid`, role, status, passwordHash: status === 'INVITED' ? null : passwordHash, employmentStartDate: new Date() } });
    if (status === 'ACTIVE') {
      const token = generateToken();
      await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
      cookies[p.id] = `sz_session=${token.raw}`;
    }
    return p;
  }
  admin = await user('ADMIN', 'admin'); sup = await user('SUPERVISOR', 'sup');
  agentA = await user('TRAVEL_AGENT', 'agentA'); agentB = await user('TRAVEL_AGENT', 'agentB'); agentC = await user('TRAVEL_AGENT', 'agentC');
  expert = await user('FLIGHT_EXPERT', 'expert'); invited = await user('TRAVEL_AGENT', 'invited', { status: 'INVITED' });
  outsider = await user('ADMIN', 'outsider', { organizationId: otherOrg.id });
  team = await prisma.team.create({ data: { organizationId: org.id, name: 'SC Team' } });
  for (const p of [agentA, agentB, agentC, expert]) await prisma.supervisorAssignment.create({ data: { supervisorId: sup.id, agentId: p.id, assignedById: admin.id } });
  await prisma.teamMembership.create({ data: { teamId: team.id, profileId: agentC.id } });

  // A tidy 18-item checklist that is fully completed for every activated employee (employee-confirmed items),
  // so "18/18 = 100%" can be compared with "18/19 = 95%".
  await prisma.setupRequirement.createMany({ data: Array.from({ length: 18 }, (_, i) => ({ organizationId: org.id, key: `base_${i}`, label: `Base ${i}`, category: 'Equipment', kind: 'MANUAL', verification: 'EMPLOYEE_CONFIRMATION', displayOrder: i })) });
  const base = await prisma.setupRequirement.findMany({ where: { organizationId: org.id } });
  for (const p of [agentA, agentB, agentC, expert, invited, sup]) {
    await prisma.employeeSetupItem.createMany({ data: base.map((r) => ({ profileId: p.id, requirementId: r.id, status: 'COMPLETED', employeeConfirmedAt: new Date() })) });
  }
});
after(async () => { await prisma.$disconnect(); });

test('admin can create a setup tool from the UI, with a category, roles, verification and no code change', async () => {
  assert.equal((await get(admin, '/admin/setup-requirements')).status, 200);
  assert.equal((await get(admin, '/admin/setup-requirements/new')).status, 200);
  assert.match((await percentText(agentA, agentA))[0], /100% — Fully Set Up/);
  assert.match((await percentText(expert, expert))[0], /100% — Fully Set Up/);

  const res = await post(admin, '/admin/setup-requirements', { label: 'Amadeus', description: 'Amadeus Selling Platform login', category: 'System Access', audience: 'ROLES', roles: ['TRAVEL_AGENT'], required: 'required', verification: 'MANAGEMENT_VERIFICATION' });
  assert.equal(res.status, 302); assert.match(res.headers.location, /saved=1&applied=3&pending=3/); // 3 activated agents affected, invited agent is not
  const amadeus = await req('Amadeus');
  assert.equal(amadeus.category, 'System Access'); assert.equal(amadeus.audience, 'ROLES'); assert.deepEqual(JSON.parse(amadeus.rolesJson), ['TRAVEL_AGENT']);
  assert.equal(amadeus.verification, 'MANAGEMENT_VERIFICATION'); assert.equal(amadeus.required, true); assert.equal(amadeus.kind, 'MANUAL');
  const list = await get(admin, '/admin/setup-requirements');
  assert.match(list.text, /Amadeus/); assert.match(list.text, /System Access/); assert.match(list.text, /Travel Agent/); assert.match(list.text, /Management verification/);
  assert.match((await get(agentA, `/employees/${agentA.id}/setup`)).text, /Amadeus/);
});

test('a new required agent tool recalculates activated agents (18/19 = 95%), spares other roles and Not Activated employees', async () => {
  for (const agent of [agentA, agentB, agentC]) {
    const m = await percentText(admin, agent);
    assert.equal(m[1], '95'); assert.equal(m[2].trim(), 'Setup Required');
  }
  assert.match((await percentText(expert, expert))[0], /100% — Fully Set Up/);   // flight expert unaffected
  assert.match((await percentText(admin, sup))[0], /100% — Fully Set Up/);       // supervisor unaffected
  const inv = await get(admin, `/employees/${invited.id}/setup`);
  assert.match(inv.text, /Setup Not Started/); assert.doesNotMatch(inv.text, /Setup Required/);
  const list = await get(admin, '/admin/employees?setup=notstarted');
  assert.match(list.text, /SC invited/); assert.doesNotMatch(list.text, /SC agentA/);
  assert.doesNotMatch((await get(admin, '/admin/employees?setup=required')).text, /SC invited/);
  assert.match((await get(admin, '/admin/employees?setup=required')).text, /SC agentA/);
  assert.match((await get(admin, '/admin/employees?missing=' + (await req('Amadeus')).key)).text, /SC agentB/);
  // supervisor sees the same readiness for their team
  assert.match((await get(sup, '/team?setup=required')).text, /SC agentA/);
  assert.doesNotMatch((await get(sup, '/team?setup=required')).text, /SC expert/);
});

test('an optional tool never lowers the setup percentage but still appears in the checklist', async () => {
  await post(admin, '/admin/setup-requirements', { label: 'Optional Reference Extension', category: 'Extension / Software', audience: 'ALL_EMPLOYEES', required: 'optional', verification: 'EMPLOYEE_CONFIRMATION' });
  assert.match((await percentText(expert, expert))[0], /100% — Fully Set Up/);
  const page = await get(expert, `/employees/${expert.id}/setup`);
  assert.match(page.text, /Optional Reference Extension/); assert.match(page.text, /Optional/);
  assert.equal((await percentText(admin, agentA))[1], '95');
});

test('verification rules: employee confirmation, management verification and management-only are enforced', async () => {
  await post(admin, '/admin/setup-requirements', { label: 'Self Tool', category: 'Equipment', audience: 'ROLES', roles: ['FLIGHT_EXPERT'], required: 'required', verification: 'EMPLOYEE_CONFIRMATION' });
  await post(admin, '/admin/setup-requirements', { label: 'Checked Tool', category: 'Equipment', audience: 'ROLES', roles: ['FLIGHT_EXPERT'], required: 'required', verification: 'MANAGEMENT_VERIFICATION' });
  await post(admin, '/admin/setup-requirements', { label: 'Admin Tool', category: 'Equipment', audience: 'ROLES', roles: ['FLIGHT_EXPERT'], required: 'required', verification: 'MANAGEMENT_ONLY' });
  const [self, checked, only] = await Promise.all([req('Self Tool'), req('Checked Tool'), req('Admin Tool')]);
  const confirm = (who, r, extra = {}) => post(who, `/employees/${who.id}/setup/${r.id}/confirm`, extra);
  const state = (r) => prisma.employeeSetupItem.findFirst({ where: { profileId: expert.id, requirementId: r.id } });

  // A. employee confirmation is enough
  assert.equal((await confirm(expert, self)).status, 302);
  assert.equal((await state(self)).status, 'COMPLETED');
  assert.match((await get(expert, `/employees/${expert.id}/setup`)).text, /Confirmed by the employee/);
  // B. management verification: the employee's confirmation alone does not count
  assert.equal((await confirm(expert, checked)).status, 302);
  assert.equal((await state(checked)).status, 'IN_PROGRESS');
  let page = await get(expert, `/employees/${expert.id}/setup`);
  assert.match(page.text, /awaiting verification/); assert.match(page.text, /Withdraw my confirmation/);
  assert.notEqual((await percentText(expert, expert))[1], '100');
  await confirm(expert, checked, { undo: '1' });
  assert.equal((await state(checked)).status, 'NOT_SET_UP');
  await confirm(expert, checked);
  assert.equal((await post(expert, `/employees/${expert.id}/setup/${checked.id}`, { status: 'COMPLETED' })).status, 403); // cannot self-verify
  assert.equal((await post(sup, `/employees/${expert.id}/setup/${checked.id}`, { status: 'COMPLETED', note: 'seen' })).status, 302);
  const verified = await state(checked);
  assert.equal(verified.status, 'COMPLETED'); assert.equal(verified.verifiedById, sup.id);
  assert.equal((await confirm(expert, checked, { undo: '1' })).status, 302); // employee cannot undo a management verification
  assert.equal((await state(checked)).status, 'COMPLETED');
  // C. management only: the employee cannot tick it at all
  assert.equal((await confirm(expert, only)).status, 403);
  assert.equal(await state(only), null);
  assert.match((await get(expert, `/employees/${expert.id}/setup`)).text, /Only your supervisor or an administrator can mark this as completed/);
  assert.equal((await post(sup, `/employees/${expert.id}/setup/${only.id}`, { status: 'COMPLETED' })).status, 302);
  assert.equal((await percentText(expert, expert))[1], '100');
  // nobody confirms on someone else's behalf; requirements that do not apply are invisible
  assert.equal((await post(sup, `/employees/${expert.id}/setup/${self.id}/confirm`)).status, 403);
  assert.equal((await post(admin, `/employees/${expert.id}/setup/${self.id}/confirm`)).status, 403);
  assert.ok(denied(await confirm(agentA, self)));
  // A COMPLETED row with no proof (forged directly in the database) is not counted under any rule
  await prisma.employeeSetupItem.deleteMany({ where: { profileId: expert.id, requirementId: only.id } });
  await prisma.employeeSetupItem.create({ data: { profileId: expert.id, requirementId: only.id, status: 'COMPLETED' } });
  assert.notEqual((await percentText(expert, expert))[1], '100');
});

test('edit, reorder, archive and restore: history survives and archived tools stop counting', async () => {
  const amadeus = await req('Amadeus');
  await post(admin, `/admin/setup-requirements/${amadeus.id}`, { label: 'Amadeus Selling', category: 'System Access', audience: 'ROLES', roles: ['TRAVEL_AGENT'], required: 'required', verification: 'MANAGEMENT_VERIFICATION', description: 'Updated' });
  assert.equal((await prisma.setupRequirement.findUnique({ where: { id: amadeus.id } })).label, 'Amadeus Selling');
  assert.equal((await get(admin, `/admin/setup-requirements/${amadeus.id}/edit`)).status, 200);

  // agentB completes it (management verified), then it is archived
  await post(sup, `/employees/${agentB.id}/setup/${amadeus.id}`, { status: 'COMPLETED' });
  assert.equal((await percentText(admin, agentB))[1], '100');
  const first = await prisma.setupRequirement.findFirst({ where: { organizationId: org.id, archivedAt: null }, orderBy: { displayOrder: 'asc' } });
  const second = await prisma.setupRequirement.findFirst({ where: { organizationId: org.id, archivedAt: null }, orderBy: { displayOrder: 'asc' }, skip: 1 });
  await post(admin, `/admin/setup-requirements/${first.id}/move`, { direction: 'down' });
  assert.ok((await prisma.setupRequirement.findUnique({ where: { id: first.id } })).displayOrder > (await prisma.setupRequirement.findUnique({ where: { id: second.id } })).displayOrder);
  await post(admin, `/admin/setup-requirements/${amadeus.id}`, { label: 'Amadeus Selling', category: 'System Access', audience: 'ROLES', roles: ['TRAVEL_AGENT'], required: 'required', verification: 'MANAGEMENT_VERIFICATION', position: '1' });
  assert.equal((await prisma.setupRequirement.findUnique({ where: { id: amadeus.id } })).displayOrder, 0); // display order editable

  await post(admin, `/admin/setup-requirements/${amadeus.id}/archive`);
  assert.ok((await prisma.setupRequirement.findUnique({ where: { id: amadeus.id } })).archivedAt);
  assert.equal(await prisma.employeeSetupItem.count({ where: { requirementId: amadeus.id } }), 1); // record kept
  assert.equal((await percentText(admin, agentA))[1], '100');                                       // no longer counts for the others
  const page = await get(admin, `/employees/${agentB.id}/setup`);
  assert.match(page.text, /Earlier requirements/); assert.match(page.text, /Amadeus Selling/);
  assert.match((await get(admin, '/admin/setup-requirements?view=archived')).text, /Amadeus Selling/);
  assert.doesNotMatch((await get(admin, '/admin/setup-requirements')).text, /Amadeus Selling/);

  await post(admin, `/admin/setup-requirements/${amadeus.id}/restore`);
  assert.equal((await prisma.setupRequirement.findUnique({ where: { id: amadeus.id } })).archivedAt, null);
  assert.equal((await percentText(admin, agentA))[1], '95');       // counts again
  assert.equal((await percentText(admin, agentB))[1], '100');      // and agentB's history is intact
});

test('a requirement can be assigned to specific employees and teams without touching everyone else', async () => {
  const res = await post(admin, '/admin/setup-requirements', { label: 'Special System', category: 'Other', audience: 'SPECIFIC', targetProfileIds: [agentA.id, expert.id], targetTeamIds: [team.id], required: 'required', verification: 'MANAGEMENT_VERIFICATION' });
  assert.equal(res.status, 302);
  const special = await req('Special System');
  assert.equal(await prisma.setupRequirementTarget.count({ where: { requirementId: special.id } }), 3);
  const shows = async (p) => /Special System/.test((await get(admin, `/employees/${p.id}/setup`)).text);
  assert.equal(await shows(agentA), true);   // named employee
  assert.equal(await shows(expert), true);   // named employee of another role
  assert.equal(await shows(agentC), true);   // member of the assigned team
  assert.equal(await shows(agentB), false);  // not assigned: untouched
  assert.equal(await shows(sup), false);
  // pure applicability
  assert.equal(requirementApplies(special, { role: 'TRAVEL_AGENT', id: agentB.id, teamIds: [] }, []), false);
  assert.equal(requirementApplies(special, { role: 'TRAVEL_AGENT', id: agentC.id, teamIds: [team.id] }, [{ requirementId: special.id, teamId: team.id }]), true);
  // assignees can be added on top of a role audience, and removed again
  await post(admin, `/admin/setup-requirements/${special.id}`, { label: 'Special System', category: 'Other', audience: 'SPECIFIC', targetProfileIds: [agentA.id], required: 'required', verification: 'MANAGEMENT_VERIFICATION' });
  assert.equal(await shows(expert), false); assert.equal(await shows(agentC), false); assert.equal(await shows(agentA), true);
  // ids from another organization (or made up) are never accepted
  const bad = await post(admin, '/admin/setup-requirements', { label: 'Leaky', category: 'Other', audience: 'SPECIFIC', targetProfileIds: [outsider.id], required: 'required' });
  assert.equal(bad.status, 400); assert.equal(await req('Leaky'), null);
});

test('the form validates: roles required for a role audience, targets for a specific audience, custom categories allowed', async () => {
  assert.equal((await post(admin, '/admin/setup-requirements', { label: 'No roles', audience: 'ROLES', category: 'Other' })).status, 400);
  assert.equal((await post(admin, '/admin/setup-requirements', { label: 'X', audience: 'ALL_EMPLOYEES', category: 'Other' })).status, 400); // name too short
  assert.equal(await req('No roles'), null);
  const ok = await post(admin, '/admin/setup-requirements', { label: 'Cloud Phone', category: '__new', newCategory: 'Telephony', audience: 'ROLES', roles: ['SUPERVISOR', 'ADMIN'], required: 'required', verification: 'EMPLOYEE_CONFIRMATION' });
  assert.equal(ok.status, 302);
  const row = await req('Cloud Phone');
  assert.equal(row.category, 'Telephony'); assert.deepEqual(JSON.parse(row.rolesJson), ['SUPERVISOR', 'ADMIN']);
  assert.match((await get(admin, '/admin/setup-requirements/new')).text, /Telephony/); // new category is offered from then on
  const forged = await post(admin, '/admin/setup-requirements', { label: 'Weird', audience: 'ROLES', roles: ['NOT_A_ROLE', 'SUPERVISOR'], verification: 'NOPE', category: 'Other' });
  const weird = await req('Weird');
  assert.deepEqual(JSON.parse(weird.rolesJson), ['SUPERVISOR']); assert.equal(weird.verification, 'MANAGEMENT_VERIFICATION'); assert.equal(forged.status, 302);
});

test('supervisors, employees and other organizations cannot configure setup requirements (server-side)', async () => {
  const amadeus = await req('Amadeus Selling');
  const snapshot = JSON.stringify(await prisma.setupRequirement.findMany({ where: { organizationId: org.id }, orderBy: { key: 'asc' } }));
  const attempts = [
    ['get', '/admin/setup-requirements', {}], ['get', '/admin/setup-requirements/new', {}], ['get', `/admin/setup-requirements/${amadeus.id}/edit`, {}],
    ['post', '/admin/setup-requirements', { label: 'Sneaky', audience: 'ALL_EMPLOYEES', category: 'Other' }],
    ['post', `/admin/setup-requirements/${amadeus.id}`, { label: 'Hijacked', audience: 'ALL_EMPLOYEES', category: 'Other', required: 'optional' }],
    ['post', `/admin/setup-requirements/${amadeus.id}/archive`, {}], ['post', `/admin/setup-requirements/${amadeus.id}/restore`, {}],
    ['post', `/admin/setup-requirements/${amadeus.id}/move`, { direction: 'up' }],
    ['post', '/admin/policies', { 'leave.supervisorFinalApproval': '1' }],
  ];
  for (const who of [sup, agentA, expert]) {
    for (const [method, url, body] of attempts) {
      const res = method === 'get' ? await get(who, url) : await post(who, url, body);
      assert.ok(denied(res), `${who.fullName} ${method} ${url} -> ${res.status}`);
    }
  }
  // An Admin of another organization only ever reaches their own org: our requirement IDs look like missing records
  assert.doesNotMatch((await get(outsider, '/admin/setup-requirements')).text, /Amadeus/);
  for (const [method, url, body] of attempts.filter(([, u]) => u.includes(amadeus.id))) {
    const res = method === 'get' ? await get(outsider, url) : await post(outsider, url, body);
    assert.equal(res.status, 404, `outsider ${method} ${url}`);
  }
  assert.equal(JSON.stringify(await prisma.setupRequirement.findMany({ where: { organizationId: org.id }, orderBy: { key: 'asc' } })), snapshot); // nothing changed
  // A supervisor can still see and verify their team's applicable requirements
  assert.equal((await get(sup, `/employees/${agentA.id}/setup`)).status, 200);
  assert.match((await get(sup, `/employees/${agentA.id}/setup`)).text, /Amadeus Selling/);
  // computeSetup keeps Not Activated employees out of "Setup Required" even when items are missing
  const r = computeSetup({ profile: { role: 'TRAVEL_AGENT', status: 'INVITED', id: 'x' }, requirements: [{ id: 'a', key: 'a', audience: 'ALL_EMPLOYEES', required: true, kind: 'MANUAL', archivedAt: null }], items: [], vaultSystemKeys: [], hasAddress: false });
  assert.equal(r.notStarted, true); assert.equal(r.label, 'Setup Not Started'); assert.equal(r.missingKeys.length, 0);
});

test('every configuration change is audited with actor, requirement and old/new values, and no secrets', async () => {
  const amadeus = await req('Amadeus Selling');
  const created = await audits('setup.requirement_created');
  assert.ok(created.length >= 5); assert.ok(created.every((a) => a.actorId === admin.id && a.targetTable === 'SetupRequirement'));
  const updated = (await audits('setup.requirement_updated', amadeus.id))[0];
  const meta = JSON.parse(updated.metadataJson);
  assert.deepEqual(meta.changes.label, { from: 'Amadeus', to: 'Amadeus Selling' }); assert.ok(updated.createdAt);
  await post(admin, `/admin/setup-requirements/${amadeus.id}`, { label: 'Amadeus Selling', category: 'System Access', audience: 'ROLES', roles: ['TRAVEL_AGENT', 'FLIGHT_EXPERT'], required: 'required', verification: 'MANAGEMENT_ONLY' });
  const roles = JSON.parse((await audits('setup.requirement_roles_changed', amadeus.id)).at(-1).metadataJson);
  assert.deepEqual(roles.from.roles, ['TRAVEL_AGENT']); assert.deepEqual(roles.to.roles, ['TRAVEL_AGENT', 'FLIGHT_EXPERT']);
  const verification = JSON.parse((await audits('setup.requirement_verification_changed', amadeus.id)).at(-1).metadataJson);
  assert.deepEqual([verification.from, verification.to], ['MANAGEMENT_VERIFICATION', 'MANAGEMENT_ONLY']);
  for (const action of ['setup.requirement_archived', 'setup.requirement_restored', 'setup.requirement_reordered']) assert.ok((await audits(action)).length >= 1, action);
  const special = await req('Special System');
  const assigned = await audits('setup.requirement_assigned', special.id);
  assert.ok(assigned.length >= 2); assert.ok(JSON.parse(assigned[0].metadataJson).addedEmployees.includes(agentA.id));
  assert.ok(!JSON.stringify(await audits('setup.requirement_updated')).match(/password|secret/i));
});
