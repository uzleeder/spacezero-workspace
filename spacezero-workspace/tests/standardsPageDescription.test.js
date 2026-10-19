'use strict';
// One short description directly under the title of the Company Standards & Workflow page: it is the
// page header's existing description line (muted text, no card, no section, no icon, no
// acknowledgement). An Admin-editable organization setting - not a Standard.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { DEFAULTS } = require('../lib/orgSettings');
const app = require('../server');

let org, admin, supervisor, agent, expert, cookies = {};
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);
const APPROVED = 'SpaceZero Workspace is the company’s internal platform for employee readiness, training and continuous development. It brings company standards, role responsibilities, workflows, AI-powered practice, call review and operational guidance into one place so employees can learn, apply what they learn, improve their skills and perform consistently.';
const headerOf = (html) => (/<div class="page-header">[\s\S]*?<\/div>\s*<\/div>/.exec(html) || [''])[0];

async function user(role, name) {
  const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: name, username: `pd_${org.id}_${name}`, email: `pd_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
  const token = generateToken();
  await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
  cookies[p.id] = `sz_session=${token.raw}`;
  return p;
}

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Page description tests' } });
  admin = await user('ADMIN', 'admin');
  supervisor = await user('SUPERVISOR', 'supervisor');
  agent = await user('TRAVEL_AGENT', 'agent');
  expert = await user('FLIGHT_EXPERT', 'expert');
});
after(async () => { await prisma.$disconnect(); });

test('the default text is exactly the approved wording, with SpaceZero as one word', () => {
  assert.equal(DEFAULTS['standards.pageDescription'], APPROVED);
  assert.doesNotMatch(APPROVED, /Space Zero|Space-Zero/);
});

test('every role sees it directly under the page title, as part of the existing page header', async () => {
  for (const who of [admin, supervisor, agent, expert]) {
    const page = await get(who, '/standards');
    assert.equal(page.status, 200);
    const header = headerOf(page.text);
    assert.match(header, /<h1>Company Standards &amp; Workflow<\/h1>\s*<p>SpaceZero Workspace is the company(’|&#39;)s internal platform/);
    assert.ok(header.includes('perform consistently.</p>'));
    assert.doesNotMatch(page.text, /standards-intro|Purpose of SpaceZero/, 'no card, section or extra title');
    assert.doesNotMatch(header, /acknowledg|<svg|class="card"/i);
  }
});

test('nothing new is created: no Standard, no acknowledgement', async () => {
  assert.equal(await prisma.standardsItem.count({ where: { organizationId: org.id } }), 0);
  assert.equal(await prisma.standardsAcknowledgement.count({ where: { item: { organizationId: org.id } } }), 0);
});

test('an Admin edits it from the manage page; everyone sees the new text; the change is audited', async () => {
  const manage = await get(admin, '/admin/standards');
  assert.equal(manage.status, 200);
  assert.match(manage.text, /Page description/);
  assert.match(manage.text, /SpaceZero Workspace is the company/);

  const saved = await post(admin, '/admin/standards/description', { pageDescription: 'Our <b>shared</b> workspace.' });
  assert.equal(saved.status, 302);
  assert.match(saved.headers.location, /saved=1/);
  const page = await get(agent, '/standards');
  assert.match(headerOf(page.text), /<p>Our &lt;b&gt;shared&lt;\/b&gt; workspace\.<\/p>/, 'plain text, escaped');
  assert.ok(await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'standards.description_updated' } }));
});

test('too long is refused and changes nothing; an empty text shows no description line', async () => {
  const tooLong = await post(admin, '/admin/standards/description', { pageDescription: 'x'.repeat(601) });
  assert.match(tooLong.headers.location, /descriptionError=1/);
  assert.match(headerOf((await get(agent, '/standards')).text), /Our &lt;b&gt;shared/, 'the last valid text is still shown');

  assert.equal((await post(admin, '/admin/standards/description', { pageDescription: '   ' })).status, 302);
  const none = await get(agent, '/standards');
  assert.equal(none.status, 200);
  assert.doesNotMatch(headerOf(none.text), /<p>/);
});

test('only an Admin can change it', async () => {
  for (const who of [supervisor, agent, expert]) {
    const res = await post(who, '/admin/standards/description', { pageDescription: 'Hacked' });
    assert.ok([302, 403, 404].includes(res.status));
    assert.doesNotMatch(res.headers.location || '', /admin\/standards\?saved/);
  }
  assert.doesNotMatch((await get(agent, '/standards')).text, /Hacked/);
});
