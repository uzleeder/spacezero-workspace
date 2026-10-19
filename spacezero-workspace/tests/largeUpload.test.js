'use strict';
// Large files, unsupported formats and corrupted audio on the private upload paths.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');

mock.method(require('../lib/gemini'), 'generateStructured', async () => { throw new Error('Gemini must not be called in these tests'); });

const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const app = require('../server');

let org, admin, sup, course, module_, cookies = {};

function wav(seconds) {
  const bytes = 8000 * 2 * seconds;
  const data = Buffer.alloc(44 + bytes); data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(bytes, 40);
  return data;
}

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Upload tests' } });
  async function user(role, name) {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `UP ${name}`, username: `up_${org.id}_${name}`, email: `up_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
    const token = generateToken();
    await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
    cookies[p.id] = `sz_session=${token.raw}`;
    return p;
  }
  admin = await user('ADMIN', 'admin'); sup = await user('SUPERVISOR', 'sup');
  course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Upload course', createdById: admin.id, modules: { create: { title: 'Long recording', contentType: 'AUDIO' } } }, include: { modules: true } });
  module_ = course.modules[0];
});
after(async () => { mock.restoreAll(); await prisma.$disconnect(); });

test('a large training recording (about 25 MB, 26 minutes) uploads, stays private, and its duration is measured server-side', async () => {
  const big = wav(1700); // ~27 MB
  assert.ok(big.length > 25 * 1024 * 1024);
  const res = await request(app).post(`/admin/training/${course.id}/modules/${module_.id}/file`).set('Cookie', cookies[admin.id]).attach('file', big, { filename: 'long.wav', contentType: 'audio/wav' });
  assert.equal(res.status, 302);
  const stored = await prisma.trainingModule.findUnique({ where: { id: module_.id } });
  assert.ok(stored.storagePath && !stored.storagePath.startsWith('/') && !stored.storagePath.includes('..'));
  assert.equal(JSON.parse(stored.sourceRefJson).durationSeconds, 1700);
  // the learner-facing file route is not an open static file
  assert.ok([401, 302, 403, 404].includes((await request(app).get(`/training-file/${module_.id}`)).status));
  assert.equal((await request(app).get(`/static/${stored.storagePath}`)).status === 200, false);
  assert.equal((await request(app).get(`/training-file/${module_.id}`).set('Cookie', cookies[admin.id])).status, 200);
});

test('unsupported formats, forged audio and supervisors are rejected on training-source and call uploads', async () => {
  const path = `/admin/training/${course.id}/modules/${module_.id}/file`;
  const before = (await prisma.trainingModule.findUnique({ where: { id: module_.id } })).storagePath;
  const exe = await request(app).post(path).set('Cookie', cookies[admin.id]).attach('file', Buffer.from('MZ\x90\x00 not audio'), { filename: 'run.exe', contentType: 'application/octet-stream' });
  assert.equal(exe.status, 400);
  const forged = await request(app).post(path).set('Cookie', cookies[admin.id]).attach('file', Buffer.from('this is plain text, not a wav file at all'), { filename: 'fake.wav', contentType: 'audio/wav' });
  assert.equal(forged.status, 400);
  assert.equal((await prisma.trainingModule.findUnique({ where: { id: module_.id } })).storagePath, before); // nothing replaced
  assert.ok([403, 404].includes((await request(app).post(path).set('Cookie', cookies[sup.id]).attach('file', wav(2), { filename: 'a.wav', contentType: 'audio/wav' })).status));

  const call = (buf, name, type = 'audio/wav') => request(app).post('/ai-practice/calls').set('Cookie', cookies[admin.id]).field('mode', 'BEST_PRACTICE').field('authorized', 'yes').attach('calls', buf, { filename: name, contentType: type });
  assert.equal((await call(Buffer.from('not audio'), 'call.wav')).status, 400);                  // corrupted / forged
  assert.equal((await call(Buffer.from('MZ....'), 'call.exe', 'application/octet-stream')).status, 400); // unsupported format
  assert.equal(await prisma.callBatch.count({ where: { organizationId: org.id } }), 0);          // nothing half-created
  const big = await call(wav(2400), 'long-call.wav');                                              // a 38 MB, 40-minute call
  assert.equal(big.status, 302);
  const recording = await prisma.callRecording.findFirst({ where: { callBatch: { organizationId: org.id } } });
  assert.equal(recording.durationSeconds, 2400); assert.equal(recording.status, 'UPLOADED');
  // upload only SAVES; authorization for AI processing is required when the analysis is started
  const batch = await prisma.callBatch.findFirst({ where: { organizationId: org.id } });
  assert.equal(batch.analysisRequestedAt, null);
  const noConsent = await request(app).post(`/ai-practice/calls/${batch.id}/analyze`).set('Cookie', cookies[admin.id]).type('form').send({ purpose: 'BEST_PRACTICE' });
  assert.match(noConsent.headers.location, /error=/);
  assert.equal((await prisma.callBatch.findUnique({ where: { id: batch.id } })).analysisRequestedAt, null);
  const consent = await request(app).post(`/ai-practice/calls/${batch.id}/analyze`).set('Cookie', cookies[admin.id]).type('form').send({ purpose: 'BEST_PRACTICE', authorized: 'yes' });
  assert.equal(consent.status, 302);
  assert.ok((await prisma.callBatch.findUnique({ where: { id: batch.id } })).analysisRequestedAt);
});

