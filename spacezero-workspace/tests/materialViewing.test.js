'use strict';
// Library and training material: everyone can watch videos and read materials inside the app without trouble
// (the play button works, PDFs / Word / PowerPoint are readable on the page), while non-Admins cannot download
// or copy them: no download link, no raw-file page, no text selection / copy.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const AdmZip = require('adm-zip');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { saveUpload } = require('../lib/storage');
const { viewerKind } = require('../lib/materialViewer');
const app = require('../server');

let org, admin, agent, cookies = {}, items = {}, course, modules = {};
const get = (p, url, headers = {}) => request(app).get(url).set('Cookie', cookies[p.id]).set(headers);

function docx(text) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  zip.addFile('_rels/.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${text.split('\n').map((l) => `<w:p><w:r><w:t>${l}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`));
  return zip.toBuffer();
}
function pptx(text) {
  const zip = new AdmZip();
  zip.addFile('ppt/slides/slide1.xml', Buffer.from(`<p:sld><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:sld>`));
  return zip.toBuffer();
}
const mp4 = () => { const b = Buffer.alloc(5000, 1); b.write('ftypisom', 4, 'ascii'); return b; };
const pdf = () => Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Material viewing tests' } });
  const mk = async (role, name) => {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: name, username: `mv_${org.id}_${name}`, email: `mv_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
    const t = generateToken(); await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookies[p.id] = `sz_session=${t.raw}`;
    return p;
  };
  admin = await mk('ADMIN', 'admin'); agent = await mk('TRAVEL_AGENT', 'agent');
  const add = async (key, itemType, buffer, mimeType, ext) => {
    const saved = await saveUpload({ buffer, mimetype: mimeType }, `library/${org.id}`);
    items[key] = await prisma.libraryItem.create({ data: { organizationId: org.id, createdById: admin.id, title: `MV ${key}`, itemType, storagePath: ext ? saved.storagePath.replace(/\.[a-z0-9]+$/i, ext) : saved.storagePath, mimeType } });
    if (ext) { const from = require('../lib/storage').resolveStoragePath(saved.storagePath); fs.renameSync(from, require('../lib/storage').resolveStoragePath(items[key].storagePath)); }
  };
  await add('video', 'VIDEO', mp4(), 'video/mp4');
  await add('pdf', 'PDF', pdf(), 'application/pdf');
  await add('docx', 'DOC', docx('First paragraph about fares.\nSecond paragraph about baggage.'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx');
  await add('pptx', 'PPT', pptx('Cabin classes overview'), 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx');
  await add('legacy', 'PPT', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3]), 'application/vnd.ms-powerpoint', '.ppt');
  items.note = await prisma.libraryItem.create({ data: { organizationId: org.id, createdById: admin.id, title: 'MV note', itemType: 'NOTE', description: 'A plain note.' } });

  course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'MV course', createdById: admin.id, status: 'PUBLISHED' } });
  const assignment = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.id, scope: 'INDIVIDUAL' } });
  await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: assignment.id, profileId: agent.id } });
  const mod = async (key, contentType, buffer, mimeType, ext) => {
    const saved = await saveUpload({ buffer, mimetype: mimeType }, 'training');
    let storagePath = saved.storagePath;
    if (ext) { storagePath = storagePath.replace(/\.[a-z0-9]+$/i, ext); fs.renameSync(require('../lib/storage').resolveStoragePath(saved.storagePath), require('../lib/storage').resolveStoragePath(storagePath)); }
    modules[key] = await prisma.trainingModule.create({ data: { courseId: course.id, title: `MV module ${key}`, contentType, storagePath, required: false, displayOrder: Object.keys(modules).length } });
  };
  await mod('pdf', 'PDF', pdf(), 'application/pdf');
  await mod('docx', 'DOC', docx('Training paragraph one.\nTraining paragraph two.'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx');
});
after(async () => { await prisma.$disconnect(); });

test('the stylesheet no longer blocks clicks on videos (the cause of "the video will not play")', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf8');
  assert.doesNotMatch(css, /\.no-copy\s+video[^{]*\{[^}]*pointer-events:\s*none/);
  assert.doesNotMatch(css, /\.no-copy[^{]*iframe[^{]*\{[^}]*pointer-events:\s*none/);
  assert.match(css, /\.no-copy img \{ pointer-events: none; \}/);
});

test('viewerKind picks the right viewer', () => {
  assert.equal(viewerKind({ type: 'VIDEO', storagePath: 'a/b.mp4' }), 'video');
  assert.equal(viewerKind({ type: 'AUDIO', storagePath: 'a/b.mp3' }), 'audio');
  assert.equal(viewerKind({ type: 'IMAGE', storagePath: 'a/b.png' }), 'image');
  assert.equal(viewerKind({ type: 'PDF', storagePath: 'a/b.pdf' }), 'pdf');
  assert.equal(viewerKind({ type: 'DOC', storagePath: 'a/b.docx' }), 'text');
  assert.equal(viewerKind({ type: 'PPT', storagePath: 'a/b.pptx' }), 'text');
  assert.equal(viewerKind({ type: 'PPT', storagePath: 'a/b.ppt' }), 'unsupported');
  assert.equal(viewerKind({ type: 'DOC', storagePath: 'a/b.doc' }), 'unsupported');
  assert.equal(viewerKind({ type: 'NOTE', storagePath: null }), 'none');
});

test('Library: an employee watches a video with a working player and cannot download or copy it', async () => {
  const page = await get(agent, `/library/${items.video.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /<video data-skin src="\/library-file\/[^"]+" controls playsinline preload="metadata" controlsList="nodownload noremoteplayback" disablePictureInPicture/);
  assert.match(page.text, /class="card-body no-copy" data-protect/);
  assert.match(page.text, /protect-materials\.js/);
  assert.doesNotMatch(page.text, /download=1/);
  assert.match(page.text, /Viewing in-browser only/);
  // the video itself plays: it is served in pieces (Range) and inline
  const part = await get(agent, `/library-file/${items.video.id}`, { Range: 'bytes=0-99' });
  assert.equal(part.status, 206); assert.equal(part.headers['content-disposition'], 'inline');
});

