'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { sendAccountEmail, sendEmailMessage, isEmailConfigured } = require('../lib/mailer');
const original = { ...process.env };
after(() => { for (const key of ['RESEND_API_KEY', 'RESEND_FROM', 'APP_ORIGIN']) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; } });

test('Resend sends invitation and reset links using server-side configuration', async t => {
  process.env.RESEND_API_KEY = 'test-key';
  process.env.RESEND_FROM = 'Academy <test@example.invalid>';
  process.env.APP_ORIGIN = 'https://academy.example.invalid';
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.resend.com/emails');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    sent.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ id: 'test-email' }) };
  });
  assert.equal(isEmailConfigured(), true);
  await sendAccountEmail('recipient@example.invalid', 'test-token', 'invite');
  await sendAccountEmail('recipient@example.invalid', 'reset-token', 'reset');
  assert.match(sent[0].text, /https:\/\/academy.example.invalid\/accept-invite\/test-token/);
  assert.match(sent[1].text, /https:\/\/academy.example.invalid\/reset-password\/reset-token/);
  assert.deepEqual(sent[0].to, ['recipient@example.invalid']);
  assert.ok(!JSON.stringify(sent).includes('test-key'));
});

test('Resend failures are sanitized and never mistaken for acceptance', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 403 }));
  await assert.rejects(sendAccountEmail('recipient@example.invalid', 'secret-token', 'invite'), /^Error: Resend rejected email \(HTTP 403\)$/);
});

test('training mail passes a stable idempotency header and checks provider acceptance', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.headers['Idempotency-Key'], 'training-fixture-1');
    assert.deepEqual(JSON.parse(options.body).to, ['learner@example.invalid']);
    return { ok: true, json: async () => ({ id: 'accepted-training-message' }) };
  });
  const result = await sendEmailMessage({ to: 'learner@example.invalid', subject: 'Training assigned', text: 'Open your training.' }, { idempotencyKey: 'training-fixture-1' });
  assert.equal(result.id, 'accepted-training-message');
});
