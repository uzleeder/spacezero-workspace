'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');

// Replace the SDK's client before lib/gemini loads so no test ever touches the network.
let calls = 0;
let behaviour = () => ({ text: '{"ok":true}' });
class FakeGoogleGenAI {
  constructor() {
    this.models = { generateContent: async () => { calls += 1; return behaviour(calls); } };
  }
}
process.env.GEMINI_API_KEY = 'test-key';
process.env.GEMINI_TIMEOUT_MS = '60';
const sdk = require('@google/genai');
sdk.GoogleGenAI = FakeGoogleGenAI;
const { generateStructured, generateText, GeminiError } = require('../lib/gemini');

const zodSchema = z.object({ ok: z.boolean() });
const request = { contents: 'x', responseSchema: { type: 'OBJECT' }, zodSchema };
const rateLimited = () => Object.assign(new Error('rate limited'), { status: 429 });

beforeEach(() => { calls = 0; behaviour = () => ({ text: '{"ok":true}' }); });

test('returns Zod-validated data and model version on success', async () => {
  behaviour = () => ({ text: '{"ok":true}', modelVersion: 'fake-1' });
  const result = await generateStructured(request);
  assert.deepEqual(result.data, { ok: true });
  assert.equal(result.modelVersion, 'fake-1');
  assert.equal(calls, 1);
});

test('malformed JSON is retried and then recovers', async () => {
  behaviour = (n) => (n === 1 ? { text: 'not json {' } : { text: '{"ok":true}' });
  const result = await generateStructured(request);
  assert.deepEqual(result.data, { ok: true });
  assert.equal(calls, 2);
});

test('a response that violates the schema is asked for once more, then fails as non-retryable', async () => {
  behaviour = () => ({ text: '{"ok":"maybe"}' });
  await assert.rejects(() => generateStructured(request), (err) => err instanceof GeminiError && err.retryable === false && /schema validation/.test(err.message));
  assert.equal(calls, 2);
});

test('a malformed answer followed by a valid one succeeds (safe retry) and reports the task and prompt version', async () => {
  behaviour = (n) => (n === 1 ? { text: '{"ok":"maybe"}' } : { text: '{"ok":true}' });
  const result = await generateStructured({ ...request, task: 'analysis.extract', promptVersion: 'analysis.extract@2' });
  assert.deepEqual(result.data, { ok: true });
  assert.equal(calls, 2);
  assert.equal(result.task, 'analysis.extract');
  assert.equal(result.promptVersion, 'analysis.extract@2');
});

test('rate limiting (429) is retried with backoff and then succeeds', async () => {
  behaviour = (n) => { if (n < 3) throw rateLimited(); return { text: '{"ok":true}' }; };
  const result = await generateStructured(request);
  assert.deepEqual(result.data, { ok: true });
  assert.equal(calls, 3);
});

test('persistent rate limiting stops after the retry budget and reports a retryable error', async () => {
  behaviour = () => { throw rateLimited(); };
  await assert.rejects(() => generateStructured(request), (err) => err instanceof GeminiError && err.retryable === true);
  assert.equal(calls, 3);
});

test('non-transient API errors (e.g. 400/401) are not retried', async () => {
  behaviour = () => { throw Object.assign(new Error('API key not valid'), { status: 401 }); };
  await assert.rejects(() => generateStructured(request), (err) => err instanceof GeminiError && err.retryable === false);
  assert.equal(calls, 1);
});

test('a hung request times out and is treated as retryable', async () => {
  behaviour = () => new Promise(() => {});
  await assert.rejects(() => generateStructured(request), (err) => err instanceof GeminiError && err.retryable === true && /timed out/.test(err.message));
  assert.equal(calls, 3);
});

test('generateText uses the same retry policy', async () => {
  behaviour = (n) => { if (n === 1) throw rateLimited(); return { text: 'hello', modelVersion: 'fake-2' }; };
  const result = await generateText({ contents: 'hi' });
  assert.equal(result.text, 'hello');
  assert.equal(calls, 2);
});

test('missing API key fails fast with a clear, non-retryable error', async () => {
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  // Fresh module instance so the cached client from earlier tests is not reused.
  delete require.cache[require.resolve('../lib/gemini')];
  const fresh = require('../lib/gemini');
  await assert.rejects(() => fresh.generateStructured(request), (err) => err.name === 'GeminiError' && err.retryable === false && /GEMINI_API_KEY/.test(err.message));
  assert.equal(calls, 0);
  process.env.GEMINI_API_KEY = saved;
});
