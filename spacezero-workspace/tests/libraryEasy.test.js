'use strict';
// The easier Library: one page with everything / saved / recently viewed, category chips with counts, search over
// titles, descriptions and tags; and Manage library with three steps to add material (file, link or note, the file
// type recognised from the file), a plain "Who can see it?", categories that can be renamed and removed when empty,
// and archiving limited to the Admin's own organization.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const app = require('../server');

let org, otherOrg, admin, agent, adminCookie, agentCookie, sabre, empty, guide, foreign;
const as = (cookie) => ({
  get: (url) => request(app).get(url).set('Cookie', cookie),
  post: (url, body = {}) => request(app).post(url).set('Cookie', cookie).type('form').send(body),
});
async function login(p) {
  const t = generateToken();
  await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } });
  return `sz_session=${t.raw}`;
}

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Easy library tests' } });
  otherOrg = await prisma.organization.create({ data: { name: 'Easy library other org' } });
  const base = { status: 'ACTIVE', employmentStartDate: new Date() };
  admin = await prisma.profile.create({ data: { ...base, organizationId: org.id, fullName: 'Lib Admin', username: `la_${org.id}`, email: `la_${org.id}@example.invalid`, role: 'ADMIN' } });
  agent = await prisma.profile.create({ data: { ...base, organizationId: org.id, fullName: 'Lib Agent', username: `lg_${org.id}`, email: `lg_${org.id}@example.invalid`, role: 'TRAVEL_AGENT' } });
  adminCookie = await login(admin);
  agentCookie = await login(agent);
  sabre = await prisma.libraryCategory.create({ data: { organizationId: org.id, name: 'Sabre', displayOrder: 1 } });
  empty = await prisma.libraryCategory.create({ data: { organizationId: org.id, name: 'Salam', displayOrder: 2 } });
  guide = await prisma.libraryItem.create({ data: { organizationId: org.id, categoryId: sabre.id, title: 'Availability cheat sheet', description: 'How to read the AV screen', tagsJson: JSON.stringify(['gds', 'sabre']), itemType: 'NOTE', createdById: admin.id } });
  await prisma.libraryItem.create({ data: { organizationId: org.id, title: 'Admins only memo', itemType: 'NOTE', visibleRolesJson: JSON.stringify(['ADMIN']), createdById: admin.id } });
  const foreignAdmin = await prisma.profile.create({ data: { ...base, organizationId: otherOrg.id, fullName: 'Other Admin', username: `oa_${otherOrg.id}`, email: `oa_${otherOrg.id}@example.invalid`, role: 'ADMIN' } });
  foreign = await prisma.libraryItem.create({ data: { organizationId: otherOrg.id, title: 'Other company item', itemType: 'NOTE', createdById: foreignAdmin.id } });
});
after(async () => { await prisma.$disconnect(); });

test('the Library shows category chips only for categories with something the person may see, with counts', async () => {
  const page = await as(agentCookie).get('/library');
  assert.equal(page.status, 200);
  assert.match(page.text, /class="lib-cat[^"]*" href="\/library\?category=[^"]+">Sabre <span>1<\/span>/);
  assert.doesNotMatch(page.text, />Salam </, 'an empty category is not offered to readers');
  assert.doesNotMatch(page.text, /Admins only memo/);
  assert.match(page.text, /All materials <span class="lib-count">1<\/span>/);
});

test('search finds words in the description and the tags, not only the title', async () => {
  assert.match((await as(agentCookie).get('/library?q=AV%20screen')).text, /Availability cheat sheet/);
  assert.match((await as(agentCookie).get('/library?q=gds')).text, /Availability cheat sheet/);
  assert.match((await as(agentCookie).get('/library?q=nothing-like-this')).text, /Nothing matches/);
});

test('Saved and Recently viewed are views of the same page; /library/mine still opens Saved', async () => {
  await as(agentCookie).post(`/library/${guide.id}/favorite`, { favorite: '1' });
  const saved = await as(agentCookie).get('/library/mine');
  assert.equal(saved.status, 200);
  assert.match(saved.text, /aria-current="page">★ Saved <span class="lib-count" data-favorite-count>1<\/span>/);
  assert.match(saved.text, /Availability cheat sheet/);
  await as(agentCookie).get(`/library/${guide.id}`);
  const recent = await as(agentCookie).get('/library?view=recent');
  assert.match(recent.text, /Opened today/);
  assert.match(recent.text, /Availability cheat sheet/);
});

test('Manage library adds a link and a note without choosing a type, and "Only some roles" needs a role', async () => {
  const link = await as(adminCookie).post('/admin/library/items', { source: 'link', title: 'Seat maps', externalUrl: 'https://www.seatguru.com', categoryId: sabre.id, audience: 'everyone' });
  assert.equal(link.status, 302);
  const seat = await prisma.libraryItem.findFirst({ where: { organizationId: org.id, title: 'Seat maps' } });
  assert.equal(seat.itemType, 'LINK');
  assert.equal(seat.visibleRolesJson, null, 'Everyone');

  const note = await as(adminCookie).post('/admin/library/items', { source: 'note', title: 'Lounge rule', noteText: 'Business class guests may bring one guest.', audience: 'some', visibleRoles: ['TRAVEL_AGENT'] });
  assert.equal(note.status, 302);
  const lounge = await prisma.libraryItem.findFirst({ where: { organizationId: org.id, title: 'Lounge rule' } });
  assert.equal(lounge.itemType, 'NOTE');
  assert.equal(lounge.description, 'Business class guests may bring one guest.');
  assert.deepEqual(JSON.parse(lounge.visibleRolesJson), ['TRAVEL_AGENT']);

  const noRole = await as(adminCookie).post('/admin/library/items', { source: 'link', title: 'Kept title', externalUrl: 'https://example.com', audience: 'some' });
  assert.equal(noRole.status, 400);
  assert.match(noRole.text, /Choose at least one role, or choose Everyone\./);
  assert.match(noRole.text, /id="lib-add"[^>]*data-open-on-load/, 'the add panel opens again');
  assert.match(noRole.text, /value="Kept title"/, 'what was typed is kept');
});

