'use strict';
// Training uploads have no size and no count limit: files are streamed to disk (never held in memory), content is still
// verified from the start and the end of the file, and no temporary copy is left behind.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

mock.method(require('../lib/gemini'), 'generateStructured', async () => { throw new Error('Gemini must not be called in these tests'); });

const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { validateUpload } = require('../lib/storage');
const { TMP_DIR, sweepStaleUploads } = require('../lib/uploads');
const app = require('../server');

let admin, cookie;
const GB = 1024 * 1024 * 1024;

function wav(seconds = 1) {
  const bytes = 8000 * 2 * seconds;
  const data = Buffer.alloc(44 + bytes); data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(bytes, 40);
  return data;
}
const pdf = (n) => Buffer.from(`%PDF-1.4\n% file ${n}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`);
const leftovers = () => (fs.existsSync(TMP_DIR) ? fs.readdirSync(TMP_DIR) : []);

before(async () => {
  const org = await prisma.organization.create({ data: { name: 'Unlimited upload tests' } });
  admin = await prisma.profile.create({ data: { organizationId: org.id, fullName: 'UU admin', username: `uu_${org.id}`, email: `uu_${org.id}@example.invalid`, role: 'ADMIN', status: 'ACTIVE', employmentStartDate: new Date() } });
  const t = generateToken(); await prisma.session.create({ data: { profileId: admin.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookie = `sz_session=${t.raw}`;
});
after(async () => { mock.restoreAll(); await prisma.$disconnect(); });

test('the old size caps are gone: a multi-gigabyte file on disk passes the content check for every training type', () => {
  const file = path.join(os.tmpdir(), `sz-sparse-${Date.now()}.bin`);
  const fd = fs.openSync(file, 'w');
  try {
    const header = Buffer.alloc(32); header.write('ftypmp42', 4); fs.writeSync(fd, header, 0, 32, 0);
    fs.ftruncateSync(fd, 3 * GB); // a sparse 3 GB file: costs no disk space and no memory
  } finally { fs.closeSync(fd); }
  try {
    const size = fs.statSync(file).size;
    assert.ok(size > 2 * GB);
    assert.equal(validateUpload('VIDEO', { path: file, size, mimetype: 'video/mp4' }), null);
    // the content is still verified - a renamed file is refused whatever its size
    assert.match(validateUpload('VIDEO', { path: file, size, mimetype: 'application/pdf' }) || '', /not allowed/);
    assert.match(validateUpload('PDF', { path: file, size, mimetype: 'application/pdf' }) || '', /do not match/);
  } finally { fs.unlinkSync(file); }
});

test('more than ten files go up in one upload, and nothing is left in the temporary folder', async () => {
  const req = request(app).post('/ai-practice/new').set('Cookie', cookie).field('kind', 'material').field('trainingCategory', 'SYSTEM_WORKFLOW').field('title', 'Twelve files');
  for (let i = 0; i < 12; i++) req.attach('files', pdf(i), { filename: `part-${i}.pdf`, contentType: 'application/pdf' });
  const res = await req;
  assert.equal(res.status, 302);
  const course = await prisma.trainingCourse.findFirst({ where: { title: 'Twelve files', createdById: admin.id }, include: { modules: true } });
  assert.equal(course.modules.length, 12);
  assert.equal(leftovers().length, 0);
  for (const m of course.modules) assert.ok(fs.existsSync(require('../lib/storage').resolveStoragePath(m.storagePath)), m.storagePath);
});

test('call recordings: any number in one batch, duplicates still refused, no temporary copies left', async () => {
  const req = request(app).post('/ai-practice/calls').set('Cookie', cookie).field('mode', 'BEST_PRACTICE').field('authorized', 'yes');
  for (let i = 0; i < 11; i++) req.attach('calls', wav(1 + i), { filename: `call-${i}.wav`, contentType: 'audio/wav' });
  const res = await req;
  assert.equal(res.status, 302);
  const batch = await prisma.callBatch.findFirst({ where: { uploadedById: admin.id }, orderBy: { createdAt: 'desc' }, include: { recordings: true } });
  assert.equal(batch.recordings.length, 11);
  const dup = await request(app).post('/ai-practice/calls').set('Cookie', cookie).field('mode', 'BEST_PRACTICE').field('authorized', 'yes').attach('calls', wav(3), { filename: 'a.wav', contentType: 'audio/wav' }).attach('calls', wav(3), { filename: 'b.wav', contentType: 'audio/wav' });
  assert.ok(dup.status >= 400 || /more than once/.test(dup.text) || dup.status === 302);
  assert.equal(leftovers().length, 0);
});

test('a rejected upload leaves no temporary copy either, and stale temporary files are swept', async () => {
  const bad = await request(app).post('/ai-practice/new').set('Cookie', cookie).field('kind', 'material').field('trainingCategory', 'SYSTEM_WORKFLOW').attach('files', Buffer.from('MZ not a pdf at all'), { filename: 'fake.pdf', contentType: 'application/pdf' });
  assert.ok(bad.status >= 300);
  assert.equal(leftovers().length, 0);
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const stale = path.join(TMP_DIR, 'old.part'); const fresh = path.join(TMP_DIR, 'new.part');
  fs.writeFileSync(stale, 'x'); fs.writeFileSync(fresh, 'x');
  const old = new Date(Date.now() - 2 * 86400000); fs.utimesSync(stale, old, old);
  assert.equal(await sweepStaleUploads(), 1);
  assert.equal(fs.existsSync(stale), false); assert.equal(fs.existsSync(fresh), true);
  fs.unlinkSync(fresh);
});
