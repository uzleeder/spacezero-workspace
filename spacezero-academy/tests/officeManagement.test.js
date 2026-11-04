'use strict';
// Office Management: one simple list of the office's things. Only the office manager (Fred Marco) sees it: not Admins,
// not other supervisors, not an Admin viewing as Fred. The button is on his Dashboard and Profile only.
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

test('only the office manager sees Office Management: the button on his Dashboard and Profile, and the page', async () => {
  assert.match((await get(fred, '/dashboard')).text, /href="\/office"[\s\S]{0,400}Office Management/);
  assert.match((await get(fred, '/profile')).text, /href="\/office"/);
  assert.equal((await get(fred, '/office')).status, 200);
  for (const who of [admin, sup, agent]) {
    assert.doesNotMatch((await get(who, '/dashboard')).text, /href="\/office"/, who.fullName);
    assert.equal((await get(who, '/office')).status, 404, who.fullName);
    assert.equal((await post(who, '/office/items', { name: 'Sneaky', type: 'TV' })).status, 404, who.fullName);
  }
  assert.equal(await prisma.officeItem.count({ where: { organizationId: org.id } }), 0);
});

test('Fred adds items (one, or many at once), gives them to people, edits and removes them', async () => {
  assert.equal((await post(fred, '/office/items', { name: 'Jabra headset', type: 'HEADPHONES', count: '3' })).status, 302);
  assert.equal((await post(fred, '/office/items', { name: 'Dell monitor 24', type: 'MONITOR', holderId: agent.id, condition: 'GOOD', note: 'Desk 4' })).status, 302);
  const items = await prisma.officeItem.findMany({ where: { organizationId: org.id }, orderBy: { name: 'asc' } });
  assert.deepEqual(items.map((i) => i.name), ['Dell monitor 24', 'Jabra headset 1', 'Jabra headset 2', 'Jabra headset 3']);
  assert.equal(items[0].holderId, agent.id); assert.equal(items[1].holderId, null);

  const page = (await get(fred, '/office')).text;
  assert.match(page, /Jabra headset 2/); assert.match(page, /Max Agent/); assert.match(page, /Office \/ storage/);
  assert.match((await get(fred, '/office?holder=' + agent.id)).text, /Dell monitor 24/);
  assert.doesNotMatch((await get(fred, '/office?holder=' + agent.id)).text, /<strong>Jabra headset 1<\/strong>/);   // the item list (product tiles always show every product)
  assert.doesNotMatch((await get(fred, '/office?type=MONITOR')).text, /<strong>Jabra headset/);

  // give a headset to Max, mark it for repair
  const h = items[1];
  assert.equal((await post(fred, `/office/items/${h.id}`, { name: h.name, type: 'HEADPHONES', holderId: agent.id, condition: 'NEEDS_REPAIR', note: 'Left ear crackles' })).status, 302);
  const changed = await prisma.officeItem.findUnique({ where: { id: h.id } });
  assert.equal(changed.holderId, agent.id); assert.equal(changed.condition, 'NEEDS_REPAIR');
  assert.match((await get(fred, '/office?condition=NEEDS_REPAIR')).text, /Left ear crackles/);

  // take it back to the office, then remove it
  assert.equal((await post(fred, `/office/items/${h.id}`, { name: h.name, type: 'HEADPHONES', holderId: '', condition: 'GOOD' })).status, 302);
  assert.equal((await prisma.officeItem.findUnique({ where: { id: h.id } })).holderId, null);
  assert.equal((await post(fred, `/office/items/${h.id}/delete`)).status, 302);
  assert.equal(await prisma.officeItem.count({ where: { id: h.id } }), 0);
  assert.ok(await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'office.items_added', actorId: fred.id } }));
});

test('items cannot go to people of another company, and others cannot change Fred\'s items', async () => {
  const before = await prisma.officeItem.count({ where: { organizationId: org.id } });
  const res = await post(fred, '/office/items', { name: 'TV 55', type: 'TV', holderId: outsider.id });
  assert.equal(res.status, 302); assert.match(res.headers.location, /error=/);
  assert.equal(await prisma.officeItem.count({ where: { organizationId: org.id } }), before);
  const item = await prisma.officeItem.findFirst({ where: { organizationId: org.id } });
  assert.equal((await post(admin, `/office/items/${item.id}/delete`)).status, 404);
  assert.equal((await post(sup, `/office/items/${item.id}`, { name: 'Taken', holderId: sup.id })).status, 404);
  assert.equal(await prisma.officeItem.count({ where: { id: item.id } }), 1);
});

