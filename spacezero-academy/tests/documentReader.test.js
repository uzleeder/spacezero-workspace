'use strict';
// A document is read inside the app as it was uploaded (PDF pages, the Word document, the slides, the picture) with a line
// at the bottom that fills as the learner reads; reaching the end (after a fair amount of time) finishes the item by itself.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { resolveStoragePath } = require('../lib/storage');
const viewer = require('../lib/materialViewer');
const app = require('../server');

let org, admin, agent, outsider, course, mods = {}, cookies = {};
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const progress = (p, id, body) => request(app).post(`/training-material/${id}/progress`).set('Cookie', cookies[p.id]).send(body);

function pdfBytes() { return Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n'); }
function docxBytes() {
  const z = new AdmZip();
  z.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  z.addFile('_rels/.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
  z.addFile('word/document.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>CRM Closing Reasons</w:t></w:r></w:p><w:p><w:r><w:t>Always record the closing reason.</w:t></w:r></w:p></w:body></w:document>'));
  return z.toBuffer();
}
function pptxBytes() {
  const z = new AdmZip();
  z.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'));
  for (let i = 1; i <= 2; i++) z.addFile(`ppt/slides/slide${i}.xml`, Buffer.from(`<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Cabins ${i}</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:p><a:r><a:t>Point A${i}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`));
  return z.toBuffer();
}

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Document reader tests' } });
  const mk = async (role, name, organizationId = org.id) => {
    const p = await prisma.profile.create({ data: { organizationId, fullName: `DR ${name}`, username: `dr_${organizationId}_${name}`, email: `dr_${organizationId}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
    const t = generateToken(); await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookies[p.id] = `sz_session=${t.raw}`;
    return p;
  };
  admin = await mk('ADMIN', 'admin'); agent = await mk('TRAVEL_AGENT', 'agent'); outsider = await mk('TRAVEL_AGENT', 'outsider');
  const dir = resolveStoragePath('training'); fs.mkdirSync(dir, { recursive: true });
  const put = (name, buf) => { fs.writeFileSync(path.join(dir, name), buf); return `training/${name}`; };
  const stamp = Date.now();
  const files = { pdf: put(`dr-${stamp}.pdf`, pdfBytes()), docx: put(`dr-${stamp}.docx`, docxBytes()), pptx: put(`dr-${stamp}.pptx`, pptxBytes()), doc: put(`dr-${stamp}.doc`, Buffer.from('legacy')) };
  course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Reader course', createdById: admin.id, status: 'PUBLISHED', publishedVersion: 1, modules: { create: [
    { title: 'PDF guide', contentType: 'PDF', storagePath: files.pdf, displayOrder: 0, required: true },
    { title: 'Word notes', contentType: 'DOC', storagePath: files.docx, displayOrder: 1, required: true },
    { title: 'Slides', contentType: 'PPT', storagePath: files.pptx, displayOrder: 2, required: true },
    { title: 'Old Word file', contentType: 'DOC', storagePath: files.doc, displayOrder: 3, required: true },
  ] } }, include: { modules: true } });
  for (const m of course.modules) mods[m.title] = m;
  const assignment = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.id, scope: 'INDIVIDUAL' } });
  await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: assignment.id, profileId: agent.id } });
});
after(async () => { await prisma.$disconnect(); });

test('which reader a file gets, and what the Word and slide readers produce', async () => {
  for (const [file, kind] of [['a.pdf', 'pdf'], ['a.docx', 'docx'], ['a.pptx', 'slides'], ['a.png', 'image'], ['a.JPG', 'image'], ['a.doc', 'unsupported'], ['a.ppt', 'unsupported']]) assert.equal(viewer.readerKind({ type: 'DOC', storagePath: `training/${file}` }), kind, file);
  const html = await viewer.docxHtml(mods['Word notes'].storagePath);
  assert.match(html, /<h1>CRM Closing Reasons<\/h1>/); assert.match(html, /<p>Always record the closing reason\.<\/p>/);
  const slides = await viewer.slidesData(mods['Slides'].storagePath);
  assert.deepEqual(slides.map((s) => [s.number, s.title, s.lines]), [[1, 'Cabins 1', ['Point A1']], [2, 'Cabins 2', ['Point A2']]]);
  assert.equal(await viewer.docxHtml('training/does-not-exist.docx'), null);
});

test('the reading page shows each file as it was uploaded, with the progress line, and offers no manual button for it', async () => {
  const pdf = await get(agent, `/training-read/${mods['PDF guide'].id}`);
  assert.equal(pdf.status, 200);
  assert.match(pdf.text, /data-doc-reader[\s\S]*data-kind="pdf"/); assert.match(pdf.text, /\/static\/vendor\/pdfjs\/pdf\.min\.js/); assert.match(pdf.text, /\/static\/js\/doc-reader\.js\?v=/);
  assert.match(pdf.text, /data-doc-progress/); assert.match(pdf.text, /Reading progress/); assert.match(pdf.text, /data-tracked="true"/);
  assert.doesNotMatch(pdf.text, /I have read this/);
  const docx = await get(agent, `/training-read/${mods['Word notes'].id}`);
  assert.match(docx.text, /data-kind="docx"/); assert.match(docx.text, /<article class="doc-reader__paper"[^>]*><h1>CRM Closing Reasons<\/h1>/);
  const slides = await get(agent, `/training-read/${mods['Slides'].id}`);
  assert.match(slides.text, /data-kind="slides"/); assert.match(slides.text, /Slide 2 of 2/); assert.match(slides.text, /Cabins 2/);
  // an old .doc cannot be drawn: it says so and keeps the by-hand button for the learner
  const legacy = await get(agent, `/training-read/${mods['Old Word file'].id}`);
  assert.match(legacy.text, /data-reader-unsupported/); assert.match(legacy.text, /I have read this/); assert.doesNotMatch(legacy.text, /data-doc-progress/);
  // the vendored PDF engine and the reader script are served
  assert.equal((await request(app).get('/static/vendor/pdfjs/pdf.min.js')).status, 200);
  assert.equal((await request(app).get('/static/vendor/pdfjs/pdf.worker.min.js')).status, 200);
  assert.equal((await request(app).get('/static/js/doc-reader.js')).status, 200);
});

test('the training page shows the line under Read; files the reader can draw finish by themselves, the rest keep the manual button', async () => {
  const page = (await get(agent, `/training-course/${course.id}`)).text;
  assert.equal((page.match(/data-read-line/g) || []).length, 4);
  assert.match(page, /line fills as you read, and this item finishes by itself/);
  assert.equal((page.match(/I have read this/g) || []).length, 1);   // only the old .doc
  assert.match(page, new RegExp(`/training-read/${mods['PDF guide'].id}">Read the PDF</a>`));
});

test('progress: it only goes up, needs the end AND a fair amount of time, then finishes the item; previews and outsiders record nothing', async () => {
  const id = mods['PDF guide'].id;
  assert.equal((await request(app).post(`/training-material/${id}/progress`).send({ percent: 10 })).status === 200, false); // needs a session
  await get(agent, `/training-read/${id}`);                                       // opening starts the clock
  let r = await progress(agent, id, { percent: 40, pages: 1 });
  assert.equal(r.status, 200); assert.equal(r.body.percent, 40); assert.equal(r.body.completed, false);
  r = await progress(agent, id, { percent: 15, pages: 1 });                       // scrolling back up never lowers it
  assert.equal(r.body.percent, 40);
  r = await progress(agent, id, { percent: 100, pages: 1 });                      // the end - but only seconds after opening
  assert.equal(r.body.completed, false); assert.ok(r.body.waitMs > 0 && r.body.waitMs <= 12000);
  assert.ok((await prisma.mediaProgress.findFirst({ where: { profileId: agent.id, trainingModuleId: id } })).percentComplete < 100);
  await prisma.mediaProgress.updateMany({ where: { profileId: agent.id, trainingModuleId: id }, data: { startedAt: new Date(Date.now() - 60000) } }); // a minute with it
  r = await progress(agent, id, { percent: 100, pages: 1 });
  assert.equal(r.body.completed, true); assert.equal(r.body.percent, 100);
  const row = await prisma.mediaProgress.findFirst({ where: { profileId: agent.id, trainingModuleId: id } });
  assert.ok(row.completedAt); assert.equal(row.percentComplete, 100);
  assert.ok(await prisma.auditLog.findFirst({ where: { actorId: agent.id, action: 'training.material_completed', targetId: id } }));
  assert.equal((await progress(agent, id, { percent: 5 })).body.completed, true);  // stays finished
  // longer documents need more time: 40 pages -> at least 2 minutes
  const second = mods['Slides'].id;
  await get(agent, `/training-read/${second}`);
  await prisma.mediaProgress.updateMany({ where: { profileId: agent.id, trainingModuleId: second }, data: { startedAt: new Date(Date.now() - 30000) } });
  assert.equal((await progress(agent, second, { percent: 100, pages: 40 })).body.completed, false);
  // bad input, an Admin previewing, someone who is not assigned
  assert.equal((await progress(agent, second, { percent: 'abc' })).status, 400);
  assert.deepEqual((await progress(admin, id, { percent: 100 })).body, { preview: true, percent: 0, completed: false });
  assert.equal(await prisma.mediaProgress.count({ where: { profileId: admin.id } }), 0);
  assert.equal((await progress(outsider, id, { percent: 100 })).status, 404);
  // the training page now shows the PDF as finished
  const page = (await get(agent, `/training-course/${course.id}`)).text;
  assert.match(page, /Read the PDF again/);
});
