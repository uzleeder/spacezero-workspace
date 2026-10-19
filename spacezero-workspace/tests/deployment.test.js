'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildConfig } = require('../deploy/vercel/build.cjs');
const { validateProductionConfig } = require('../lib/productionConfig');
test('Vercel gateway requires a backend and never caches authenticated pages', () => {
  for (const value of [undefined, 'http://localhost:3000', 'https://user:secret@example.com', 'https://example.com/path', 'https://example.com?key=secret', 'https://backend.example.invalid']) assert.throws(() => buildConfig(value));
  const config = buildConfig('https://backend.example.com');
  assert.equal(config.version, 3);
  assert.equal(config.routes[0].dest, 'https://backend.example.com/$1');
  assert.equal(config.routes[0].headers['Cache-Control'], 'private, no-store');
});
test('backend refuses a direct serverless deployment with disk-only storage', () => {
  assert.throws(() => validateProductionConfig({ VERCEL: '1' }), /Deploy deploy\/vercel/);
});
test('production import covers all business models in foreign-key order', () => {
  const metadata = require('@prisma/client').Prisma.dmmf.datamodel.models;
  const { importModels, OMIT } = require('../scripts/import-models.cjs');
  const models = importModels(metadata);
  assert.equal(models.length, metadata.length - metadata.filter(m => OMIT.has(m.name)).length);
  for (const name of ['assessment','trainingAttempt','callBatch','callRecording','mediaProgress','credential','employeeSetupItem','note']) assert.ok(models.includes(name));
  assert.ok(models.indexOf('assessment') < models.indexOf('trainingAttempt'));
  assert.ok(models.indexOf('setupRequirement') < models.indexOf('employeeSetupItem'));
});
