'use strict';
// Behind the reverse proxy every colleague arrives from one IP address. The sign-in / password limiter
// must therefore count per PERSON, so a busy shift start never locks the whole company out - while one
// account being hammered is still stopped.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const app = require('../server');

const login = (identifier) => request(app).post('/login').type('form').send({ identifier, password: 'wrong-password', companyCode: 'SPACE0' });

test('50 different colleagues signing in from the same address are never throttled by each other', async () => {
  const tag = `rl${Date.now()}`;
  const statuses = [];
  for (let i = 0; i < 50; i += 1) statuses.push((await login(`${tag}_user_${i}`)).status);
  assert.ok(statuses.every((s) => s !== 429), 'nobody got "Too many requests"');
});

test('one account being hammered is still stopped', async () => {
  const who = `hammer${Date.now()}`;
  let blocked = false;
  for (let i = 0; i < 45 && !blocked; i += 1) blocked = (await login(who)).status === 429;
  assert.ok(blocked, 'repeated attempts on the same account are refused');
  assert.equal((await login(`someone_else_${Date.now()}`)).status !== 429, true, 'while others are unaffected');
});

test('the bucket never stores the session cookie itself', async () => {
  const secret = `secretcookie${Date.now()}`;
  await request(app).post('/forgot-password').set('Cookie', `sz_session=${secret}`).type('form').send({});
  const rows = await prisma.rateLimitAttempt.findMany({ where: { bucketKey: { startsWith: 'sensitive:session:' } } });
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => !r.bucketKey.includes(secret)));
});
