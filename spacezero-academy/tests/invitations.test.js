'use strict';
// Activation: admin invites everyone pending in one action; links are one-time and never stored raw.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken, hashToken } = require('../lib/tokens');
const { hashPassword } = require('../lib/password');
const app = require('../server');

let org, otherOrg, cookies = {};
let admin, sup, outsider, ann, ben, archived, otherInvited;
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).set('Origin', process.env.APP_ORIGIN || 'http://localhost:3000').type('form').send(body);
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const denied = (res) => [403, 404].includes(res.status);

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Invite tests' } });
  otherOrg = await prisma.organization.create({ data: { name: 'Invite other org' } });
  const passwordHash = await hashPassword('Correct-Horse-9!');
  async function user(role, name, { status = 'ACTIVE', organizationId = org.id } = {}) {
    const p = await prisma.profile.create({ data: { organizationId, fullName: `IV ${name}`, username: `iv_${organizationId}_${name}`, email: `iv_${organizationId}_${name}@example.invalid`, role, status, passwordHash: status === 'ACTIVE' ? passwordHash : null, employmentStartDate: new Date() } });
    if (status === 'ACTIVE') {
      const token = generateToken();
      await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
      cookies[p.id] = `sz_session=${token.raw}`;
    }
    return p;
  }
  admin = await user('ADMIN', 'admin'); sup = await user('SUPERVISOR', 'sup'); outsider = await user('ADMIN', 'outsider', { organizationId: otherOrg.id });
  ann = await user('TRAVEL_AGENT', 'ann', { status: 'INVITED' }); ben = await user('FLIGHT_EXPERT', 'ben', { status: 'INVITED' });
  archived = await user('TRAVEL_AGENT', 'gone', { status: 'ARCHIVED' });
  otherInvited = await user('TRAVEL_AGENT', 'other', { status: 'INVITED', organizationId: otherOrg.id });
});
after(async () => { await prisma.$disconnect(); });

test('"Invite all pending" gives every not-yet-activated employee of this organization a one-time link when no mail server is configured', async () => {
  const list = await get(admin, '/admin/employees?setup=notstarted');
  assert.match(list.text, /Invite all pending \(2\)/); // ann + ben only: not the archived one, not another organization's
  const res = await post(admin, '/admin/employees/invite-pending');
  assert.equal(res.status, 200);
  assert.match(res.headers['cache-control'], /no-store/);
  assert.match(res.text, /nothing was emailed/); assert.match(res.text, /IV ann/); assert.match(res.text, /IV ben/);
  assert.doesNotMatch(res.text, /IV gone/); assert.doesNotMatch(res.text, /IV other/);
  const links = [...res.text.matchAll(/value="([^"]*\/accept-invite\/[^"]+)"/g)].map((m) => m[1]);
  assert.equal(links.length, 2);
  // only hashes are stored, never the raw token
  const stored = await prisma.invitation.findMany({ where: { profileId: { in: [ann.id, ben.id] } } });
  assert.equal(stored.length, 2);
  for (const link of links) { const raw = link.split('/accept-invite/')[1]; assert.ok(stored.some((s) => s.tokenHash === hashToken(raw) && s.status === 'PENDING')); assert.ok(!stored.some((s) => s.tokenHash === raw)); }
  assert.equal(await prisma.invitation.count({ where: { profileId: { in: [archived.id, otherInvited.id] } } }), 0);
  const audit = await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'employee.invites_issued' } });
  assert.deepEqual(JSON.parse(audit.metadataJson), { count: 2, mode: 'links' });
  assert.ok(!JSON.stringify(await prisma.auditLog.findMany({ where: { organizationId: org.id } })).includes(links[0].split('/accept-invite/')[1])); // the token is never audited

  // the link activates the account exactly once, and the employee chooses their own password
  const raw = links[0].split('/accept-invite/')[1];
  const page = await request(app).get(`/accept-invite/${raw}`);
  assert.equal(page.status, 200); assert.match(page.text, /Set a password/);
  const activate = await request(app).post(`/accept-invite/${raw}`).type('form').send({ password: 'Brand-New-Passw0rd!', confirmPassword: 'Brand-New-Passw0rd!' });
  assert.equal(activate.status, 302);
  const activated = await prisma.profile.findFirst({ where: { id: { in: [ann.id, ben.id] }, status: 'ACTIVE' } });
  assert.ok(activated && activated.passwordHash && !activated.passwordHash.includes('Brand-New'));
  assert.match((await request(app).get(`/accept-invite/${raw}`)).text, /no longer valid|invalid|expired/i); // single use
  assert.match((await get(admin, '/admin/employees')).text, /Invite all pending \(1\)/);
});