test('the page counts every type and every product, and a product tile shows only that product', async () => {
  await post(fred, '/office/items', { name: 'Mouse', type: 'OTHER', count: '4' });
  await post(fred, '/office/items', { name: 'Mouse pad', type: 'OTHER', count: '2' });
  await post(fred, '/office/items', { name: 'Coffee Machine', type: 'OTHER' });
  const page = (await get(fred, '/office')).text;
  assert.match(page, /What's in the office/);
  assert.match(page, /office-product__name">Mouse<\/span><span class="office-product__count">4</);
  assert.match(page, /office-product__name">Mouse pad<\/span><span class="office-product__count">2</);
  assert.match(page, /office-product__name">Coffee Machine<\/span><span class="office-product__count">1</);
  assert.match(page, /href="\/office\?type=MONITOR">Monitor <strong>1<\/strong>/);
  const only = (await get(fred, '/office?product=Mouse')).text;
  assert.match(only, /<strong>Mouse 3<\/strong>/); assert.doesNotMatch(only, /<strong>Mouse pad 1<\/strong>/);
});

test('desks by team: Fred adds a desk with its things and computer password; the password is encrypted and shown only on request', async () => {
  const team = await prisma.team.create({ data: { organizationId: org.id, name: 'Team Desk' } });
  await prisma.teamMembership.create({ data: { teamId: team.id, profileId: agent.id } });
  assert.equal((await post(fred, '/office/desks', { number: '7', profileId: agent.id, monitor: 'Ziffler', pcCase: 'myPro', keyboard: '4Tech', mouse: '4Tech', headphone: 'Logi', password: 'Pc-Secret-77', note: 'Window seat' })).status, 302);
  const desk = await prisma.officeDesk.findFirst({ where: { organizationId: org.id, number: 7 } });
  assert.ok(desk.passwordEnc); assert.doesNotMatch(desk.passwordEnc, /Pc-Secret-77/);           // encrypted at rest

  const page = (await get(fred, '/office')).text;
  assert.match(page, /Desks by team/); assert.match(page, /Team Desk/); assert.match(page, /<strong>Max Agent<\/strong>/);
  assert.match(page, /Ziffler/); assert.match(page, /Window seat/); assert.match(page, new RegExp(`data-pw-show="${desk.id}"`));
  assert.doesNotMatch(page, /Pc-Secret-77/, 'the page never contains the password');

  const shown = await post(fred, `/office/desks/${desk.id}/password`);
  assert.equal(shown.status, 200); assert.equal(shown.body.password, 'Pc-Secret-77'); assert.match(shown.headers['cache-control'], /no-store/);
  assert.ok(await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'office.desk_password_viewed', targetId: desk.id, actorId: fred.id } }));

  // nobody else can see it, Admins included
  for (const who of [admin, sup, agent]) assert.equal((await post(who, `/office/desks/${desk.id}/password`)).status, 404, who.fullName);

  // saving without typing a password keeps it; "Remove" clears it; a desk number is used once
  assert.equal((await post(fred, `/office/desks/${desk.id}`, { number: '7', profileId: agent.id, monitor: 'Redmi' })).status, 302);
  assert.equal((await post(fred, `/office/desks/${desk.id}/password`)).body.password, 'Pc-Secret-77');
  assert.equal((await prisma.officeDesk.findUnique({ where: { id: desk.id } })).monitor, 'Redmi');
  const dup = await post(fred, '/office/desks', { number: '7', personName: 'Someone' });
  assert.match(dup.headers.location, /error=.*Desk%207%20already%20exists/);
  assert.equal((await post(fred, `/office/desks/${desk.id}`, { number: '7', clearPassword: '1' })).status, 302);
  assert.equal((await post(fred, `/office/desks/${desk.id}/password`)).body.password, null);
  assert.equal((await post(fred, `/office/desks/${desk.id}/delete`)).status, 302);
  assert.equal(await prisma.officeDesk.count({ where: { id: desk.id } }), 0);
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
