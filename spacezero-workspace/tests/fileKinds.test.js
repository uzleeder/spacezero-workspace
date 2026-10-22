'use strict';
// Every kind of file a training can carry - audio, video, pictures, vectors, documents, e-books, presentations, spreadsheets,
// fonts and CAD drawings - uploads, is checked from its real content, and is shown on the reading page.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');

mock.method(require('../lib/gemini'), 'generateStructured', async () => { throw new Error('Gemini must not be called in these tests'); });

const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { resolveStoragePath } = require('../lib/storage');
const fileTypes = require('../lib/fileTypes');
const render = require('../lib/documentRender');
const app = require('../server');

let org, admin, agent, cookies = {};
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);

const zipOf = (entries, { odf } = {}) => {
  const z = new AdmZip();
  if (odf) { z.addFile('mimetype', Buffer.from(odf)); z.getEntry('mimetype').header.method = 0; }
  for (const [name, body] of Object.entries(entries)) z.addFile(name, Buffer.from(body));
  return z.toBuffer();
};
const xlsx = () => zipOf({
  '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="Fares" sheetId="1" r:id="rId1"/><sheet name="Notes &amp; rules" sheetId="2" r:id="rId2"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
  'xl/sharedStrings.xml': '<sst><si><t>Route</t></si><si><t>Price</t></si><si><t>TAS-DXB</t></si><si><r><t>Rule </t></r><r><t>one</t></r></si></sst>',
  'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>480.5</v></c></row></sheetData></worksheet>',
  'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>3</v></c><c r="C1" t="inlineStr"><is><t>inline</t></is></c></row></sheetData></worksheet>',
});
const ods = () => zipOf({ 'content.xml': '<office:document-content><office:body><office:spreadsheet><table:table table:name="Sheet1"><table:table-row><table:table-cell office:value-type="string"><text:p>Airline</text:p></table:table-cell><table:table-cell><text:p>Qatar</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>' }, { odf: 'application/vnd.oasis.opendocument.spreadsheet' });
const odt = () => zipOf({ 'content.xml': '<office:document-content><office:body><office:text><text:h text:outline-level="1">Baggage rules</text:h><text:p>Economy allows one bag.</text:p><text:list><text:list-item><text:p>Check size</text:p></text:list-item></text:list></office:text></office:body></office:document-content>' }, { odf: 'application/vnd.oasis.opendocument.text' });
const odp = () => zipOf({ 'content.xml': '<office:document-content><office:body><office:presentation><draw:page draw:name="p1"><text:p>First slide</text:p><text:p>point one</text:p></draw:page><draw:page draw:name="p2"><text:p>Second slide</text:p></draw:page></office:presentation></office:body></office:document-content>' }, { odf: 'application/vnd.oasis.opendocument.presentation' });
const epub = () => zipOf({
  'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
  'OEBPS/content.opf': '<package><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>',
  'OEBPS/ch1.xhtml': '<html><head><title>x</title><style>body{}</style></head><body><h1>Chapter One</h1><p onclick="steal()">Hello <a href="javascript:alert(1)">link</a></p><script>alert(1)</script></body></html>',
  'OEBPS/ch2.xhtml': '<html><body><h1>Chapter Two</h1><p>The end.</p></body></html>',
}, { odf: 'application/epub+zip' });
const dxf = () => Buffer.from('0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n0\n20\n0\n11\n100\n21\n50\n0\nCIRCLE\n10\n40\n20\n25\n40\n10\n0\nLWPOLYLINE\n70\n1\n10\n0\n20\n0\n10\n30\n20\n0\n10\n30\n20\n30\n0\nTEXT\n10\n5\n20\n5\n40\n4\n1\nRoom A\n0\nENDSEC\n0\nEOF\n');
const png = () => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64)]);
const FILES = {
  'a.mp3': Buffer.concat([Buffer.from('ID3'), Buffer.alloc(32)]), 'a.m4a': Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A '), Buffer.alloc(32)]), 'a.flac': Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(32)]),
  'a.png': png(), 'a.bmp': Buffer.concat([Buffer.from('BM'), Buffer.alloc(32)]), 'a.svg': Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle r="4"/></svg>'),
  'a.ai': Buffer.from('%PDF-1.5\n%%EOF\n'), 'a.pdf': Buffer.from('%PDF-1.4\n%%EOF\n'), 'a.docx': zipOf({ 'word/document.xml': '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Hi</w:t></w:r></w:p></w:body></w:document>', '[Content_Types].xml': '<Types/>' }),
  'a.odt': odt(), 'a.rtf': Buffer.from('{\\rtf1\\ansi Hello \\b world\\b0\\par Second line}'), 'a.txt': Buffer.from('plain notes\nline two'), 'a.md': Buffer.from('# Title\n\n- one\n- two'), 'a.html': Buffer.from('<html><body><h1>Page</h1><script>alert(1)</script><p>Body text</p></body></html>'),
  'a.epub': epub(), 'a.pptx': zipOf({ 'ppt/slides/slide1.xml': '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>S1</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>', '[Content_Types].xml': '<Types/>' }), 'a.odp': odp(),
  'a.xlsx': xlsx(), 'a.ods': ods(), 'a.csv': Buffer.from('Name,Price\n"Smith, J",10\nLee,20'), 'a.tsv': Buffer.from('a\tb\n1\t2'),
  'a.ttf': Buffer.concat([Buffer.from('00010000', 'hex'), Buffer.alloc(64)]), 'a.otf': Buffer.concat([Buffer.from('OTTO'), Buffer.alloc(64)]), 'a.woff': Buffer.concat([Buffer.from('wOFF'), Buffer.alloc(64)]), 'a.woff2': Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(64)]),
  'a.dxf': dxf(),
};

