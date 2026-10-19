'use strict';
// Call analysis reliability: bad AI timestamps are dropped, not fatal; total nonsense is retried.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');

let moments = [];
mock.method(require('../lib/gemini'), 'generateStructured', async (input) => {
  if (input.responseSchema.properties.strengths) {
    return { modelVersion: 'test-model', data: { title: 'Call lessons', summary: 'Why it worked.', strengths: ['Discovery'], weaknesses: [], objectives: ['Hold price'], skills: [{ name: 'Objection Handling', score: 80, evidence: 'Held price' }], moments, practices: ['ROLEPLAY'] } };
  }
  throw new Error('unexpected Gemini call');
});
const { prisma } = require('../lib/prisma');
const { runCallBatch } = require('../lib/callIntelligence');

let org, admin;
before(async () => {
  org = await prisma.organization.create({ data: { name: 'Call moment tests' } });
  admin = await prisma.profile.create({ data: { organizationId: org.id, fullName: 'CM admin', username: `cm_${org.id}`, email: `cm_${org.id}@example.invalid`, role: 'ADMIN', status: 'ACTIVE', employmentStartDate: new Date() } });
});
after(async () => { mock.restoreAll(); await prisma.$disconnect(); });

async function batchWith(recordingCount) {
  return prisma.callBatch.create({ data: { organizationId: org.id, uploadedById: admin.id, mode: 'BEST_PRACTICE', status: 'UPLOADED', recordings: { create: Array.from({ length: recordingCount }, (_, i) => ({ storagePath: `calls/none-${i}.wav`, mimeType: 'audio/wav', durationSeconds: 60, status: 'TRANSCRIBED', transcriptText: '0s Agent: Hello' })) } }, include: { recordings: true } });
}

test('a timestamp outside the recording is dropped, a missing recording id is repaired when there is only one call, and the analysis still completes', async () => {
  const batch = await batchWith(1);
  const id = batch.recordings[0].id;
  moments = [
    { recordingId: id, seconds: 30, observation: 'Good discovery' },
    { recordingId: id, seconds: 900, observation: 'Beyond the end of a 60 second call' },
    { recordingId: 'made-up-id', seconds: 45, observation: 'Closing' },
    { recordingId: id, seconds: 61, observation: 'Two seconds of slack is tolerated and clamped' },
  ];
  await runCallBatch(batch.id);
  const done = await prisma.callBatch.findUnique({ where: { id: batch.id } });
  assert.equal(done.status, 'READY_FOR_REVIEW');
  const report = JSON.parse(done.aggregatedAnalysisJson);
  assert.deepEqual(report.moments.map((m) => [m.recordingId, m.seconds]), [[id, 30], [id, 45], [id, 60]]);
  assert.ok(report.moments.every((m) => m.seconds <= 60));
});

test('if every timestamp is unusable across several recordings the batch fails cleanly and can be retried', async () => {
  const batch = await batchWith(2);
  moments = [{ recordingId: 'nope', seconds: 10, observation: 'x' }, { recordingId: 'nope-2', seconds: 20, observation: 'y' }];
  await runCallBatch(batch.id);
  const failed = await prisma.callBatch.findUnique({ where: { id: batch.id }, include: { recordings: true } });
  assert.equal(failed.status, 'FAILED'); assert.equal(failed.retryCount, 1); assert.match(failed.errorMessage, /Analysis failed/);
  assert.ok(failed.recordings.every((r) => r.status === 'TRANSCRIBED' && r.transcriptText)); // transcripts are preserved
  moments = [{ recordingId: failed.recordings[0].id, seconds: 5, observation: 'ok' }];
  await prisma.callBatch.update({ where: { id: batch.id }, data: { status: 'UPLOADED', errorMessage: null } });
  await runCallBatch(batch.id);
  assert.equal((await prisma.callBatch.findUnique({ where: { id: batch.id } })).status, 'READY_FOR_REVIEW');
});
