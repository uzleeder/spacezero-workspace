'use strict';
// SpaceZero AI — read-only Q&A over data already inside SpaceZero. The priority here is
// authorization (spec's own "CRITICAL: do authorization BEFORE providing records to the AI"):
// every test captures exactly what lib/gemini.js#generateStructured was called with and asserts
// on THAT payload, so we are testing what the model actually received, not just the HTTP response.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { hashPassword } = require('../lib/password');
const gemini = require('../lib/gemini');
const app = require('../server');

let org, admin, sup1, sup2, agent1, agent2, cookies = {};
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);

let calls = [];
function mockGemini(impl) {
  calls = [];
  mock.method(gemini, 'generateStructured', async (args) => {
    calls.push(args);
    return impl ? impl(args) : { data: { answer: 'Test answer covering the given facts.', confident: true }, modelVersion: 'test' };
  });
}

async function makeUser(role, name) {
  const passwordHash = await hashPassword('Correct-Horse-9!');
  const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `SZ ${name}`, username: `sz_${org.id}_${name}`, email: `sz_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', passwordHash, employmentStartDate: new Date() } });
  const token = generateToken();
  await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
  cookies[p.id] = `sz_session=${token.raw}`;
  return p;
}

before(async () => {
  org = await prisma.organization.create({ data: { name: 'SpaceZero AI tests' } });
  admin = await makeUser('ADMIN', 'admin');
  sup1 = await makeUser('SUPERVISOR', 'sup1'); sup2 = await makeUser('SUPERVISOR', 'sup2');
  agent1 = await makeUser('TRAVEL_AGENT', 'agent1'); agent2 = await makeUser('TRAVEL_AGENT', 'agent2');
  await prisma.supervisorAssignment.create({ data: { supervisorId: sup1.id, agentId: agent1.id, assignedById: admin.id } });
  await prisma.supervisorAssignment.create({ data: { supervisorId: sup2.id, agentId: agent2.id, assignedById: admin.id } });
});
after(async () => { mock.restoreAll(); await prisma.$disconnect(); });

test('AUTH REQUIRED: an anonymous request cannot reach the assistant', async () => {
  const res = await request(app).get('/assistant');
  assert.equal(res.status, 302); // redirected to login, never a bare 200
});

test('GET /assistant renders the ask form for an authenticated session', async () => {
  const res = await get(admin, '/assistant');
  assert.equal(res.status, 200);
  assert.match(res.text, /Ask Space AI/);
});

test('ADMIN SCOPE: facts sent to Gemini include both teams\' agents, and are organization-scoped', async () => {
  mockGemini();
  const res = await post(admin, '/assistant/ask', { question: 'Who needs setup?' });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  const facts = JSON.parse(calls[0].contents.split('FACTS (JSON — the only information you may use):\n')[1].split('\n\nQUESTION:')[0]);
  const names = facts.people.map((p) => p.name);
  assert.ok(names.includes('SZ agent1'));
  assert.ok(names.includes('SZ agent2'));
});

test('SUPERVISOR SCOPE: sup1\'s facts include ONLY their own agent, never sup2\'s', async () => {
  mockGemini();
  const res = await post(sup1, '/assistant/ask', { question: 'Who on my team needs setup?' });
  assert.equal(res.status, 200);
  const facts = JSON.parse(calls[0].contents.split('FACTS (JSON — the only information you may use):\n')[1].split('\n\nQUESTION:')[0]);
  const names = facts.people.map((p) => p.name);
  assert.deepEqual(names, ['SZ agent1']);
  assert.ok(!names.includes('SZ agent2'), 'sup1 must never see sup2\'s agent, even inside the facts sent to the model');
});

test('EMPLOYEE SCOPE: an ordinary employee\'s facts contain only themself', async () => {
  mockGemini();
  const res = await post(agent1, '/assistant/ask', { question: 'What requires my attention today?' });
  assert.equal(res.status, 200);
  const facts = JSON.parse(calls[0].contents.split('FACTS (JSON — the only information you may use):\n')[1].split('\n\nQUESTION:')[0]);
  assert.equal(facts.people.length, 1);
  assert.equal(facts.people[0].name, 'SZ agent1');
});

test('NO CREDENTIAL DATA: the facts payload never contains a credential-shaped field', async () => {
  mockGemini();
  await post(admin, '/assistant/ask', { question: 'Summarize the team.' });
  const raw = calls[0].contents;
  // Checklist labels can mention Credential Vault. Secret fields and actual values cannot be sent.
  for (const forbidden of ['payloadEnc', 'passwordHash', 'tokenHash', 'credentials']) {
    assert.doesNotMatch(raw, new RegExp('"' + forbidden + '"\\s*:', 'i'));
  }
  for (const p of [admin, sup1, sup2, agent1, agent2]) assert.equal(raw.includes(p.passwordHash), false, 'password hashes never enter facts');
  for (const cookie of Object.values(cookies)) assert.equal(raw.includes(cookie.split('=')[1]), false, 'session tokens never enter facts');
});

test('CONFIDENT ANSWER: renders the model\'s answer text', async () => {
  mockGemini(() => ({ data: { answer: 'Two employees still need setup.', confident: true }, modelVersion: 'test' }));
  const res = await post(admin, '/assistant/ask', { question: 'Who needs setup?' });
  assert.match(res.text, /Two employees still need setup\./);
});

test('NOT CONFIDENT: shows the honest "not enough data" state, never invents an answer', async () => {
  mockGemini(() => ({ data: { answer: "I don't have enough information.", confident: false }, modelVersion: 'test' }));
  const res = await post(admin, '/assistant/ask', { question: 'What color is the sky?' });
  assert.match(res.text, /find enough SpaceZero data/);
});

test('GEMINI FAILURE: a thrown error produces the safe empty-state, never a stack trace or 500', async () => {
  mock.method(gemini, 'generateStructured', async () => { throw new gemini.GeminiError('simulated failure'); });
  const res = await post(admin, '/assistant/ask', { question: 'Who needs setup?' });
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /at Object|at async|GeminiError/);
  assert.match(res.text, /technical problem/);
  assert.match(res.text, /https:\/\/t\.me\/si_leeder/);
});

test('EMPTY QUESTION is rejected without calling Gemini', async () => {
  mockGemini();
  const res = await post(admin, '/assistant/ask', { question: '   ' });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test('AUDIT: every question is logged with a preview, never the full facts or answer', async () => {
  mockGemini();
  await prisma.auditLog.deleteMany({ where: { organizationId: org.id, action: 'assistant.question_asked' } });
  await post(admin, '/assistant/ask', { question: 'Who needs setup today specifically?' });
  const entry = await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'assistant.question_asked', actorId: admin.id } });
  assert.ok(entry);
  const meta = JSON.parse(entry.metadataJson);
  assert.equal(meta.questionPreview, 'Who needs setup today specifically?');
  assert.equal(typeof meta.confident, 'boolean');
});

test('RATE LIMIT: repeated questions in a short window are eventually blocked', async () => {
  mockGemini();
  let blocked = false;
  for (let i = 0; i < 25; i += 1) {
    const res = await post(agent2, '/assistant/ask', { question: `Question number ${i}` });
    if (res.status === 429) { blocked = true; break; }
  }
  assert.ok(blocked, 'expected the assistant endpoint to rate-limit a burst of requests from one profile');
});

test('Space AI is a button in the bottom-right corner of every page (not a menu item), and not on its own page', async () => {
  const dash = await get(admin, '/dashboard');
  assert.match(dash.text, /class="space-ai no-print" data-space-ai/);
  assert.match(dash.text, /<form method="post" action="\/assistant\/ask" enctype="multipart\/form-data" class="space-ai__form" data-ai-form>/);
  assert.doesNotMatch(dash.text, /class="sidebar-link[^"]*" href="\/assistant"/);
  assert.doesNotMatch((await get(admin, '/assistant')).text, /data-space-ai/);
});

test('the sidebar names the workspace "SpaceZero Workspace", and the Admin badge reads "Engineered by UzLeeder"', async () => {
  const dash = await get(admin, '/dashboard');
  assert.match(dash.text, /<div class="workspace-label"><span class="workspace-dot"><\/span> SpaceZero Workspace<\/div>/);
  assert.doesNotMatch(dash.text, /Above9 Travel/);
  const badge = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'js', 'uzleeder-crafted.js'), 'utf8');
  assert.match(badge, /var LABEL = "ENGINEERED BY";/); assert.doesNotMatch(badge, /"CRAFTED BY"|"Crafted by/);
});

test('the dashboard globe marks Uzbekistan and is drawn by its own script', async () => {
  const dash = await get(admin, '/dashboard');
  assert.match(dash.text, /<svg [^>]*data-globe[ >]/);
  assert.match(dash.text, />Uzbekistan<\/text>/);
  assert.match(dash.text, /\/static\/js\/hero-globe\.js/);
  const js = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'js', 'hero-globe.js'), 'utf8');
  assert.match(js, /var TAS = \{ code: 'TAS', city: 'Tashkent', at: \[69\.2812, 41\.2579\] \};/);
  for (const code of ['JFK', 'LHR', 'IST', 'DXB', 'ICN', 'DEL']) assert.match(js, new RegExp(`code: '${code}'`));
  new Function(js);   // the script parses
});

test('every role gets the SpaceZero Standard card on its dashboard, in its own words', async () => {
  const expert = await makeUser('FLIGHT_EXPERT', 'expert');
  const cases = [
    [admin, /Extraordinary service\.<br>Starts with you\./, 'href="/admin/training"', 'Manage training'],
    [sup1, /Great teams\.<br>Start with great coaching\./, 'href="/team"', 'Open my team'],
    [agent1, /Turn every call into a trip your client remembers\./, 'href="/training"', 'Continue my training'],
    [expert, /Every flight\.<br>Built with expertise\./, 'href="/training"', 'Continue my training'],
  ];
  for (const [who, line, href, action] of cases) {
    const page = (await get(who, '/dashboard')).text;
    assert.match(page, /THE SPACEZERO STANDARD/, who.role);
    assert.doesNotMatch(page, /ABOVE9 STANDARD/i, who.role);
    assert.match(page, line, who.role);
    assert.ok(page.includes(`${href} class="btn hero-btn">${action}`), who.role);
    assert.match(page, /data-world="\/static\/data\/world-countries-110m\.json/, who.role);
  }
});

test('the map file is served, with Uzbekistan in it', async () => {
  const res = await get(admin, '/static/data/world-countries-110m.json');
  assert.equal(res.status, 200);
  const topo = JSON.parse(res.text);
  assert.ok(topo.objects.countries.geometries.length > 170);
  assert.ok(topo.objects.countries.geometries.some((g) => g.id === '860' && g.properties.name === 'Uzbekistan'));
});

test('the sidebar follows the theme: the badge colour matches it, and light mode has its own sidebar styles', async () => {
  const dark = (await get(admin, '/dashboard')).text;
  const theme = /<html lang="en" data-theme="(\w+)"/.exec(dark)[1];
  assert.match(dark, new RegExp(`<uzleeder-crafted theme="${theme === 'dark' ? 'dark' : 'light'}" size="sm">`));
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf8');
  assert.match(css, /html:not\(\[data-theme="dark"\]\) \.sidebar \{ background: #ffffff;/);
});

test('abroad the globe shows only airport codes; only Uzbekistan is named in full', async () => {
  const js = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'js', 'hero-globe.js'), 'utf8');
  assert.match(js, /label\.textContent = r\.code;/);
  const dash = (await get(admin, '/dashboard')).text;
  assert.match(dash, />Uzbekistan<\/text>/); assert.match(dash, />TAS · Tashkent<\/text>/);
});

test('Space AI message box: Enter sends, and a send icon inside the box replaces the Ask button', async () => {
  for (const url of ['/dashboard', '/assistant']) {
    const page = (await get(admin, url)).text;
    assert.match(page, /<textarea [^>]*name="question"[^>]*data-enter-send/, url);
    assert.match(page, /<button type="submit" class="ai-send" aria-label="Send" title="Send \(Enter\)">/, url);
    assert.doesNotMatch(page, />Ask<\/button>/, url);
    assert.match(page, /Enter to send · Shift \+ Enter for a new line/, url);
  }
  const app = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.match(app, /e\.key !== 'Enter' \|\| e\.shiftKey \|\| e\.isComposing/);
});

test('the globe plane slows down for a landing at TAS and rolls to a stop before the fleet leaves', async () => {
  const js = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'js', 'hero-globe.js'), 'utf8');
  assert.match(js, /var ORBIT_END = 12, TOUCHDOWN = 17\.5, PARKED = 19, FLEET = 19\.6, FADE = 26\.5;/);
  assert.match(js, /u = 1 - Math\.pow\(1 - v, 1\.7\)/);   // decelerating approach
});