test('an uploaded file gets its type from the file itself', async () => {
  const res = await request(app).post('/admin/library/items').set('Cookie', adminCookie)
    .field('source', 'file').field('title', 'Fare rules PDF').field('audience', 'everyone')
    .attach('file', Buffer.from('%PDF-1.4\n%test\n'), { filename: 'fare-rules.pdf', contentType: 'application/pdf' });
  assert.equal(res.status, 302, res.text.slice(0, 300));
  const pdf = await prisma.libraryItem.findFirst({ where: { organizationId: org.id, title: 'Fare rules PDF' } });
  assert.equal(pdf.itemType, 'PDF');
  const bad = await request(app).post('/admin/library/items').set('Cookie', adminCookie)
    .field('source', 'file').field('title', 'Zip file').field('audience', 'everyone')
    .attach('file', Buffer.from('PK\u0003\u0004'), { filename: 'stuff.zip', contentType: 'application/zip' });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /This kind of file cannot be added/);
});

test('the list says who can see each material in words', async () => {
  const page = await as(adminCookie).get('/admin/library');
  assert.match(page.text, /Lounge rule[\s\S]*?Only Travel Agents/);
  assert.match(page.text, /Seat maps[\s\S]*?>Everyone</);
  assert.match(page.text, /data-howto="library"/);
});

test('categories: add (no duplicates), rename, and remove only when empty', async () => {
  const dup = await as(adminCookie).post('/admin/library/categories', { name: 'sabre' });
  assert.match(decodeURIComponent(dup.headers.location), /There is already a category called "sabre"/);
  await as(adminCookie).post(`/admin/library/categories/${empty.id}`, { name: 'Lounges' });
  assert.equal((await prisma.libraryCategory.findUnique({ where: { id: empty.id } })).name, 'Lounges');
  const blocked = await as(adminCookie).post(`/admin/library/categories/${sabre.id}/delete`);
  assert.match(decodeURIComponent(blocked.headers.location), /"Sabre" still has \d+ materials?/);
  assert.ok(await prisma.libraryCategory.findUnique({ where: { id: sabre.id } }));
  await as(adminCookie).post(`/admin/library/categories/${empty.id}/delete`);
  assert.equal(await prisma.libraryCategory.findUnique({ where: { id: empty.id } }), null);
  assert.equal((await as(agentCookie).post('/admin/library/categories', { name: 'Agent made' })).status, 403);
});

test('an Admin cannot archive another organization\'s material', async () => {
  const res = await request(app).post(`/admin/library/items/${foreign.id}/archive`).set('Cookie', adminCookie);
  assert.equal(res.status, 404);
  assert.equal((await prisma.libraryItem.findUnique({ where: { id: foreign.id } })).archivedAt, null);
  const own = await request(app).post(`/admin/library/items/${guide.id}/archive`).set('Cookie', adminCookie);
  assert.equal(own.status, 200);
  assert.ok((await prisma.libraryItem.findUnique({ where: { id: guide.id } })).archivedAt);
});

test('a YouTube link plays inside the Library and shows its thumbnail; other links stay plain links', async () => {
  const { youtubeId } = require('../lib/library');
  assert.equal(youtubeId('https://youtu.be/Sp54mxnWjUM?si=abc'), 'Sp54mxnWjUM');
  assert.equal(youtubeId('https://www.youtube.com/watch?v=Sp54mxnWjUM&t=3'), 'Sp54mxnWjUM');
  assert.equal(youtubeId('https://youtube.com.evil.example/watch?v=Sp54mxnWjUM'), null);
  assert.equal(youtubeId('javascript:alert(1)'), null);

  await as(adminCookie).post('/admin/library/items', { source: 'link', title: 'Holiday film', externalUrl: 'https://youtu.be/Sp54mxnWjUM?si=abc', audience: 'everyone' });
  const film = await prisma.libraryItem.findFirst({ where: { organizationId: org.id, title: 'Holiday film' } });
  const page = await as(agentCookie).get(`/library/${film.id}`);
  assert.match(page.text, /<iframe src="https:\/\/www\.youtube-nocookie\.com\/embed\/Sp54mxnWjUM\?rel=0"/);
  assert.match(page.headers['content-security-policy'], /frame-src https:\/\/www\.youtube-nocookie\.com;/);
  const list = await as(agentCookie).get('/library');
  assert.match(list.text, /<img src="https:\/\/i\.ytimg\.com\/vi\/Sp54mxnWjUM\/hqdefault\.jpg"/);
  assert.match(list.text, />YouTube video</);

  await as(adminCookie).post('/admin/library/items', { source: 'link', title: 'Seat guru page', externalUrl: 'https://www.seatguru.com/x', audience: 'everyone' });
  const plain = await prisma.libraryItem.findFirst({ where: { organizationId: org.id, title: 'Seat guru page' } });
  const plainPage = await as(agentCookie).get(`/library/${plain.id}`);
  assert.doesNotMatch(plainPage.text, /<iframe/);
  assert.match(plainPage.text, /Open link/);
});
