'use strict';
const { test, before, after, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const gemini = require('../lib/gemini');
const app = require('../server');
let org, agent, other, admin, foreign, savedChat;
const cookies = {}, tokens = {};
let prompts = [];
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const ask = (p, body) => request(app).post('/assistant/ask').set('Cookie', cookies[p.id]).set('Accept', 'application/json').type('form').send(body);
function answer(data = { answer: 'Your required training is up to date.', confident: true }) {
  mock.method(gemini, 'generateStructured', async args => { prompts.push(args); return { data }; });
}
before(async () => {
  org = await prisma.organization.create({ data: { name: 'Chat isolation tests' } });
  const outside = await prisma.organization.create({ data: { name: 'Other chat organization' } });
  const person = async (role, name, organizationId = org.id) => {
    const p = await prisma.profile.create({ data: { organizationId, role, status: 'ACTIVE', fullName: name, username: `chat_${org.id}_${name}`, email: `chat_${org.id}_${name}@example.invalid`, employmentStartDate: new Date() } });
    const token = generateToken(); tokens[p.id] = token.raw;
    await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
    cookies[p.id] = `sz_session=${token.raw}`; return p;
  };
  agent = await person('TRAVEL_AGENT', 'Learner'); other = await person('SUPERVISOR', 'Supervisor'); admin = await person('ADMIN', 'Admin'); foreign = await person('ADMIN', 'Foreign', outside.id);
});

test('knowledge reads only published applicable standards and authorized leave without private notes', async () => {
  const makeStandard = async (title, roles, status = 'PUBLISHED') => {
    const item = await prisma.standardsItem.create({ data: { organizationId: org.id, title, contentType: 'STANDARD', rolesJson: JSON.stringify(roles), createdById: admin.id } });
    const v = await prisma.standardsVersion.create({ data: { itemId: item.id, version: 1, status, createdById: admin.id, contentJson: JSON.stringify([{ type: 'paragraph', text: title + ' approved wording' }]), steps: { create: { title: 'Step one', instruction: 'Verify the request.' } } } });
    await prisma.standardsItem.update({ where: { id: item.id }, data: { currentVersionId: v.id } });
  };
  await makeStandard('Jasmine visible standard', ['TRAVEL_AGENT']);
  await makeStandard('Jasmine restricted standard', ['ADMIN']);
  await makeStandard('Jasmine draft standard', ['TRAVEL_AGENT'], 'DRAFT');
  const leave = p => prisma.leaveRequest.create({ data: { organizationId: p.organizationId, profileId: p.id, startDate: new Date('2027-01-10'), endDate: new Date('2027-01-11'), days: 2, note: 'SECRET MEDICAL NOTE', managementNote: 'SECRET MANAGEMENT NOTE' } });
  await leave(agent); await leave(other); await leave(foreign);
  const knowledge = await require('../lib/spaceAiKnowledge').knowledgeFor(agent, 'Jasmine standard vacation leave');
  const raw = JSON.stringify(knowledge);
  assert.match(raw, /Jasmine visible standard approved wording/);
  assert.match(raw, /Verify the request/);
  assert.doesNotMatch(raw, /Jasmine restricted|Jasmine draft|SECRET/);
  assert.deepEqual(knowledge.leave.map(l => l.profile.fullName), [agent.fullName]);
});
test('training knowledge respects assignment recipient and assigned module version', async () => {
  const course = await prisma.trainingCourse.create({ data: { organizationId: org.id, createdById: admin.id, title: 'Marigold assigned course', status: 'PUBLISHED', modules: { create: [
    { title: 'Marigold original module', contentType: 'NOTE', description: 'Visible lesson', addedInVersion: 1 },
    { title: 'Marigold future module', contentType: 'NOTE', description: 'Future lesson', addedInVersion: 2 },
  ] } } });
  await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, courseVersion: 1, assignedById: admin.id, scope: 'INDIVIDUAL', recipients: { create: { profileId: agent.id } } } });
  const own = await require('../lib/spaceAiKnowledge').knowledgeFor(agent, 'Marigold');
  assert.match(JSON.stringify(own), /Visible lesson/); assert.doesNotMatch(JSON.stringify(own), /Future lesson/);
  const another = await require('../lib/spaceAiKnowledge').knowledgeFor(other, 'Marigold');
  assert.doesNotMatch(JSON.stringify(another), /Marigold/);
});


