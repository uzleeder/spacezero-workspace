'use strict';
// Every refusal a browser receives is the branded page (right headline, the real reason, a way back), not a bare line of
// text on a white page and not "Something went wrong" for something that has a clear explanation. Non-page callers
// (no Accept header, JSON, files) keep their plain answers.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const errorPages = require('../lib/errorPages');
const realApp = require('../server');

// A tiny app wired the way server.js wires it, with the real templates.
const mini = express();
mini.set('view engine', 'ejs'); mini.set('views', path.join(__dirname, '..', 'views'));
mini.locals.asset = (p) => p;
mini.use((req, res, next) => { res.locals.theme = 'light'; next(); });
mini.use(errorPages.friendlyErrors);
mini.get('/conflict', (req, res) => res.status(409).send('Only pending requests can be cancelled.'));
mini.get('/bare404', (req, res) => res.status(404).send('Not found'));
mini.get('/bare403', (req, res) => res.status(403).send('Forbidden'));
mini.get('/badrequest', (req, res) => res.status(400).send('Select a team'));
mini.get('/limited', (req, res) => res.status(429).send('Too many requests. Try again later.'));
mini.get('/rendered', (req, res) => res.status(409).render('error', { layout: false, message: 'This analysis is not ready.', action: { label: 'Open the analysis', href: '/ai-practice/x' } }));
mini.get('/boom', () => { throw new Error('secret database detail'); });
mini.get('/file', (req, res) => res.status(404).send('Not found'));
mini.use(errorPages.handleNotFound);
mini.use(errorPages.handleError);

const html = { Accept: 'text/html,application/xhtml+xml' };
const asBrowser = (url) => request(mini).get(url).set(html).set('Host', 'workspace.test');

test('a plain-text refusal becomes the branded page with the right headline and the real reason', async () => {
  const res = await asBrowser('/conflict');
  assert.equal(res.status, 409);
  assert.match(res.text, /<h1>This can&#39;t be done right now<\/h1>/);
  assert.match(res.text, /Only pending requests can be cancelled\./);
  assert.match(res.text, /Back to dashboard/);
  assert.doesNotMatch(res.text, /Something went wrong/);
  assert.match((await asBrowser('/badrequest')).text, /<h1>That didn&#39;t work<\/h1>[\s\S]*Select a team/);
  assert.match((await asBrowser('/limited')).text, /<h1>Too many attempts<\/h1>/);
});

test('bare "Not found" / "Forbidden" get the standard 404 / access-denied pages', async () => {
  assert.match((await asBrowser('/bare404')).text, /<h1>Page not found<\/h1>/);
  assert.match((await asBrowser('/bare403')).text, /<h1>Access denied<\/h1>/);
  assert.match((await asBrowser('/nowhere')).text, /<h1>Page not found<\/h1>/);
});

test('"Go back" points to the page the person came from - same site only, never the failing page itself', async () => {
  const back = await asBrowser('/conflict').set('Referer', 'http://workspace.test/leave?status=pending');
  assert.match(back.text, /href="\/leave\?status=pending"[^>]*data-error-back>Go back</);
  assert.doesNotMatch((await asBrowser('/conflict').set('Referer', 'http://evil.example/leave')).text, /data-error-back/);
  assert.doesNotMatch((await asBrowser('/conflict').set('Referer', 'http://workspace.test/conflict')).text, /data-error-back/);
  assert.doesNotMatch((await asBrowser('/conflict')).text, /data-error-back/);
});

test('a route that renders its own error keeps its message and next-step button, with a headline that matches the status', async () => {
  const res = await asBrowser('/rendered').set('Referer', 'http://workspace.test/ai-practice');
  assert.match(res.text, /<h1>This can&#39;t be done right now<\/h1>/);
  assert.match(res.text, /This analysis is not ready\./);
  assert.match(res.text, /href="\/ai-practice\/x"[^>]*data-error-action>Open the analysis</);
  assert.match(res.text, /data-error-back>Go back</);
});

test('callers that are not browser pages keep plain answers', async () => {
  assert.equal((await request(mini).get('/conflict')).text, 'Only pending requests can be cancelled.');   // no Accept header
  assert.equal((await request(mini).get('/bare404').set('Accept', 'image/*')).text, 'Not found');          // an image request
  assert.deepEqual((await request(mini).get('/nowhere').set('Accept', 'application/json')).body, { error: 'Not found' });
  assert.equal((await request(mini).get('/static/missing.png').set(html)).text, '');                         // missing static file: empty 404
});

test('an unexpected error shows a reference and never the internal detail', async () => {
  const res = await asBrowser('/boom');
  assert.equal(res.status, 500);
  assert.match(res.text, /<h1>Something went wrong<\/h1>/);
  assert.match(res.text, /Reference: <strong>[0-9a-f]{8}<\/strong>/);
  assert.doesNotMatch(res.text, /secret database detail/);
  const json = await request(mini).get('/boom').set('Accept', 'application/json');
  assert.equal(json.status, 500); assert.match(json.body.reference, /^[0-9a-f]{8}$/); assert.doesNotMatch(JSON.stringify(json.body), /secret/);
});

// ---- the real application ----------------------------------------------------------------------------------------
let admin, sup, cookies = {}, course;
before(async () => {
  const org = await prisma.organization.create({ data: { name: 'Error pages tests' } });
  const mk = async (role, name) => {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: name, username: `ep_${org.id}_${name}`, email: `ep_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
    const t = generateToken(); await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookies[p.id] = `sz_session=${t.raw}`;
    return p;
  };
  admin = await mk('ADMIN', 'admin'); sup = await mk('SUPERVISOR', 'sup');
  course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Admin only course', createdById: admin.id, status: 'DRAFT' } });
});
after(async () => { await prisma.$disconnect(); });

test('in the real app a Supervisor who opens someone else\'s training sees the not-found page with a way back, not a line of text', async () => {
  const url = `/admin/training/${course.id}/delete`;
  const browser = await request(realApp).get(url).set('Cookie', cookies[sup.id]).set(html).set('Referer', `http://127.0.0.1/admin/training`);
  assert.equal(browser.status, 404);
  assert.match(browser.text, /<h1>Page not found<\/h1>/);
  assert.equal((await request(realApp).get(url).set('Cookie', cookies[sup.id])).text, 'Not found'); // a script still gets the plain answer
  const noAccess = await request(realApp).get('/admin/employees').set('Cookie', cookies[sup.id]).set(html);
  assert.equal(noAccess.status, 403);
  assert.match(noAccess.text, /<h1>Access denied<\/h1>/);
  assert.match(noAccess.text, /Back to dashboard/);
});