test('Library: PDF, Word, PowerPoint, old PowerPoint and notes are all readable on the page', async () => {
  const pdfPage = await get(agent, `/library/${items.pdf.id}`);
  assert.match(pdfPage.text, /<iframe src="\/library-file\/[^"]+#toolbar=0&amp;navpanes=0/);
  const word = await get(agent, `/library/${items.docx.id}`);
  assert.match(word.text, /class="material-text"/); assert.match(word.text, /First paragraph about fares\./); assert.match(word.text, /Second paragraph about baggage\./);
  assert.doesNotMatch(word.text, /<iframe/);
  const slides = await get(agent, `/library/${items.pptx.id}`);
  assert.match(slides.text, /Cabin classes overview/);
  const legacy = await get(agent, `/library/${items.legacy.id}`);
  assert.match(legacy.text, /cannot be shown in the browser/); assert.match(legacy.text, /upload it as a PDF/);
  assert.match((await get(agent, `/library/${items.note.id}`)).text, /A plain note\./);
});

test('Library: Admins keep full access - normal viewers, a Download link and no copy protection', async () => {
  const page = await get(admin, `/library/${items.video.id}`);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /data-protect/); assert.doesNotMatch(page.text, /nodownload/); assert.doesNotMatch(page.text, /protect-materials\.js/);
  assert.match(page.text, /href="\/library-file\/[^"]+\?download=1">Download \(administrators only\)/);
  assert.doesNotMatch((await get(admin, `/library/${items.pdf.id}`)).text, /#toolbar=0/);
  const dl = await get(admin, `/library-file/${items.pdf.id}?download=1`);
  assert.equal(dl.status, 200); assert.match(dl.headers['content-disposition'], /attachment/);
});

test('raw files: a non-Admin cannot open one as a page or download it; embedding still works', async () => {
  const url = `/library-file/${items.pdf.id}`;
  const asPage = await get(agent, url, { 'Sec-Fetch-Dest': 'document' });
  assert.equal(asPage.status, 403); assert.match(asPage.text, /View only/);
  for (const dest of ['iframe', 'embed', 'object', 'video', 'audio', 'image', 'empty']) assert.equal((await get(agent, url, { 'Sec-Fetch-Dest': dest })).status, 200, dest);
  assert.equal((await get(agent, url)).status, 200);                                  // a browser that sends no hint is not blocked
  assert.equal((await get(agent, `${url}?download=1`, { 'Sec-Fetch-Dest': 'iframe' })).status, 403);
  assert.equal((await get(admin, url, { 'Sec-Fetch-Dest': 'document' })).status, 200);  // Admins may
  const tUrl = `/training-file/${modules.pdf.id}`;
  assert.equal((await get(agent, tUrl, { 'Sec-Fetch-Dest': 'document' })).status, 403);
  assert.equal((await get(agent, tUrl, { 'Sec-Fetch-Dest': 'iframe' })).status, 200);
  assert.equal((await get(agent, `${tUrl}?download=1`)).status, 403);
  assert.equal((await get(admin, tUrl, { 'Sec-Fetch-Dest': 'document' })).status, 200);
});

