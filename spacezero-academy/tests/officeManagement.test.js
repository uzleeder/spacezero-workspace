'use strict';
// Office Management: Overview, Assets, Desks, Repairs, Activity. Only the office manager (Fred Marco) reaches any of it:
// not Admins, not other supervisors, not an Admin viewing as Fred. Plus My PC on each person's own Setup/profile.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const app = require('../server');

let org, other, fred, admin, sup, agent, outsider;
const cookies = {};
async function person(organizationId, role, name, extra = {}) {
  const p = await prisma.profile.create({ data: { organizationId, fullName: name, username: `om_${organizationId}_${name.replace(/\s+/g, '_')}`, email: `om_${organizationId}_${name.replace(/\s+/g, '_')}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date(), ...extra } });
  const t = generateToken();
  await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } });
  cookies[p.id] = `sz_session=${t.raw}`;
  return p;
}
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Office tests' } });
  other = await prisma.organization.create({ data: { name: 'Office tests foreign' } });
  fred = await person(org.id, 'SUPERVISOR', 'Fred Office', { officeManager: true });
  admin = await person(org.id, 'ADMIN', 'Office Admin');
  sup = await person(org.id, 'SUPERVISOR', 'Other Supervisor');
  agent = await person(org.id, 'TRAVEL_AGENT', 'Max Agent');
  outsider = await person(other.id, 'TRAVEL_AGENT', 'Foreign Agent');
});
after(async () => { await prisma.$disconnect(); });

const itemByTag = (tag) => prisma.officeItem.findFirst({ where: { organizationId: org.id, assetTag: tag } });

test('only the office manager reaches Office Management: sidebar, Dashboard/Profile button, every page and change', async () => {
  assert.match((await get(fred, '/dashboard')).text, /href="\/office"[\s\S]{0,400}Office Management/);
  assert.match((await get(fred, '/dashboard')).text, /class="sidebar-link[^"]*" href="\/office" title="Office Management"/);
  assert.match((await get(fred, '/profile')).text, /href="\/office"/);
  for (const url of ['/office', '/office/assets', '/office/desks', '/office/repairs', '/office/activity']) assert.equal((await get(fred, url)).status, 200, url);
  for (const who of [admin, sup, agent]) {
    assert.doesNotMatch((await get(who, '/dashboard')).text, /href="\/office"/, who.fullName);
    for (const url of ['/office', '/office/assets', '/office/desks', '/office/repairs', '/office/activity']) assert.equal((await get(who, url)).status, 404, `${who.fullName} ${url}`);
    assert.equal((await post(who, '/office/assets', { name: 'Sneaky', type: 'TV' })).status, 404, who.fullName);
    assert.equal((await post(who, '/office/repairs', { itemId: 'x', issue: 'x' })).status, 404, who.fullName);
  }
  assert.equal(await prisma.officeItem.count({ where: { organizationId: org.id } }), 0);
});

test('an Admin viewing as the office manager gets none of Office Management', async () => {
  const viewingAs = `${cookies[fred.id]}; sz_admin_session=${cookies[admin.id].split('=')[1]}`;
  for (const url of ['/office', '/office/assets', '/office/desks']) assert.equal((await request(app).get(url).set('Cookie', viewingAs)).status, 404, url);
  assert.ok([403, 404].includes((await request(app).post('/office/assets').set('Cookie', viewingAs).type('form').send({ name: 'x' })).status));   // read-only while viewing as someone
  assert.doesNotMatch((await request(app).get('/dashboard').set('Cookie', viewingAs)).text, /href="\/office"/);
});
test('canManageOffice: office manager only, never while viewing as someone', () => {
  const { canManageOffice } = require('../lib/office');
  assert.equal(canManageOffice({ profile: { officeManager: true } }), true);
  assert.equal(canManageOffice({ profile: { officeManager: true }, impersonation: { adminId: 'a' } }), false);
  assert.equal(canManageOffice({ profile: { officeManager: false, role: 'ADMIN' } }), false);
});

test('adding: one asset, or several after a preview; every asset gets its own tag, never reused', async () => {
  const one = await post(fred, '/office/assets', { name: 'Dell monitor', model: 'Dell P2422H', type: 'MONITOR', location: 'Storage', verified: '1', back: '/office/assets' });
  assert.equal(one.status, 302);
  const first = await itemByTag('SZ-0001');
  assert.equal(first.name, 'Dell monitor'); assert.ok(first.verifiedAt); assert.equal(first.lifecycle, 'ACTIVE');
  // several: a preview first, nothing created yet
  const preview = await post(fred, '/office/assets', { name: 'Jabra headset', model: 'Jabra Evolve2 30', type: 'HEADPHONES', count: '12', location: 'Storage', back: '/office/assets' });
  assert.equal(preview.status, 200); assert.match(preview.text, /Check before adding 12 assets/); assert.match(preview.text, /SZ-0002<\/strong> to <strong>SZ-0013/);
  assert.equal(await prisma.officeItem.count({ where: { organizationId: org.id } }), 1);
  assert.equal((await post(fred, '/office/assets', { name: 'Jabra headset', model: 'Jabra Evolve2 30', type: 'HEADPHONES', count: '12', location: 'Storage', confirm: '1', back: '/office/assets' })).status, 302);
  assert.equal(await prisma.officeItem.count({ where: { organizationId: org.id } }), 13);
  // a bounded batch
  assert.equal((await post(fred, '/office/assets', { name: 'Too many', count: '500', back: '/office/assets' })).status, 400);
  // retiring keeps the record, and its tag is never handed out again
  const last = await itemByTag('SZ-0013');
  await post(fred, `/office/assets/${last.id}/retire`, { version: String(last.version), reason: 'Lost', back: '/office/assets' });
  await post(fred, '/office/assets', { name: 'Logitech mouse', type: 'MOUSE', location: 'Storage', back: '/office/assets' });
  assert.ok(await itemByTag('SZ-0014'));
  assert.equal((await itemByTag('SZ-0013')).lifecycle, 'RETIRED');
});

test('the list: natural order, search, combined filters, pages of 25/50/100, and the filters survive a save', async () => {
  const page1 = (await get(fred, '/office/assets?category=HEADPHONES&sort=name')).text;
  const names = [...page1.matchAll(/<td data-label="Item"><strong>([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(names.slice(0, 3), ['Jabra headset 1', 'Jabra headset 2', 'Jabra headset 3'], 'natural order: 2 before 10');
  assert.match(page1, /<strong>11<\/strong> results/);                                    // 12 headsets, one retired
  assert.match((await get(fred, '/office/assets?q=Evolve2&view=retired')).text, /<strong>1<\/strong> result /);
  const small = (await get(fred, '/office/assets?per=25')).text;
  assert.match(small, /<option value="25" selected>/); assert.match(small, /<option value="50">/); assert.match(small, /<option value="100">/);
  assert.equal((await get(fred, '/office/assets?per=7')).text.match(/<option value="25" selected>/) !== null, true, 'unknown sizes fall back to 25');
  // a validation error keeps what was typed; a save returns to the same filtered list
  const item = await itemByTag('SZ-0002');
  const bad = await post(fred, `/office/assets/${item.id}`, { version: String(item.version), name: '', model: 'Kept model text', back: '/office/assets?category=HEADPHONES&page=1' });
  assert.equal(bad.status, 400); assert.match(bad.text, /Write the name of the asset/); assert.match(bad.text, /value="Kept model text"/);
  const ok = await post(fred, `/office/assets/${item.id}`, { version: String(item.version), name: 'Jabra headset 2', model: 'Jabra Evolve2 30', type: 'HEADPHONES', condition: 'GOOD', location: 'Shelf B', back: '/office/assets?category=HEADPHONES&sort=name' });
  assert.equal(ok.status, 302); assert.match(ok.headers.location, /^\/office\/assets\?category=HEADPHONES&sort=name&notice=.*&asset=/);
});

test('metrics match their lists: "needs repair or broken" counts and lists both; unassigned is not available', async () => {
  const a = await itemByTag('SZ-0003'); const b = await itemByTag('SZ-0004');
  await post(fred, `/office/assets/${a.id}`, { version: String(a.version), name: a.name, model: a.model, type: a.type, condition: 'NEEDS_REPAIR', location: 'Storage', back: '/office/assets' });
  await post(fred, `/office/assets/${b.id}`, { version: String(b.version), name: b.name, model: b.model, type: b.type, condition: 'BROKEN', location: 'Storage', back: '/office/assets' });
  const ov = (await get(fred, '/office')).text;
  const metric = (k) => Number(new RegExp(`href="/office/assets\\?view=${k}">\\s*<span class="o-metric__label">[^<]*</span>\\s*<span class="o-metric__value">(\\d+)<`).exec(ov)[1]);
  const listed = async (k) => Number(/<strong>(\d+)<\/strong> result/.exec((await get(fred, `/office/assets?view=${k}&per=100`)).text)[1]);
  for (const k of ['all', 'assigned', 'unassigned', 'available', 'attention', 'repair', 'review', 'retired']) assert.equal(metric(k), await listed(k), k);
  assert.equal(metric('attention'), 2, 'Needs repair AND Broken');
  const attention = (await get(fred, '/office/assets?view=attention')).text;
  assert.match(attention, /Needs repair<\/span>/); assert.match(attention, /Broken<\/span>/);
  // not physically checked = unassigned but not "available"
  assert.ok(metric('unassigned') > metric('available'));
});

test('custody: give, transfer, place at a desk, return - one holder at a time, only Good in-service assets, with history', async () => {
  const item = await itemByTag('SZ-0001');                 // Good, checked, in storage
  let r = await post(fred, `/office/assets/${item.id}/custody`, { mode: 'person', holderId: agent.id, version: String(item.version), back: '/office/assets' });
  assert.equal(r.status, 302);
  let now = await itemByTag('SZ-0001');
  assert.equal(now.holderId, agent.id);
  // a stale form (old version) is refused, nothing is overwritten
  const stale = await post(fred, `/office/assets/${item.id}/custody`, { mode: 'person', holderId: sup.id, version: String(item.version), back: '/office/assets' });
  assert.equal(stale.status, 409); assert.match(stale.text, /Someone else changed this record/);
  assert.equal((await itemByTag('SZ-0001')).holderId, agent.id);
  // transfer to a desk: the person no longer has it (never both)
  assert.equal((await post(fred, '/office/desks', { number: '5', profileId: sup.id, back: '/office/desks' })).status, 302);
  const desk = await prisma.officeDesk.findFirst({ where: { organizationId: org.id, number: 5 } });
  await post(fred, `/office/assets/${item.id}/custody`, { mode: 'desk', deskId: desk.id, version: String(now.version), back: '/office/assets' });
  now = await itemByTag('SZ-0001');
  assert.equal(now.deskId, desk.id); assert.equal(now.holderId, null); assert.equal(now.location, 'Desk 5');
  // another company's person or desk is refused
  const foreignDesk = await prisma.officeDesk.create({ data: { organizationId: other.id, number: 99 } });
  for (const body of [{ mode: 'person', holderId: outsider.id }, { mode: 'desk', deskId: foreignDesk.id }]) {
    const x = await post(fred, `/office/assets/${item.id}/custody`, { ...body, version: String(now.version), back: '/office/assets' });
    assert.equal(x.status, 400);
  }
  // broken equipment cannot be given out
  const broken = await itemByTag('SZ-0004');
  const no = await post(fred, `/office/assets/${broken.id}/custody`, { mode: 'person', holderId: agent.id, version: String(broken.version), back: '/office/assets' });
  assert.equal(no.status, 400); assert.match(no.text, /cannot be given out until it is Good/);
  // return
  await post(fred, `/office/assets/${item.id}/custody`, { mode: 'return', location: 'Storage', version: String(now.version), back: '/office/assets' });
  now = await itemByTag('SZ-0001');
  assert.equal(now.deskId, null); assert.equal(now.location, 'Storage');
  const history = await prisma.officeActivity.findMany({ where: { itemId: item.id }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(history.map((h) => h.action), ['CREATED', 'ASSIGNED', 'TRANSFERRED', 'RETURNED']);
  assert.ok(history.every((h) => h.actorId === fred.id));
});

test('desks: linked equipment and readiness; a new occupant does not inherit the saved password unless kept', async () => {
  const desk = await prisma.officeDesk.findFirst({ where: { organizationId: org.id, number: 5 } });
  assert.equal((await post(fred, `/office/desks/${desk.id}`, { number: '5', profileId: sup.id, password: 'Desk5-pw', version: String(desk.version), back: '/office/desks' })).status, 302);
  const d1 = await prisma.officeDesk.findUnique({ where: { id: desk.id } });
  assert.ok(d1.passwordEnc); assert.doesNotMatch(d1.passwordEnc, /Desk5-pw/);
  // link a computer, a monitor and headphones -> ready
  const mk = async (name, type) => { await post(fred, '/office/assets', { name, type, location: 'Storage', back: '/office/assets' }); return prisma.officeItem.findFirst({ where: { organizationId: org.id, name } }); };
  for (const [name, type] of [['PC tower', 'CASE'], ['Desk monitor', 'MONITOR'], ['Desk headset', 'HEADPHONES']]) {
    const it = await mk(name, type);
    assert.equal((await post(fred, `/office/desks/${desk.id}/link`, { pick: `${it.id}:${it.version}`, back: '/office/desks' })).status, 302);
  }
  const page = (await get(fred, `/office/desks?desk=${desk.id}`)).text;
  assert.match(page, /<span class="o-tag o-tag--ok">Ready<\/span>/); assert.match(page, /PC tower/);
  assert.doesNotMatch(page, /Desk5-pw/, 'the page never contains the password');
  assert.equal((await post(fred, `/office/desks/${desk.id}/password`)).body.password, 'Desk5-pw');
  for (const who of [admin, sup, agent]) assert.equal((await post(who, `/office/desks/${desk.id}/password`)).status, 404);
  // someone else sits there now: the old password is removed (not kept by accident); equipment stays with the desk
  const d2 = await prisma.officeDesk.findUnique({ where: { id: desk.id } });
  assert.equal((await post(fred, `/office/desks/${desk.id}`, { number: '5', profileId: admin.id, version: String(d2.version), back: '/office/desks' })).status, 302);
  const d3 = await prisma.officeDesk.findUnique({ where: { id: desk.id }, include: { items: true } });
  assert.equal(d3.passwordEnc, null); assert.equal(d3.items.length, 3);
  // a desk with linked equipment cannot be removed
  const del = await post(fred, `/office/desks/${desk.id}/delete`, { back: '/office/desks' });
  assert.equal(del.status, 400); assert.match(del.text, /still has 3 linked assets/);
  // filters
  assert.match((await get(fred, '/office/desks?view=unoccupied')).text, /No desks match/);
});

test('repairs: open, move, resolve with an explicit result, reopen, cancel - with the asset kept in step', async () => {
  const item = await itemByTag('SZ-0005');
  const opened = await post(fred, '/office/repairs', { itemId: item.id, issue: 'Left ear cup crackles', priority: 'HIGH', condition: 'NEEDS_REPAIR', dueAt: '2026-11-08', back: '/office/repairs' });
  assert.equal(opened.status, 302);
  const repair = await prisma.officeRepair.findFirst({ where: { itemId: item.id } });
  let it = await itemByTag('SZ-0005');
  assert.equal(it.lifecycle, 'IN_REPAIR'); assert.equal(it.condition, 'NEEDS_REPAIR');
  assert.equal(repair.dueAt.toISOString(), '2026-11-08T18:59:00.000Z', 'due = end of the day in Tashkent');
  // a second open repair for the same asset is refused; an in-repair asset cannot be given out
  assert.equal((await post(fred, '/office/repairs', { itemId: item.id, issue: 'Again', back: '/office/repairs' })).status, 400);
  assert.equal((await post(fred, `/office/assets/${item.id}/custody`, { mode: 'person', holderId: agent.id, version: String(it.version), back: '/office/assets' })).status, 400);
  // allowed and refused moves
  assert.equal((await post(fred, `/office/repairs/${repair.id}`, { issue: repair.issue, status: 'WAITING', version: String(repair.version), back: '/office/repairs' })).status, 302);
  let rep = await prisma.officeRepair.findUnique({ where: { id: repair.id } });
  assert.equal(rep.status, 'WAITING');
  assert.equal((await post(fred, `/office/repairs/${repair.id}`, { issue: repair.issue, status: 'RESOLVED', version: String(rep.version), back: '/office/repairs' })).status, 400, 'resolving needs its own step with a result');
  // resolving needs the result stated
  assert.equal((await post(fred, `/office/repairs/${repair.id}/resolve`, { resolution: 'Replaced cable', version: String(rep.version), back: '/office/repairs' })).status, 400);
  assert.equal((await post(fred, `/office/repairs/${repair.id}/resolve`, { resolution: 'Replaced cable', resultingCondition: 'GOOD', resultingLifecycle: 'ACTIVE', version: String(rep.version), back: '/office/repairs' })).status, 302);
  it = await itemByTag('SZ-0005');
  assert.equal(it.lifecycle, 'ACTIVE'); assert.equal(it.condition, 'GOOD');
  // reopen -> in repair again; cancel -> back in service with its condition unchanged
  rep = await prisma.officeRepair.findUnique({ where: { id: repair.id } });
  assert.equal((await post(fred, `/office/repairs/${repair.id}/reopen`, { version: String(rep.version), back: '/office/repairs' })).status, 302);
  assert.equal((await itemByTag('SZ-0005')).lifecycle, 'IN_REPAIR');
  rep = await prisma.officeRepair.findUnique({ where: { id: repair.id } });
  assert.equal((await post(fred, `/office/repairs/${repair.id}/cancel`, { reason: 'Works fine after all', version: String(rep.version), back: '/office/repairs' })).status, 302);
  it = await itemByTag('SZ-0005');
  assert.equal(it.lifecycle, 'ACTIVE'); assert.equal(it.condition, 'GOOD');
  const actions = (await prisma.officeActivity.findMany({ where: { repairId: repair.id }, orderBy: { createdAt: 'asc' } })).map((a) => a.action);
  assert.deepEqual(actions, ['REPAIR_OPENED', 'REPAIR_UPDATED', 'REPAIR_RESOLVED', 'REPAIR_REOPENED', 'REPAIR_CANCELLED']);
  // overdue / due soon views
  const late = await itemByTag('SZ-0006');
  await post(fred, '/office/repairs', { itemId: late.id, issue: 'Mic dead', dueAt: '2020-01-01', back: '/office/repairs' });
  assert.match((await get(fred, '/office/repairs?view=overdue')).text, /Mic dead/);
  assert.match((await get(fred, '/office')).text, /Overdue <strong>1<\/strong>/);
});

test('activity is searchable and never holds a password; retire keeps the record and its history', async () => {
  const page = (await get(fred, '/office/activity?q=SZ-0001')).text;
  assert.match(page, /SZ-0001 Dell monitor added/); assert.match(page, /returned from desk 5 to Storage/);
  const all = await prisma.officeActivity.findMany({ where: { organizationId: org.id } });
  assert.ok(all.length > 10);
  assert.ok(all.every((a) => !/Desk5-pw|passwordEnc/.test(`${a.summary} ${a.beforeJson} ${a.afterJson}`)));
  const retired = await prisma.officeActivity.findFirst({ where: { organizationId: org.id, action: 'RETIRED' } });
  assert.match(retired.summary, /SZ-0013 retired: Lost/);
  assert.match((await get(fred, '/office/activity?action=RETIRED')).text, /SZ-0013 retired/);
});

test('backfill: tags, models and categories only from the handed-over list; everything else is marked for review', () => {
  const { execFileSync } = require('node:child_process');
  // legacy-shaped records in a separate organization
  return (async () => {
    const legacy = await prisma.organization.create({ data: { name: 'Office legacy' } });
    await prisma.officeItem.createMany({ data: [
      { organizationId: legacy.id, name: 'Mouse 10', type: 'OTHER' }, { organizationId: legacy.id, name: 'Mouse 2', type: 'OTHER' },
      { organizationId: legacy.id, name: 'Coffee Machine', type: 'OTHER' }, { organizationId: legacy.id, name: 'Unknown gadget', type: 'OTHER' },
    ] });
    const out = execFileSync(process.execPath, ['scripts/office-backfill.cjs'], { env: process.env, encoding: 'utf8' });
    assert.match(out, /Dry run: nothing changed/);
    assert.equal(await prisma.officeItem.count({ where: { organizationId: legacy.id, assetTag: { not: null } } }), 0);
    const applied = execFileSync(process.execPath, ['scripts/office-backfill.cjs', '--apply'], { env: process.env, encoding: 'utf8' });
    const rows = await prisma.officeItem.findMany({ where: { organizationId: legacy.id } });
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    assert.equal(by['Mouse 2'].model, 'Mouse'); assert.equal(by['Mouse 2'].type, 'MOUSE');
    assert.equal(by['Coffee Machine'].type, 'APPLIANCE');
    assert.equal(by['Unknown gadget'].model, null); assert.equal(by['Unknown gadget'].needsReview, true);
    assert.equal(new Set(rows.map((r) => r.assetTag)).size, 4);
    const file = /--revert (\S+)/.exec(applied)[1];
    execFileSync(process.execPath, ['scripts/office-backfill.cjs', '--revert', file], { env: process.env, encoding: 'utf8' });
    assert.equal(await prisma.officeItem.count({ where: { organizationId: legacy.id, assetTag: { not: null } } }), 0, 'revert puts the old values back');
    require('node:fs').unlinkSync(file);
  })();
});

test('"My PC" on the Setup page: each person sees their own PC number, monitor, headphone and password (on request), nobody else\'s', async () => {
  assert.equal((await post(fred, '/office/desks', { number: '12', profileId: agent.id, monitor: 'Redmi', headphone: 'Logi', pcCase: 'myPro', password: 'Agent-PC-12' })).status, 302);
  const own = (await get(agent, `/employees/${agent.id}/setup`)).text;
  assert.match(own, /<h2>My PC<\/h2>/); assert.match(own, /PC number<\/p><p class="v">12</); assert.match(own, /Redmi/); assert.match(own, /Logi/);
  assert.doesNotMatch(own, /Agent-PC-12/, 'the page never contains the password');
  const shown = await post(agent, '/my/desk/password');
  assert.equal(shown.status, 200); assert.equal(shown.body.password, 'Agent-PC-12');
  assert.ok(await prisma.auditLog.findFirst({ where: { action: 'office.own_desk_password_viewed', actorId: agent.id } }));
  // an Admin looking at the agent's Setup does not get "My PC"; someone without a desk gets nothing
  assert.doesNotMatch((await get(admin, `/employees/${agent.id}/setup`)).text, /<h2>My PC<\/h2>/);
  assert.equal((await post(sup, '/my/desk/password')).status, 404);
});

test('the PC card is on every profile: the owner can show their password, the office manager can, an Admin only sees the desk', async () => {
  const desk = await prisma.officeDesk.findFirst({ where: { organizationId: org.id, profileId: agent.id } });
  assert.ok(desk, 'desk from the previous test');
  const own = (await get(agent, '/profile')).text;
  assert.match(own, /<h2>My PC<\/h2>/); assert.match(own, /data-pc-show="\/my\/desk\/password"/); assert.doesNotMatch(own, /Agent-PC-12/);
  const byAdmin = (await get(admin, `/admin/employees/${agent.id}`)).text;
  assert.match(byAdmin, /<h2>PC<\/h2>/); assert.match(byAdmin, /PC number<\/p><p class="v">12</); assert.doesNotMatch(byAdmin, /data-pc-show/); assert.doesNotMatch(byAdmin, /PC password/);
  const byFred = (await get(fred, `/admin/employees/${agent.id}`));
  if (byFred.status === 200) assert.match(byFred.text, new RegExp(`data-pc-show="/office/desks/${desk.id}/password"`));
  const noDesk = (await get(sup, '/profile')).text;
  assert.match(noDesk, /<h2>My PC<\/h2>/); assert.match(noDesk, /No desk recorded yet\./);
});

test('Setup: the agent fills in My PC; their "PC" item is ticked once PC number, monitor, headphone and password are in', async () => {
  const { loadSetupForProfile, ensureDefaultRequirements } = require('../lib/employeeSetup');
  await ensureDefaultRequirements(org.id);
  const newbie = await person(org.id, 'TRAVEL_AGENT', 'Nora Newbie');
  const pcRow = async () => (await loadSetupForProfile(org.id, await prisma.profile.findUnique({ where: { id: newbie.id } }))).rows.find((r) => r.requirement.key === 'pc');

  const page = (await get(newbie, `/employees/${newbie.id}/setup`)).text;
  assert.match(page, /<h2>My PC<\/h2>/); assert.match(page, /Not filled in yet\. Fill in your PC below\./);
  assert.match(page, /<form method="post" action="\/my\/desk"/); assert.match(page, /href="#my-pc"[^>]*>Fill in My PC/);
  assert.equal((await pcRow()).status, 'NOT_SET_UP');

  // part of it: not ticked yet
  assert.equal((await post(newbie, '/my/desk', { number: '40', monitor: 'Ziffler' })).status, 302);
  assert.notEqual((await pcRow()).status, 'COMPLETED');
  // all of it: ticked (their own confirmation), and the password is encrypted and only on request
  const done = await post(newbie, '/my/desk', { number: '40', monitor: 'Ziffler', headphone: 'Logi', pcCase: 'myPro', password: 'Nora-PC-40' });
  assert.match(done.headers.location, /pc=saved#my-pc/);
  assert.equal((await pcRow()).status, 'COMPLETED'); assert.match((await pcRow()).item.note, /Filled in My PC/);
  const desk = await prisma.officeDesk.findFirst({ where: { organizationId: org.id, profileId: newbie.id } });
  assert.equal(desk.number, 40); assert.equal(desk.pcCase, 'myPro'); assert.doesNotMatch(desk.passwordEnc, /Nora-PC-40/);
  assert.equal((await post(newbie, '/my/desk/password')).body.password, 'Nora-PC-40');
  assert.doesNotMatch((await get(newbie, `/employees/${newbie.id}/setup`)).text, /Nora-PC-40/);
  // Fred sees it in Office Management
  assert.match((await get(fred, '/office/desks')).text, /Nora Newbie/);

  // saving again without a password keeps it
  assert.equal((await post(newbie, '/my/desk', { number: '40', monitor: 'Redmi', headphone: 'Logi' })).status, 302);
  assert.equal((await post(newbie, '/my/desk/password')).body.password, 'Nora-PC-40');
  // someone else's PC number is refused; a PC the office manager recorded without a person is claimed
  const taken = await post(newbie, '/my/desk', { number: '12', monitor: 'X', headphone: 'Y' });
  assert.match(decodeURIComponent(taken.headers.location), /PC 12 is recorded for Max Agent/);
  await post(fred, '/office/desks', { number: '41', monitor: 'Redmi 27', headphone: 'Logi', personName: 'Free desk' });
  assert.equal((await post(newbie, '/my/desk', { number: '41', monitor: '', headphone: '' })).status, 302);
  const claimed = await prisma.officeDesk.findFirst({ where: { organizationId: org.id, number: 41 } });
  assert.equal(claimed.profileId, newbie.id); assert.equal(claimed.monitor, 'Redmi 27', 'what the office manager recorded is kept');
  assert.equal((await prisma.officeDesk.findFirst({ where: { organizationId: org.id, number: 40 } })).profileId, null, 'the old desk is freed');
});
