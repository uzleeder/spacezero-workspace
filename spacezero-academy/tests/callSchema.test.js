'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { reportResponse, reportSchema } = require('../lib/callIntelligence');
const { prisma } = require('../lib/prisma');

// Regression: live testing showed Gemini returns free-form labels for `practices` unless the
// provider-side schema constrains it to the same enum Zod validates, which failed real batches.
test('practice recommendations are enum-constrained on the Gemini side, not only in Zod', () => {
  const items = reportResponse.properties.practices.items;
  assert.deepEqual(items.enum, ['QUIZ', 'ROLEPLAY', 'VOICE', 'TECHNICAL', 'PROCESS_SIM', 'PRODUCT_KNOWLEDGE']);
});

test('the analysis prompt pins skill scores to a 0-100 scale', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'callIntelligence.js'), 'utf8');
  assert.match(source, /0-100 scale/);
});

test('a report with an unsupported practice label is rejected by validation', () => {
  const bad = { title: 't', summary: 's', strengths: [], weaknesses: [], objectives: ['o'], skills: [{ name: 'a', score: 50, evidence: 'e' }], moments: [], practices: ['Role-play (sales)'] };
  assert.equal(reportSchema.safeParse(bad).success, false);
});

test('call recordings are stored outside any publicly served directory', () => {
  const storage = require('../lib/storage');
  const publicDir = path.resolve(__dirname, '..', 'public');
  const resolved = storage.resolveStoragePath('calls/example.wav');
  assert.ok(!resolved.startsWith(publicDir), 'call storage must never live under public/');
});

test.after(async () => { await prisma.$disconnect(); });