test('Training material: documents open on a reading page inside the app (Word as text, PDF in a viewer), view-only for employees', async () => {
  const page = await get(agent, `/training-course/${course.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`href="/training-read/${modules.pdf.id}"`)); assert.match(page.text, new RegExp(`href="/training-read/${modules.docx.id}"`));
  assert.doesNotMatch(page.text, new RegExp(`href="/training-file/${modules.docx.id}"`));
  assert.match(page.text, /data-protect/);
  const word = await get(agent, `/training-read/${modules.docx.id}`);
  assert.equal(word.status, 200);
  assert.match(word.text, /Training paragraph one\./); assert.match(word.text, /data-protect/); assert.match(word.text, /Viewing in-browser only/);
  assert.doesNotMatch(word.text, /download=1/);
  const viewerPdf = await get(agent, `/training-read/${modules.pdf.id}`);
  assert.match(viewerPdf.text, /<iframe src="\/training-file\/[^"]+#toolbar=0/);
  // opening a document starts its reading clock, exactly as before
  assert.ok(await prisma.mediaProgress.findFirst({ where: { profileId: agent.id, trainingModuleId: modules.docx.id } }));
  // an Admin sees a Download link and no protection; someone outside the course gets nothing
  const adminRead = await get(admin, `/training-read/${modules.docx.id}`);
  assert.match(adminRead.text, /download=1">Download \(administrators only\)/); assert.doesNotMatch(adminRead.text, /data-protect/);
  const stranger = await prisma.profile.create({ data: { organizationId: org.id, fullName: 'Stranger', username: `mv_x_${org.id}`, email: `mv_x_${org.id}@example.invalid`, role: 'TRAVEL_AGENT', status: 'ACTIVE', employmentStartDate: new Date() } });
  const t = generateToken(); await prisma.session.create({ data: { profileId: stranger.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } });
  assert.equal((await request(app).get(`/training-read/${modules.docx.id}`).set('Cookie', `sz_session=${t.raw}`)).status, 404);
});

test('the player skin: video and audio carry data-skin, the script is loaded and valid, the styles keep the site look', async () => {
  const vm = require('node:vm');
  const library = await get(agent, `/library/${items.video.id}`);
  assert.match(library.text, /<video data-skin src="\/library-file\/[^"]+" controls playsinline/); // native controls stay as the fallback
  assert.match(library.text, /player-skin\.js/);
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'player-skin.js'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(js));
  assert.match(js, /error', function \(\) \{ el\.setAttribute\('controls'/); // a file that fails gives the native controls back
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf8');
  for (const rule of ['.sz-player', '.sz-seek', '.sz-big', 'input.sz-seek']) assert.ok(css.includes(rule), rule);
  assert.match(css, /--gold-500/);
  assert.doesNotMatch((await get(agent, `/library/${items.pdf.id}`)).text, /player-skin\.js/); // a PDF page does not load the player
});

test('required training video: the progress line cannot be scrubbed by a learner until it is watched through (Admins can)', async () => {
  const vm = require('node:vm');
  const saved = await saveUpload({ buffer: mp4(), mimetype: 'video/mp4' }, 'training');
  const required = await prisma.trainingModule.create({ data: { courseId: course.id, title: 'MV required video', contentType: 'VIDEO', storagePath: saved.storagePath, required: true, displayOrder: 9, sourceRefJson: '{"durationSeconds":60}' } });
  const optional = await prisma.trainingModule.create({ data: { courseId: course.id, title: 'MV optional video', contentType: 'VIDEO', storagePath: saved.storagePath, required: false, displayOrder: 10, sourceRefJson: '{"durationSeconds":60}' } });
  const tag = (html, id) => (html.match(new RegExp(`<video[^>]*src="/training-file/${id}"[^>]*>`)) || [''])[0];
  const learner = await get(agent, `/training-course/${course.id}`);
  assert.match(tag(learner.text, required.id), /data-lock/);        // required: locked for the learner
  assert.doesNotMatch(tag(learner.text, optional.id), /data-lock/); // optional / reference: free to move around
  assert.match(learner.text, /skipping ahead is switched off/);
  assert.doesNotMatch(tag((await get(admin, `/training-course/${course.id}`)).text, required.id), /data-lock/); // Admins preview freely
  // finished material opens up again
  await prisma.mediaProgress.upsert({ where: { profileId_trainingModuleId: { profileId: agent.id, trainingModuleId: required.id } }, create: { profileId: agent.id, trainingModuleId: required.id, completedAt: new Date(), percentComplete: 100 }, update: { completedAt: new Date(), percentComplete: 100 } });
  assert.match(tag((await get(agent, `/training-course/${course.id}`)).text, required.id), /data-done="true"/);
  // the player honours it: locked only while data-lock is present and not done; finishing unlocks; arrow keys do not seek while locked
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'player-skin.js'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(js));
  assert.match(js, /lock\(el\.hasAttribute\('data-lock'\) && el\.dataset\.done !== 'true'\)/);
  assert.match(js, /addEventListener\('sz-unlock'/);
  assert.match(js, /seek\.disabled = on/);
  assert.match(js, /locked && \(e\.key === 'ArrowRight' \|\| e\.key === 'ArrowLeft'\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'media-progress.js'), 'utf8'), /dispatchEvent\(new Event\('sz-unlock'\)\)/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf8');
  assert.match(css, /\.sz-player\.sz-locked input\.sz-seek \{ cursor: default; pointer-events: none; \}/);
});

test('dark mode notifications: unread titles are light (no dark navy on dark) and unread rows are marked calmly', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf8');
  assert.match(css, /html\[data-theme="dark"\] \.notif-row\.unread \.notif-row-title \{ color: #fbfaff; font-weight: 600; \}/);
  assert.match(css, /html\[data-theme="dark"\] \.notif-row \.notif-row-title \{ color: #d6d3ea;/);
  assert.match(css, /html\[data-theme="dark"\] \.notif-row-dot \{ background: var\(--gold-400/);
  assert.match(css, /html\[data-theme="dark"\] \.notif-row\.unread \{ background: rgba\(220,168,120,\.08\); \}/);
});