test('single resend hands the admin a one-time link in manual mode; nobody else can invite; production refuses without a mail server', async () => {
  const one = await post(admin, `/admin/employees/${(await prisma.profile.findFirst({ where: { organizationId: org.id, status: 'INVITED' } })).id}/resend-invite`);
  assert.equal(one.status, 200); assert.match(one.body.link, /^\/accept-invite\/[A-Za-z0-9_-]+$/);
  assert.equal(await prisma.invitation.count({ where: { status: 'PENDING', profile: { organizationId: org.id } } }), 1 + (await prisma.invitation.count({ where: { status: 'PENDING', profile: { organizationId: org.id, status: 'ACTIVE' } } })));
  for (const who of [sup]) {
    assert.ok(denied(await post(who, '/admin/employees/invite-pending')));
    assert.ok(denied(await post(who, `/admin/employees/${ben.id}/resend-invite`)));
  }
  // another organization's admin cannot invite our people
  const foreign = await post(outsider, `/admin/employees/${ben.id}/resend-invite`);
  assert.ok(denied(foreign) || !foreign.body.link);
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const refused = await post(admin, '/admin/employees/invite-pending');
    assert.equal(refused.status, 503); assert.equal(refused.text.includes('/accept-invite/'), false);
    const single = await post(admin, `/admin/employees/${ben.id}/resend-invite`);
    assert.equal(single.status, 503); assert.equal(single.body.link, undefined); // no links are ever handed out in production
    assert.equal(await prisma.invitation.count({ where: { profileId: ben.id, status: 'PENDING' } }), 0); // the failed send left no usable token behind
  } finally { process.env.NODE_ENV = original; }
});

test('a new password must be at least 6 characters (activation, reset and change)', async () => {
  const cara = await prisma.profile.create({ data: { organizationId: org.id, fullName: 'IV cara', username: `iv_${org.id}_cara`, email: `iv_${org.id}_cara@example.invalid`, role: 'TRAVEL_AGENT', status: 'INVITED', employmentStartDate: new Date() } });
  const { raw, hash } = generateToken();
  await prisma.invitation.create({ data: { profileId: cara.id, tokenHash: hash, invitedById: admin.id, expiresAt: new Date(Date.now() + 3600000) } });
  const short = await request(app).post(`/accept-invite/${raw}`).type('form').send({ password: 'abc12', confirmPassword: 'abc12' });
  assert.equal(short.status, 200); assert.match(short.text, /at least 6 characters/);
  assert.equal((await prisma.profile.findUnique({ where: { id: cara.id } })).status, 'INVITED'); // still not activated
  const ok = await request(app).post(`/accept-invite/${raw}`).type('form').send({ password: 'abc123', confirmPassword: 'abc123' });
  assert.equal(ok.status, 302);
  const stored = await prisma.profile.findUnique({ where: { id: cara.id } });
  assert.equal(stored.status, 'ACTIVE'); assert.ok(stored.passwordHash && stored.passwordHash !== 'abc123'); // stored only as a bcrypt hash
});

test('employee Excel download passes object boundary, is admin-only and organization-scoped', async () => {
  const response = await get(admin, '/admin/employees/export.xlsx?q=nonexistent').buffer(true).parse((res, done) => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => done(null, Buffer.concat(chunks)));
    res.on('error', done);
  });
  assert.equal(response.status, 200);
  assert.match(response.headers['content-disposition'], /attachment;.*\.xlsx/);
  assert.match(response.headers['cache-control'], /no-store/);
  const AdmZip = require('adm-zip');
  const workbook = new AdmZip(response.body);
  const sheet = workbook.readAsText('xl/worksheets/sheet1.xml') + workbook.readAsText('xl/worksheets/sheet2.xml');
  for (const person of [admin, sup, ann, ben, archived]) assert.ok(sheet.includes(person.username));
  for (const person of [outsider, otherInvited]) assert.ok(!sheet.includes(person.username));
  assert.ok(!sheet.includes(admin.passwordHash));
  assert.ok(denied(await get(sup, '/admin/employees/export.xlsx')));
  assert.equal((await request(app).get('/admin/employees/export.xlsx')).status, 302);
});
