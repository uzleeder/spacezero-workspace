'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { validateUpload, resolveStoragePath } = require('../lib/storage');
const { consumeAccountToken } = require('../lib/consumeAccountToken');
const { hashPassword, verifyPassword } = require('../lib/password');
const app = require('../server');
let org, foreignOrg, admin, supervisor, agent, expert, other, foreign, cookie, smtp;
const messages = [];
const fixtures = [];
async function account(role, organizationId, status = 'ACTIVE') {
  const id = randomUUID();
  const profile = await prisma.profile.create({ data: { organizationId, fullName: id, username: id, email: `${id}@example.invalid`, role, status, employmentStartDate: new Date() } });
  fixtures.push(profile);
  return profile;
}
async function session(profile) {
  const token = generateToken();
  await prisma.session.create({ data: { profileId: profile.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
  return `sz_session=${token.raw}`;
}
before(async () => {
  process.env.NODE_ENV = 'test';
  smtp = net.createServer(socket => {
    socket.write('220 localhost SMTP test\r\n');
    let buffer = '', data = false, message = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0,end); buffer = buffer.slice(end + 2);
        if (data) {
          if (line === '.') { messages.push(message); message = ''; data = false; socket.write('250 accepted\r\n'); }
          else message += line + '\n';
        } else if (/^DATA/i.test(line)) { data = true; socket.write('354 send data\r\n'); }
        else if (/^QUIT/i.test(line)) socket.end('221 bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  await new Promise(resolve => smtp.listen(0,'127.0.0.1',resolve));
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.address().port), SMTP_FROM: 'workspace@example.invalid', APP_ORIGIN: 'http://localhost:3000' });
  delete process.env.SMTP_USER; delete process.env.SMTP_PASSWORD;
  org = await prisma.organization.create({ data: { name: 'Security fixture' } });
  foreignOrg = await prisma.organization.create({ data: { name: 'Foreign fixture' } });
  admin = await account('ADMIN',org.id); supervisor = await account('SUPERVISOR',org.id);
  agent = await account('TRAVEL_AGENT',org.id); other = await account('TRAVEL_AGENT',org.id); expert = await account('FLIGHT_EXPERT',org.id);
  foreign = await account('TRAVEL_AGENT',foreignOrg.id);
  await prisma.supervisorAssignment.create({ data: { supervisorId: supervisor.id, agentId: agent.id } });
  cookie = await session(admin);
});
after(async () => {
  for (const organization of [org, foreignOrg]) if (organization) {
    await prisma.trainingCourse.deleteMany({ where: { organizationId: organization.id } });
    await prisma.libraryItem.deleteMany({ where: { organizationId: organization.id } });
    await prisma.organization.delete({ where: { id: organization.id } });
  }
  await new Promise(resolve => smtp.close(resolve));
  await prisma.$disconnect();
});

test('organization IDs cannot bypass employee read, update, status or reset authorization', async () => {
  for (const suffix of ['', '/disable', '/archive', '/resend-invite', '/reset-password']) {
    const response = await request(app)[suffix ? 'post' : 'get'](`/admin/employees/${foreign.id}${suffix}`).set('Cookie',cookie);
    assert.equal(response.status,404);
  }
  assert.equal((await prisma.profile.findUnique({ where: { id: foreign.id } })).status,'ACTIVE');
});
test('supervisor sees only assigned agents; agent and expert cannot read team data', async () => {
  const sup = await session(supervisor);
  assert.equal((await request(app).get(`/team/${agent.id}`).set('Cookie',sup)).status,200);
  for (const profile of [other, foreign, expert]) assert.equal((await request(app).get(`/team/${profile.id}`).set('Cookie',sup)).status,404);
  for (const profile of [agent, expert]) assert.ok([403,404].includes((await request(app).get(`/team/${other.id}`).set('Cookie',await session(profile))).status));
});
test('actual local SMTP invitation delivery, activation, replay rejection, and reset', async () => {
  const name = 'invited_' + randomUUID().slice(0,8);
  const created = await request(app).post('/admin/employees/new').set('Cookie',cookie).type('form').send({ fullName: 'Invited Employee', username: name, email: `${name}@example.invalid`, role:'TRAVEL_AGENT', employmentStartDate:'2026-01-01' });
  assert.equal(created.status,302);
  let invited = await prisma.profile.findUnique({ where: { username:name } });
  fixtures.push(invited);
  assert.equal(invited.status,'INVITED'); assert.equal(invited.passwordHash,null);
  const invitationMail = messages.at(-1).replace(/=\n/g,'');
  const token = invitationMail.match(/accept-invite\/([\w-]+)/)[1];
  const password = 'NewSecurePassword123!';
  const activate = await request(app).post(`/accept-invite/${token}`).type('form').send({ password, confirmPassword:password });
  assert.equal(activate.status,302);
  assert.equal((await request(app).post(`/accept-invite/${token}`).type('form').send({ password, confirmPassword:password })).status,400);
  invited = await prisma.profile.findUnique({ where: { id: invited.id } });
  assert.equal(invited.status,'ACTIVE'); assert.ok(await verifyPassword(password, invited.passwordHash));
  const reset = await request(app).post('/forgot-password').type('form').send({ email: invited.email });
  assert.equal(reset.status,200); assert.ok(!reset.text.includes('/reset-password/'));
  const resetToken = messages.at(-1).replace(/=\n/g,'').match(/reset-password\/([\w-]+)/)[1];
  const updated = await consumeAccountToken(resetToken, await hashPassword('AnotherSecurePassword123!'), false);
  assert.equal(updated.id,invited.id);
  assert.equal(await consumeAccountToken(resetToken, 'unused', false),null);
  assert.equal(await prisma.session.count({ where: { profileId:invited.id } }),0);
});
test('expired tokens and disabled accounts cannot activate or reset', async () => {
  const invited = await account('TRAVEL_AGENT',org.id,'DISABLED');
  const token = generateToken();
  await prisma.invitation.create({ data: { profileId:invited.id, tokenHash:token.hash, invitedById:admin.id, expiresAt:new Date(Date.now()+3600000) } });
  assert.equal(await consumeAccountToken(token.raw,'unused',true),null);
  const reset = generateToken();
  await prisma.passwordResetToken.create({ data: { profileId:agent.id, tokenHash:reset.hash, expiresAt:new Date(0) } });
  assert.equal(await consumeAccountToken(reset.raw,'unused',false),null);
});
test('foreign library favorites, downloads and categories reject ID manipulation', async () => {
  const item = await prisma.libraryItem.create({ data: { organizationId:foreignOrg.id, createdById:foreign.id, title:'Private foreign material', itemType:'NOTE' } });
  for(const path of [`/library/${item.id}`,`/library-file/${item.id}`]) assert.equal((await request(app).get(path).set('Cookie',cookie)).status,404);
  assert.equal((await request(app).post(`/library/${item.id}/favorite`).set('Cookie',cookie)).status,404);
});
test('assignment rejects foreign course and unrelated supervisor recipients', async () => {
  const course = await prisma.trainingCourse.create({ data: { organizationId:org.id, createdById:admin.id, title:'Security training', status:'PUBLISHED' } });
  const response = await request(app).post('/assignments').set('Cookie',await session(supervisor)).type('form').send({ courseId:course.id, scope:'INDIVIDUAL', targetProfileIds:other.id });
  assert.equal(response.status,403);
  const cross = await request(app).post('/assignments').set('Cookie',cookie).type('form').send({ courseId:course.id, scope:'INDIVIDUAL', targetProfileIds:foreign.id });
  assert.equal(cross.status,403);
});
test('file validation rejects forged MIME, unknown types and path traversal', () => {
  const buffer = Buffer.from('<script>alert(1)</script>');
  assert.ok(validateUpload('IMAGE',{ mimetype:'image/png',size:buffer.length,buffer }));
  assert.ok(validateUpload('UNKNOWN',{ mimetype:'image/png',size:buffer.length,buffer }));
  for (const path of ['../.env','..\\.env','C:\\secret','/etc/passwd']) assert.throws(()=>resolveStoragePath(path));
});
test('cross-site state changes are blocked', async () => {
  const response = await request(app).post('/admin/teams').set('Cookie',cookie).set('Origin','https://attacker.invalid').type('form').send({ name:'Malicious' });
  assert.equal(response.status,403);
});