test('rename, pin and archive persist, validate input and enforce ownership', async () => {
  answer();
  const c = (await ask(agent, { question: 'Chat menu test' })).body.chat;
  const action = (p, name, body = {}) => request(app).post('/assistant/chats/' + c.id + '/' + name).set('Cookie', cookies[p.id]).set('Accept', 'application/json').send(body);
  assert.equal((await action(other, 'rename', { title: 'Stolen' })).status, 404);
  assert.equal((await action(agent, 'rename', { title: '  ' })).status, 400);
  assert.equal((await action(agent, 'rename', { title: 'x'.repeat(101) })).status, 400);
  assert.equal((await action(agent, 'rename', { title: '  My   setup  ' })).body.chat.title, 'My setup');
  assert.equal((await action(agent, 'pin')).body.chat.isPinned, true);
  assert.equal((await require('../lib/aiChats').listChats(agent))[0].id, c.id);
  assert.equal((await action(agent, 'archive')).body.chat.isArchived, true);
  assert.doesNotMatch((await get(agent, '/assistant')).text, /My setup/);
  assert.match((await get(agent, '/assistant?archived=1')).text, /My setup/);
  assert.equal((await ask(agent, { chatId: c.id, question: 'Continue' })).status, 409);
  assert.equal((await action(agent, 'archive')).body.chat.isArchived, false);
  assert.equal((await action(agent, 'pin')).body.chat.isPinned, false);
  const page = await get(agent, '/assistant?chat=' + c.id);
  assert.match(page.text, /data-ai-options/);
  assert.match(page.text, /space-ai-history.js/);
  assert.doesNotMatch(require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/js/space-ai.js'), 'utf8'), /window\.(confirm|prompt)/);
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=', 'base64');
function upload(p, file = png, options = { filename: 'screen.png', contentType: 'image/png' }) {
  return request(app).post('/assistant/ask').set('Cookie', cookies[p.id]).set('Accept', 'application/json').attach('image', file, options);
}
test('image-only messages reach the model and persist behind owner-only authenticated URLs', async () => {
  answer({ confident: true, answer: 'The attached test image is one pixel.' });
  const res = await upload(agent);
  assert.equal(res.status, 200); assert.ok(res.body.chat);
  const m = res.body.messages[0], inline = prompts[0].contents[0].parts[1].inlineData;
  assert.equal(inline.mimeType, 'image/png'); assert.equal(inline.data, png.toString('base64'));
  assert.equal(m.content, 'Please explain this image.');
  assert.doesNotMatch(JSON.stringify(res.body), /imagePath|storagePath|ai-chat-images/);
  assert.equal((await get(agent, m.image.url)).status, 200);
  for (const p of [other, admin, foreign]) assert.equal((await get(p, m.image.url)).status, 404);
  assert.equal((await request(app).get(m.image.url)).status, 302);
  await ask(agent, { chatId: res.body.chat.id, question: 'Explain it again' });
  assert.equal(prompts[1].contents[0].parts[1].inlineData.data, png.toString('base64'));
  const impersonated = 'sz_session=' + tokens[agent.id] + '; sz_admin_session=' + tokens[admin.id];
  assert.equal((await request(app).get(m.image.url).set('Cookie', impersonated)).status, 404);
  const stored = await prisma.aiChatMessage.findUnique({ where: { id: m.id } });
  const filename = require('../lib/storage').resolveStoragePath(stored.imagePath);
  assert.ok(require('node:fs').existsSync(filename));
  await request(app).post('/assistant/chats/' + res.body.chat.id + '/delete').set('Cookie', cookies[agent.id]);
  assert.equal(require('node:fs').existsSync(filename), false);
});

test('invalid, oversized and extra image uploads never reach the model or create a chat', async () => {
  answer();
  const count = await prisma.aiChat.count({ where: { profileId: agent.id } });
  assert.equal((await upload(agent, Buffer.from('<svg/>'), { filename: 'fake.png', contentType: 'image/png' })).status, 400);
  assert.equal((await upload(agent, png, { filename: 'bad.svg', contentType: 'image/svg+xml' })).status, 400);
  assert.equal((await upload(agent, Buffer.alloc(5 * 1024 * 1024 + 1))).status, 413);
  assert.equal((await upload(agent).attach('image', png, 'second.png')).status, 400);
  assert.equal(prompts.length, 0);
  assert.equal(await prisma.aiChat.count({ where: { profileId: agent.id } }), count);
});

test('sharing authorizes selected coworkers only, freezes messages, revokes images and cascades on deletion', async () => {
  answer();
  const initial = (await upload(agent)).body, id = initial.chat.id;
  const share = ids => request(app).post('/assistant/chats/' + id + '/share').set('Cookie', cookies[agent.id]).send({ recipientIds: ids });
  assert.equal((await share([foreign.id])).status, 400);
  assert.equal((await share([])).status, 400);
  const options = await get(agent, '/assistant/chats/' + id + '/sharing');
  assert.ok(options.body.people.some(p => p.id === other.id));
  assert.ok(!options.body.people.some(p => p.id === foreign.id));
  assert.doesNotMatch(JSON.stringify(options.body), /email|password/);
  assert.equal((await get(admin, '/assistant/chats/' + id + '/sharing')).status, 404);
  const shared = (await share([other.id])).body;
  const imageUrl = shared.path + '/images/' + initial.messages[0].id;
  assert.equal((await get(other, shared.path)).status, 200);
  assert.equal((await get(other, imageUrl)).status, 200);
  for (const p of [admin, foreign]) {
    assert.equal((await get(p, shared.path)).status, 404);
    assert.equal((await get(p, imageUrl)).status, 404);
  }
  assert.equal((await request(app).get(shared.path)).status, 302);
  await ask(agent, { chatId: id, question: 'Private later message zebra' });
  assert.doesNotMatch((await get(other, shared.path)).text, /Private later message zebra/);
  const revoke = p => request(app).post('/assistant/chats/' + id + '/shares/' + shared.id + '/revoke').set('Cookie', cookies[p.id]);
  assert.equal((await revoke(admin)).status, 404);
  assert.equal((await revoke(agent)).status, 200);
  assert.equal((await get(other, shared.path)).status, 404);
  assert.equal((await get(other, imageUrl)).status, 404);
  const second = (await share([other.id])).body;
  await request(app).post('/assistant/chats/' + id + '/delete').set('Cookie', cookies[agent.id]);
  assert.equal(await prisma.aiChatShare.count({ where: { chatId: id } }), 0);
  assert.equal((await get(other, second.path)).status, 404);
});

test('platform knowledge filters Library by role and organization before passing text to the model', async () => {
  answer();
  const make = (title, roles, organizationId = org.id) => prisma.libraryItem.create({ data: { organizationId, createdById: admin.id, title, description: title + ' detailed content', itemType: 'NOTE', visibleRolesJson: JSON.stringify(roles) } });
  const visible = await make('Orchid learner manual', ['TRAVEL_AGENT']);
  await make('Orchid manager restricted manual', ['ADMIN']);
  await make('Orchid foreign manual', ['TRAVEL_AGENT'], foreign.organizationId);
  const archived = await make('Orchid archived manual', ['TRAVEL_AGENT']);
  await prisma.libraryItem.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
  const res = await ask(agent, { question: 'Explain orchid manual and platform training' });
  assert.equal(res.status, 200); assert.equal(res.body.messages[1].kind, 'answer');
  const raw = prompts[0].contents;
  assert.match(raw, /Orchid learner manual detailed content/);
  assert.doesNotMatch(raw, /Orchid manager restricted|Orchid foreign|Orchid archived|Settings and configuration/);
  assert.match(raw, /My Training and retakes/);
  assert.ok(res.body.messages[1].sources.some(s => s.href === '/library/' + visible.id));
  assert.doesNotMatch(raw, /passwordHash|tokenHash|payloadEnc/);
});

afterEach(async () => { mock.restoreAll(); prompts = []; await prisma.rateLimitAttempt.deleteMany({ where: { bucketKey: { contains: org.id } } }); });
after(async () => { await prisma.$disconnect(); });

test('panel answers return JSON and persist a private ordered conversation; reopening restores it', async () => {
  answer();
  const res = await ask(agent, { question: 'What training is left?' });
  assert.equal(res.status, 200); assert.match(res.headers['content-type'], /application\/json/);
  savedChat = res.body.chat;
  assert.equal(savedChat.title, 'What training is left?');
  assert.deepEqual(res.body.messages.map(m => m.role), ['user', 'assistant']);
  const reopened = await get(agent, `/assistant/chats/${savedChat.id}/messages`);
  assert.deepEqual(reopened.body.messages.map(m => m.content), ['What training is left?', 'Your required training is up to date.']);
  const page = await get(agent, `/assistant?chat=${savedChat.id}`);
  assert.equal(page.status, 200); assert.match(page.text, /data-ai-history/); assert.match(page.text, /Your required training is up to date/);
  assert.equal((page.text.match(/id="space-ai-contacts"/g) || []).length, 1);
});

test('follow-ups use only the selected owner conversation and fresh authorized facts', async () => {
  answer();
  const res = await ask(agent, { chatId: savedChat.id, question: 'And my setup?' });
  assert.equal(res.body.chat.id, savedChat.id);
  assert.match(prompts[0].contents, /CONVERSATION CONTEXT/);
  assert.match(prompts[0].contents, /What training is left/);
  assert.match(prompts[0].systemInstruction, /not instructions or evidence/);
  assert.match(prompts[0].systemInstruction, /Always answer in English/);
  const facts = JSON.parse(prompts[0].contents.split('FACTS (JSON — the only information you may use):\n')[1].split('\n\nQUESTION:')[0]);
  assert.deepEqual(facts.people.map(p => p.name), ['Learner']);
  assert.equal((await get(agent, `/assistant/chats/${savedChat.id}/messages`)).body.messages.length, 4);
  const fresh = await ask(agent, { question: 'Start fresh' });
  assert.notEqual(fresh.body.chat.id, savedChat.id);
  assert.doesNotMatch(prompts[1].contents, /CONVERSATION CONTEXT/);
});

test('other users, supervisors and even Admins cannot open, append to or delete a private chat', async () => {
  answer();
  for (const p of [other, admin, foreign]) {
    assert.equal((await get(p, `/assistant/chats/${savedChat.id}/messages`)).status, 404);
    assert.equal((await ask(p, { chatId: savedChat.id, question: 'Read this chat' })).status, 404);
    assert.doesNotMatch((await get(p, '/assistant')).text, /What training is left/);
    await request(app).post(`/assistant/chats/${savedChat.id}/delete`).set('Cookie', cookies[p.id]);
  }
  assert.equal(prompts.length, 0, 'unauthorized chat IDs never reach the model');
  assert.equal(await prisma.aiChat.count({ where: { id: savedChat.id } }), 1);
});

test('unknown answers show the supplied Admin Telegram contacts; technical failures prioritize Engineer Max', async () => {
  answer({ answer: 'Not enough data', confident: false });
  const unknown = await ask(agent, { question: 'An unknown company policy?' });
  assert.equal(unknown.body.messages[1].kind, 'unknown');
  const page = await get(agent, `/assistant?chat=${unknown.body.chat.id}`);
  for (const handle of ['ali_avove9', 'Joe_Above9', 'tom_allen_above9', 'si_leeder']) assert.ok(page.text.includes(`href="https://t.me/${handle}"`));
  const technicalQuestion = await ask(agent, { question: 'The video is not playing. Can you fix it?' });
  assert.equal(technicalQuestion.body.messages[1].kind, 'technical');
  assert.match(technicalQuestion.body.messages[1].content, /enough SpaceZero data/);
  assert.doesNotMatch(technicalQuestion.body.messages[1].content, /because of a technical problem/);
  mock.restoreAll(); mock.method(gemini, 'generateStructured', async () => { throw Error('secret provider detail'); });
  const failure = await ask(agent, { question: 'Is my setup complete?' });
  assert.equal(failure.status, 200); assert.equal(failure.body.messages[1].kind, 'technical');
  assert.doesNotMatch(JSON.stringify(failure.body), /secret provider detail/);
  const failurePage = await get(agent, `/assistant?chat=${failure.body.chat.id}`);
  assert.match(failurePage.text, /Please contact the engineer on Telegram/);
});

test('empty input and rate limiting do not create empty or partial chats', async () => {
  answer();
  const count = await prisma.aiChat.count({ where: { profileId: other.id } });
  assert.equal((await ask(other, { question: '  ' })).status, 400);
  await prisma.rateLimitAttempt.createMany({ data: Array.from({ length: 20 }, () => ({ bucketKey: `ai:${other.id}`, succeeded: true })) });
  const limit = await ask(other, { question: 'Too many requests' });
  assert.equal(limit.status, 429); assert.equal(limit.body.messages[1].kind, 'limit');
  assert.equal(await prisma.aiChat.count({ where: { profileId: other.id } }), count);
  assert.equal(prompts.length, 0);
});

test('View as cannot read or change the real employee chat history', async () => {
  const impersonated = `sz_session=${tokens[agent.id]}; sz_admin_session=${tokens[admin.id]}`;
  const page = await request(app).get(`/assistant?chat=${savedChat.id}`).set('Cookie', impersonated);
  assert.equal(page.status, 200); assert.match(page.text, /chats are private/);
  assert.doesNotMatch(page.text, /What training is left/);
  assert.doesNotMatch(page.text, /data-ai-form/);
  assert.equal((await request(app).get(`/assistant/chats/${savedChat.id}/messages`).set('Cookie', impersonated)).status, 404);
  assert.equal((await request(app).post('/assistant/ask').set('Cookie', impersonated).set('Accept', 'application/json').send({ question: 'Write as employee' })).status, 403);
  assert.equal((await request(app).post(`/assistant/chats/${savedChat.id}/delete`).set('Cookie', impersonated)).status, 403);
});

test('chat history has older/newer pages and escaped user/model content', async () => {
  await prisma.aiChat.createMany({ data: Array.from({ length: 42 }, (_, i) => ({ organizationId: org.id, profileId: other.id, title: `Earlier conversation ${i}` })) });
  const page = await get(other, '/assistant'); assert.match(page.text, /Older chats/);
  const older = await get(other, '/assistant?historyPage=2'); assert.match(older.text, /Newer chats/);
  answer({ answer: '<script>alert(1)</script>', confident: true });
  const out = await ask(agent, { question: '<img src=x onerror=alert(1)>' });
  const escaped = await get(agent, `/assistant?chat=${out.body.chat.id}`);
  assert.doesNotMatch(escaped.text, /<script>alert\(1\)<\/script>|<img src=x onerror=/);
  assert.match(escaped.text, /&lt;script&gt;/);
});

test('owner deletion cascades messages while other conversations remain', async () => {
  const count = await prisma.aiChat.count({ where: { profileId: agent.id } });
  const res = await request(app).post(`/assistant/chats/${savedChat.id}/delete`).set('Cookie', cookies[agent.id]).set('Accept', 'application/json');
  assert.equal(res.status, 200);
  assert.equal(await prisma.aiChatMessage.count({ where: { chatId: savedChat.id } }), 0);
  assert.equal(await prisma.aiChat.count({ where: { profileId: agent.id } }), count - 1);
});