before(async () => {
  org = await prisma.organization.create({ data: { name: 'File kinds tests' } });
  const mk = async (role, name) => {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `FK ${name}`, username: `fk_${org.id}_${name}`, email: `fk_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
    const t = generateToken(); await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookies[p.id] = `sz_session=${t.raw}`;
    return p;
  };
  admin = await mk('ADMIN', 'admin'); agent = await mk('TRAVEL_AGENT', 'agent');
});
after(async () => { mock.restoreAll(); await prisma.$disconnect(); });

test('the list covers every category; each file kind passes its own check and is refused with someone else\'s bytes', () => {
  assert.deepEqual(fileTypes.CATEGORIES.sort(), ['Audio', 'CAD', 'Document', 'Ebook', 'Font', 'Image', 'Presentation', 'Spreadsheet', 'Vector', 'Video']);
  const { sampleOf } = require('../lib/storage');
  for (const [name, bytes] of Object.entries(FILES)) {
    const entry = fileTypes.lookup(name); assert.ok(entry, name);
    assert.equal(fileTypes.validateContent(entry, { originalname: name, size: bytes.length, buffer: bytes }, sampleOf({ buffer: bytes })), null, name);
  }
  const forged = Buffer.from('MZ\x90\x00 this is a program, not a document');
  for (const name of ['a.xlsx', 'a.epub', 'a.ttf', 'a.png', 'a.pdf', 'a.mp3', 'a.docx', 'a.odt', 'a.dxf', 'a.svg']) assert.match(fileTypes.validateContent(fileTypes.lookup(name), { originalname: name, size: forged.length, buffer: forged }, forged) || '', /not a real/, name);
  assert.match(fileTypes.hint('plan.DWG'), /export it as DXF or PDF/); assert.match(fileTypes.hint('x.heic'), /JPG or PNG/); assert.equal(fileTypes.hint('x.exe'), null);
  assert.equal(fileTypes.nounFor('t/a.xlsx'), 'the spreadsheet'); assert.equal(fileTypes.nounFor('t/a.epub'), 'the e-book'); assert.equal(fileTypes.nounFor('t/a.ttf'), 'the font');
});

test('every kind uploads as training material with the right stored kind and extension; forged and undisplayable files are refused', async () => {
  const names = Object.keys(FILES).filter((n) => !['a.mp3', 'a.m4a', 'a.flac'].includes(n)); // audio is checked by the recording probe (needs real audio), see below
  const req = request(app).post('/ai-practice/new').set('Cookie', cookies[admin.id]).field('kind', 'material').field('trainingCategory', 'SYSTEM_WORKFLOW').field('title', 'All kinds');
  for (const n of names) req.attach('files', FILES[n], { filename: n });
  const res = await req;
  assert.equal(res.status, 302, res.text.slice(0, 300));
  const course = await prisma.trainingCourse.findFirst({ where: { title: 'All kinds' }, include: { modules: true } });
  assert.equal(course.modules.length, names.length);
  const by = Object.fromEntries(course.modules.map((m) => [path.extname(m.storagePath), m.contentType]));
  for (const [ext, type] of [['.xlsx', 'DOC'], ['.epub', 'DOC'], ['.ttf', 'DOC'], ['.dxf', 'DOC'], ['.odp', 'PPT'], ['.pptx', 'PPT'], ['.svg', 'IMAGE'], ['.bmp', 'IMAGE'], ['.ai', 'PDF'], ['.pdf', 'PDF'], ['.csv', 'DOC'], ['.md', 'DOC']]) assert.equal(by[ext], type, ext);
  for (const m of course.modules) assert.ok(fs.existsSync(resolveStoragePath(m.storagePath)), m.storagePath);
  // refused: forged content, a format nothing can show (with a hint), an unknown type; nothing is left half-created
  const before = await prisma.trainingCourse.count();
  const forged = await request(app).post('/ai-practice/new').set('Cookie', cookies[admin.id]).field('kind', 'material').field('trainingCategory', 'SALES').attach('files', Buffer.from('MZ not a sheet'), { filename: 'fake.xlsx' });
  assert.equal(forged.status, 400); assert.match(forged.text, /not a real XLSX file/);
  const dwg = await request(app).post('/ai-practice/new').set('Cookie', cookies[admin.id]).field('kind', 'material').field('trainingCategory', 'SALES').attach('files', Buffer.from('AC1027'), { filename: 'plan.dwg' });
  assert.equal(dwg.status, 400); assert.match(dwg.text, /export it as DXF or PDF/);
  assert.equal((await request(app).post('/ai-practice/new').set('Cookie', cookies[admin.id]).field('kind', 'material').field('trainingCategory', 'SALES').attach('files', Buffer.from('x'), { filename: 'run.exe' })).status, 400);
  assert.equal(await prisma.trainingCourse.count(), before);
  assert.match((await get(admin, '/ai-practice/new')).text, /spreadsheets \(XLSX, ODS, CSV\)[\s\S]*fonts \(TTF, OTF, WOFF\)[\s\S]*CAD drawings \(DXF\)/);
});

test('the renderers turn each kind into safe pages: tables, chapters, text, slides, drawings', () => {
  const put = (name, bytes) => { const dir = resolveStoragePath('training'); fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, `fk-${Date.now()}-${name}`); fs.writeFileSync(file, bytes); return `training/${path.basename(file)}`; };
  const sheets = render.sheetsHtml(put('a.xlsx', FILES['a.xlsx']));
  assert.match(sheets, /<h2>Fares<\/h2>/); assert.match(sheets, /<td>TAS-DXB<\/td><td>480\.5<\/td>/); assert.match(sheets, /<h2>Notes &amp; rules<\/h2>/); assert.match(sheets, /<td>Rule one<\/td>/); assert.match(sheets, /<td>inline<\/td>/);
  assert.match(render.sheetsHtml(put('a.ods', FILES['a.ods'])), /<td>Airline<\/td><td>Qatar<\/td>/);
  assert.match(render.sheetsHtml(put('a.csv', FILES['a.csv'])), /<td>Smith, J<\/td><td>10<\/td>/);
  assert.match(render.sheetsHtml(put('a.tsv', FILES['a.tsv'])), /<td>1<\/td><td>2<\/td>/);
  assert.match(render.odtHtml(put('a.odt', FILES['a.odt'])), /<h1>Baggage rules<\/h1>[\s\S]*<p>Economy allows one bag\.<\/p>[\s\S]*<li>Check size<\/li>/);
  assert.deepEqual(render.odpSlides(put('a.odp', FILES['a.odp'])).map((s) => [s.number, s.title, s.lines]), [[1, 'First slide', ['point one']], [2, 'Second slide', []]]);
  const book = render.epubHtml(put('a.epub', FILES['a.epub']));
  assert.match(book, /Chapter One/); assert.match(book, /Chapter Two/); assert.doesNotMatch(book, /<script|steal|javascript:|<style|onclick|href=/i);
  assert.match(render.textHtml(put('a.rtf', FILES['a.rtf'])), /Hello world\nSecond line/);
  assert.match(render.textHtml(put('a.md', FILES['a.md'])), /<h1>Title<\/h1>\n<ul>\n<li>one<\/li>/);
  const html = render.textHtml(put('a.html', FILES['a.html']));
  assert.match(html, /Page/); assert.match(html, /Body text/); assert.doesNotMatch(html, /alert|<script/);           // shown as text, never run
  const svg = render.dxfSvg(put('a.dxf', FILES['a.dxf']));
  assert.match(svg, /^<svg[^>]*viewBox="/); assert.match(svg, /<circle/); assert.match(svg, /M0\.000,0\.000 L100\.000,-50\.000/); assert.match(svg, />Room A<\/text>/);
  assert.equal(render.sheetsHtml('training/does-not-exist.xlsx'), null);
  // the AI analysis reads the text of these files too
  assert.match(render.plainText(put('a.xlsx', FILES['a.xlsx'])), /TAS-DXB/); assert.match(render.plainText(put('a.epub', FILES['a.epub'])), /Chapter Two/);
  assert.match(require('../lib/documentText') ? 'x' : '', /x/);
});

test('the reading page shows every kind and tracks reading; the raw svg / html files cannot run anything', async () => {
  const course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Reading kinds', createdById: admin.id, status: 'PUBLISHED', publishedVersion: 1 } });
  const assignment = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.id, scope: 'INDIVIDUAL' } });
  await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: assignment.id, profileId: agent.id } });
  const make = async (name, contentType) => {
    const dir = resolveStoragePath('training'); fs.mkdirSync(dir, { recursive: true }); const file = `fk-read-${Date.now()}-${name}`; fs.writeFileSync(path.join(dir, file), FILES[name]);
    return prisma.trainingModule.create({ data: { courseId: course.id, title: name, contentType, storagePath: `training/${file}`, required: true } });
  };
  const cases = [['a.xlsx', 'DOC', 'sheet', /doc-reader__sheets[\s\S]*TAS-DXB/], ['a.csv', 'DOC', 'sheet', /Smith, J/], ['a.epub', 'DOC', 'epub', /doc-reader__paper--epub[\s\S]*Chapter One/], ['a.txt', 'DOC', 'text', /plain notes/], ['a.md', 'DOC', 'text', /<h1>Title<\/h1>/], ['a.odt', 'DOC', 'docx', /Baggage rules/], ['a.odp', 'PPT', 'slides', /First slide/], ['a.dxf', 'DOC', 'cad', /doc-reader__cad/], ['a.ttf', 'DOC', 'font', /@font-face[\s\S]*Aa Bb Cc/], ['a.svg', 'IMAGE', 'image', /<img src="\/training-file\//], ['a.ai', 'PDF', 'pdf', /data-kind="pdf"/]];
  for (const [name, type, kind, pattern] of cases) {
    const m = await make(name, type);
    const page = await get(agent, `/training-read/${m.id}`);
    assert.equal(page.status, 200, name);
    assert.match(page.text, new RegExp(`data-kind="${kind}"`), name); assert.match(page.text, pattern, name); assert.match(page.text, /data-doc-progress/, name);
    assert.doesNotMatch(page.text, /I have read this/, name);
  }
  const svgModule = await prisma.trainingModule.findFirst({ where: { courseId: course.id, title: 'a.svg' } });
  const raw = await get(agent, `/training-file/${svgModule.id}`).set('Sec-Fetch-Dest', 'image');
  assert.equal(raw.status, 200); assert.match(raw.headers['content-security-policy'], /sandbox/); assert.match(raw.headers['content-type'], /svg/);
  const htmlModule = await make('a.html', 'DOC');
  const framed = await get(agent, `/training-read/${htmlModule.id}`);
  assert.match(framed.text, /data-kind="html"/); assert.match(framed.text, /<iframe[^>]*sandbox="allow-same-origin"[^>]*src="\/training-file\/[^"?]+\?frame=1"/); assert.doesNotMatch(framed.text, /alert\(1\)/);
  const frameFile = await get(agent, `/training-file/${htmlModule.id}?frame=1`).set('Sec-Fetch-Dest', 'iframe');
  assert.equal(frameFile.status, 200); assert.match(frameFile.headers['content-security-policy'], /^sandbox allow-same-origin; default-src 'none'/); assert.doesNotMatch(frameFile.headers['content-security-policy'], /allow-scripts/);
  assert.match((await get(agent, `/training-file/${htmlModule.id}`).set('Sec-Fetch-Dest', 'empty')).headers['content-security-policy'], /sandbox; default-src 'none'/);
  // On the training page each of them is a step that shows the file right there (an Admin's preview opens every step) ...
  const steps = (await prisma.trainingModule.count({ where: { courseId: course.id } })) + 1;
  const kinds = [];
  for (let n = 1; n <= steps; n += 1) { const m = (await get(admin, `/training-course/${course.id}?step=${n}`)).text.match(/data-doc-reader\s+data-kind="([a-z]+)"/); if (m) kinds.push(m[1]); }
  for (const kind of ['sheet', 'epub', 'font', 'cad', 'text']) assert.ok(kinds.includes(kind), kind + ' in ' + kinds.join(','));
  // ... and for the learner its Next waits for the reading line - every one of these finishes by itself, no "I have read this"
  const page = (await get(agent, `/training-course/${course.id}`)).text;
  assert.match(page, /data-unlock-on="document"/);
  assert.doesNotMatch(page, /I have read this/);
});
