'use strict';
// Task 3 — Admin Configuration + Permissions. Task 4 — merge it into ONE Settings page
// (General / Security / Advanced) with a single sidebar entry. "Admin + System Configuration
// Access" is a capability, never a role name; nothing here is hard-coded by name — the real Above9
// directory's Ali/Tom/Joe end up with it only because they are, right now, this organization's only
// ADMIN profiles at the moment of the one-time bootstrap (see lib/supervisorCapabilities.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { hashPassword } = require('../lib/password');
const app = require('../server');

let org, admin, admin2, supervisor, agent, expert, cookies = {};
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);
const denied = (res) => [403, 404].includes(res.status);

async function makeUser(role, name) {
  const passwordHash = await hashPassword('Correct-Horse-9!');
  const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `AC ${name}`, username: `ac_${org.id}_${name}`, email: `ac_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', passwordHash, employmentStartDate: new Date() } });
  const token = generateToken();
  await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
  cookies[p.id] = `sz_session=${token.raw}`;
  return p;
}

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Admin Configuration tests' } });
  admin = await makeUser('ADMIN', 'admin');
  admin2 = await makeUser('ADMIN', 'admin2');
  supervisor = await makeUser('SUPERVISOR', 'sup');
  agent = await makeUser('TRAVEL_AGENT', 'agent');
  expert = await makeUser('FLIGHT_EXPERT', 'expert');
});
after(async () => { await prisma.$disconnect(); });

test('BOOTSTRAP: the first Admin request seeds System Configuration Access for every ACTIVE Admin, once', async () => {
  assert.equal(await prisma.supervisorCapability.count({ where: { organizationId: org.id, key: 'system.config_access' } }), 0);
  const res = await get(admin, '/admin/settings');
  assert.equal(res.status, 200);
  // both admins in the org were seeded — not just the one who happened to visit first
  const rows = await prisma.supervisorCapability.findMany({ where: { organizationId: org.id, key: 'system.config_access' } });
  assert.deepEqual(new Set(rows.map((r) => r.supervisorId)), new Set([admin.id, admin2.id]));
});

test('REVOKE THEN RE-BOOTSTRAP NEVER HAPPENS: once an org has any decision, the lazy seed never runs again', async () => {
  await post(admin, `/admin/configuration/system-access/${admin2.id}`, { access: '0' });
  assert.equal(await prisma.supervisorCapability.count({ where: { organizationId: org.id, key: 'system.config_access', supervisorId: admin2.id } }), 0);
  await get(admin, '/admin/settings'); // visiting again must not silently re-grant admin2
  assert.equal(await prisma.supervisorCapability.count({ where: { organizationId: org.id, key: 'system.config_access', supervisorId: admin2.id } }), 0);
  // restore for later tests
  await post(admin, `/admin/configuration/system-access/${admin2.id}`, { access: '1' });
});

test('ADMIN WITHOUT SYSTEM CONFIGURATION ACCESS: daily Admin work still works, Advanced tab hidden, direct URL denied', async () => {
  await post(admin, `/admin/configuration/system-access/${admin2.id}`, { access: '0' });
  // daily admin functionality: unaffected
  assert.equal((await get(admin2, '/admin/employees')).status, 200);
  assert.equal((await get(admin2, '/admin/employees/new')).status, 200);
  assert.equal((await get(admin2, '/dashboard')).status, 200);
  assert.equal((await get(admin2, `/admin/employees/${agent.id}`)).status, 200);
  // Settings itself still works (General/Security are everyday, ungated) — but no Advanced tab
  const settings = await get(admin2, '/admin/settings');
  assert.equal(settings.status, 200);
  assert.doesNotMatch(settings.text, /href="\/admin\/settings\?tab=advanced"/);
  assert.doesNotMatch(settings.text, />Advanced</);
  // requesting the advanced tab explicitly still renders (just silently falls back to General —
  // no protected data is ever fetched for an unauthorized visitor)
  const viaQuery = await get(admin2, '/admin/settings?tab=advanced');
  assert.equal(viaQuery.status, 200);
  assert.doesNotMatch(viaQuery.text, /Setup Requirements/);
  // every advanced route denies direct URL access, not just the hub
  for (const url of ['/admin/configuration', '/admin/configuration/system-access', '/admin/setup-requirements', '/admin/policies', '/admin/supervisor-permissions', '/admin/standards', '/admin/skills', '/admin/development', '/admin/certifications', '/admin/audit-logs', '/admin/analytics']) {
    assert.ok(denied(await get(admin2, url)), `GET ${url} should deny an Admin without System Configuration Access`);
  }
  assert.ok(denied(await post(admin2, '/admin/setup-requirements', { label: 'Sneaky' })));
  assert.ok(denied(await post(admin2, `/admin/configuration/system-access/${admin2.id}`, { access: '1' })), 'cannot self-grant by direct POST either');
  await post(admin, `/admin/configuration/system-access/${admin2.id}`, { access: '1' }); // restore
});

test('ADMIN WITH SYSTEM CONFIGURATION ACCESS: the Advanced tab is visible and works; old /admin/configuration redirects into it', async () => {
  const settings = await get(admin, '/admin/settings');
  assert.match(settings.text, /href="\/admin\/settings\?tab=advanced"/);

  const redirected = await get(admin, '/admin/configuration');
  assert.equal(redirected.status, 302);
  assert.equal(redirected.headers.location, '/admin/settings?tab=advanced');

  const hub = await get(admin, '/admin/settings?tab=advanced');
  assert.equal(hub.status, 200);
  for (const section of ['People &amp; Access', 'Training &amp; Development', 'Company Governance']) {
    assert.match(hub.text, new RegExp(section));
  }
  assert.match(hub.text, /Setup Requirements/);
  assert.match(hub.text, /Supervisor Permissions/);
  assert.match(hub.text, /System Access/);
  assert.match(hub.text, /Configure how SpaceZero works across your organization/);
});

test('Advanced destinations render working return navigation', async () => {
  const { SECTIONS } = require('../lib/adminConfigurationSections');
  for (const section of SECTIONS) {
    for (const link of section.links) {
      const page = await get(admin, link.href);
      assert.equal(page.status, 200, link.href);
      assert.match(page.text, /href="\/admin\/settings">Settings<\/a>/, link.href);
      assert.match(page.text, /advanced-back-link/, link.href);
    }
  }
});

test('General validation preserves entered values and does not create an invalid skill', async () => {
  const beforeCount = await prisma.skill.count({ where: { organizationId: org.id } });
  const res = await post(admin, '/admin/settings/skills', { name: 'Retain this name', roleKey: 'INVALID', category: 'Retain this category' });
  assert.equal(res.status, 400);
  assert.match(res.text, /Your changes have not been saved/);
  assert.match(res.text, /value="Retain this name"/);
  assert.match(res.text, /value="Retain this category"/);
  assert.equal(await prisma.skill.count({ where: { organizationId: org.id } }), beforeCount);
});

test('an invalid Tenure Band submission re-renders the real Development page (not a missing template) and creates nothing', async () => {
  const beforeCount = await prisma.tenureBand.count({ where: { organizationId: org.id } });
  const res = await post(admin, '/admin/settings/tenure-bands', { label: '', minMonths: 'not-a-number' });
  assert.equal(res.status, 400);
  assert.match(res.text, /Your changes have not been saved/);
  assert.match(res.text, /Employee Development Automation/); // the real Development page, not a broken template
  assert.equal(await prisma.tenureBand.count({ where: { organizationId: org.id } }), beforeCount);
});

test('General has no duplicate catalogs and moved configuration endpoints require Advanced access', async () => {
  const general = await get(admin, '/admin/settings');
  assert.doesNotMatch(general.text, /action="\/admin\/settings\/(skills|tenure-bands)"/);
  assert.equal((await get(admin, '/admin/development')).status, 200);
  assert.equal((await get(admin, '/admin/skills')).status, 200);
  await post(admin, `/admin/configuration/system-access/${admin2.id}`, { access: '0' });
  for (const endpoint of ['/admin/settings/tenure-bands', '/admin/settings/skills', '/admin/settings/skills/missing/deactivate', '/admin/settings/tenure-bands/missing/delete']) {
    assert.ok(denied(await post(admin2, endpoint, {})), endpoint);
  }
  await post(admin, `/admin/configuration/system-access/${admin2.id}`, { access: '1' });
});

test('PERSON-LEVEL MANAGEMENT stays reachable from the Supervisor profile without System Configuration Access', async () => {
  await post(admin, `/admin/configuration/system-access/${admin2.id}`, { access: '0' });
  // the global list (under Advanced) is denied...
  assert.ok(denied(await get(admin2, '/admin/supervisor-permissions')));
  // ...but granting THIS ONE supervisor, reached from their own Employees & Teams profile, is not
  const profilePage = await get(admin2, `/admin/employees/${supervisor.id}`);
  assert.equal(profilePage.status, 200);
  assert.match(profilePage.text, /Management access|Manage permissions/);
  const grant = await post(admin2, `/admin/supervisor-permissions/${supervisor.id}`, { capabilities: ['training.assign'] });
  assert.equal(grant.status, 302);
  const keys = await prisma.supervisorCapability.findMany({ where: { supervisorId: supervisor.id } });
  assert.ok(keys.some((k) => k.key === 'training.assign'));
  await post(admin, `/admin/configuration/system-access/${admin2.id}`, { access: '1' }); // restore
});

test('SUPERVISOR / AGENT / FLIGHT EXPERT: no Settings at all, cannot reach Advanced, cannot grant, cannot self-grant', async () => {
  for (const who of [supervisor, agent, expert]) {
    assert.ok(denied(await get(who, '/admin/settings')));
    assert.ok(denied(await get(who, '/admin/configuration')));
    assert.ok(denied(await get(who, '/admin/configuration/system-access')));
    assert.ok(denied(await post(who, `/admin/configuration/system-access/${who.id}`, { access: '1' })));
    assert.doesNotMatch((await get(who, '/dashboard')).text, />Settings</);
  }
});

test('AUDIT: granting and revoking System Configuration Access is recorded with actor, target and timestamp, never a secret', async () => {
  await prisma.auditLog.deleteMany({ where: { organizationId: org.id, targetId: admin2.id, action: { in: ['admin.system_config_access_granted', 'admin.system_config_access_revoked'] } } });
  await post(admin, `/admin/configuration/system-access/${admin2.id}`, { access: '0' });
  const revoked = await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'admin.system_config_access_revoked', targetId: admin2.id } });
  assert.ok(revoked);
  assert.equal(revoked.actorId, admin.id);
  assert.ok(revoked.createdAt);
  await post(admin, `/admin/configuration/system-access/${admin2.id}`, { access: '1' });
  const granted = await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'admin.system_config_access_granted', targetId: admin2.id } });
  assert.ok(granted);
  const dump = JSON.stringify([revoked, granted]);
  assert.doesNotMatch(dump, /passwordHash|payloadEnc/);
});

test('NAVIGATION: Company Standards & Workflow, SpaceZero AI, Settings are in that order, after Management — ONE Settings entry, no separate Advanced item', async () => {
  const { navForRole } = require('../lib/nav');
  const labels = navForRole('ADMIN').flatMap((s) => s.items.map((i) => i.label));
  assert.deepEqual(labels.filter((l) => /settings/i.test(l)), ['Settings']); // exactly one, plain "Settings"
  assert.ok(!labels.includes('Settings & Security'));
  assert.ok(!labels.includes('Admin Configuration'));
  const iStandards = labels.indexOf('Company Standards & Workflow');
  const iAssistant = labels.indexOf('SpaceZero AI');
  const iSettings = labels.indexOf('Settings');
  const iTraining = labels.indexOf('Training');
  assert.ok(iTraining < iStandards && iStandards < iAssistant && iAssistant < iSettings, labels.join(' > '));
});

test('ALI AHMED, TOM ALLEN, JOE GODWIN: the current real Manager/Admin accounts each end up with System Configuration Access, without being named in any authorization check', async () => {
  // Confirmed separately (tests/finalPhase1.test.js) that applyDirectory() creates exactly these
  // three people as ADMIN in the real Above9 organization — not re-run here, since Profile.email is
  // globally unique and that test already claims the real above9.travel addresses. This test proves
  // the other half: whoever IS an org's ACTIVE Admin at bootstrap time (here, people with those
  // three real names) gets System Configuration Access — the check itself never mentions a name.
  const dirOrg = await prisma.organization.create({ data: { name: 'AC real-managers tests' } });
  const pw = await hashPassword('Correct-Horse-9!');
  const names = ['Ali Ahmed', 'Tom Allen', 'Joe Godwin'];
  const people = [];
  for (const fullName of names) {
    people.push(await prisma.profile.create({ data: { organizationId: dirOrg.id, fullName, username: `ac_real_${dirOrg.id}_${fullName.replace(/\s+/g, '').toLowerCase()}`, email: `ac_real_${dirOrg.id}_${fullName.replace(/\s+/g, '').toLowerCase()}@example.invalid`, role: 'ADMIN', status: 'ACTIVE', passwordHash: pw, employmentStartDate: new Date() } }));
  }
  const ali = people[0];
  const token = generateToken();
  await prisma.session.create({ data: { profileId: ali.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
  const cookie = `sz_session=${token.raw}`;
  const res = await request(app).get('/admin/settings').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /href="\/admin\/settings\?tab=advanced"/); // Admin works, Advanced visible
  const advanced = await request(app).get('/admin/settings?tab=advanced').set('Cookie', cookie);
  assert.match(advanced.text, /Setup Requirements/); // Configuration works

  const grants = await prisma.supervisorCapability.findMany({ where: { organizationId: dirOrg.id, key: 'system.config_access' } });
  assert.deepEqual(new Set(grants.map((g) => g.supervisorId)), new Set(people.map((p) => p.id)));
});
