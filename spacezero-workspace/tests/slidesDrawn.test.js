'use strict';
// A PowerPoint is shown as it was made (pictures where they were placed, text at its own size and colour, the background),
// and when a document is finished the learner is taken on to the next thing: the next item, or the practice and quizzes.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { resolveStoragePath } = require('../lib/storage');
const { renderPptx } = require('../lib/slideRender');
const app = require('../server');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = (items) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`;

function deck() {
  const z = new AdmZip();
  const add = (n, body) => z.addFile(n, Buffer.isBuffer(body) ? body : Buffer.from(body));
  add('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  add('ppt/presentation.xml', `<p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`);
  add('ppt/_rels/presentation.xml.rels', REL('<Relationship Id="rId1" Type="http://x/slide" Target="slides/slide1.xml"/>'));
  add('ppt/slides/_rels/slide1.xml.rels', REL('<Relationship Id="rId2" Type="http://x/image" Target="../media/pic.png"/>'));
  add('ppt/media/pic.png', PNG);
  add('ppt/slides/slide1.xml', `<p:sld ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="0F172A"/></a:solidFill></p:bgPr></p:bg><p:spTree>
    <p:pic><p:nvPicPr><p:cNvPr id="2" name="Picture" descr="C:\\tmp\\secret\\pic.png"/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr><a:xfrm><a:off x="6096000" y="0"/><a:ext cx="6096000" cy="3429000"/></a:xfrm></p:spPr></p:pic>
    <p:sp><p:nvSpPr><p:cNvPr id="3" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="609600" y="685800"/><a:ext cx="5486400" cy="1000000"/></a:xfrm></p:spPr>
      <p:txBody><a:bodyPr/><a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="4000" b="1"><a:solidFill><a:srgbClr val="FDE68A"/></a:solidFill></a:rPr><a:t>Dubai &lt;script&gt;alert(1)&lt;/script&gt;</a:t></a:r></a:p></p:txBody></p:sp>
    </p:spTree></p:cSld></p:sld>`);
  return z.toBuffer();
}

let org, admin, agent, cookies = {}, course, modules;
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body) => request(app).post(url).set('Cookie', cookies[p.id]).send(body);

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Slides drawn tests' } });
  const mk = async (role, name) => {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `SD ${name}`, username: `sd_${org.id}_${name}`, email: `sd_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
    const t = generateToken(); await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookies[p.id] = `sz_session=${t.raw}`;
    return p;
  };
  admin = await mk('ADMIN', 'admin'); agent = await mk('TRAVEL_AGENT', 'agent');
  const dir = resolveStoragePath('training'); fs.mkdirSync(dir, { recursive: true });
  const stamp = Date.now();
  fs.writeFileSync(path.join(dir, `sd-${stamp}.pptx`), deck());
  fs.writeFileSync(path.join(dir, `sd-${stamp}.html`), '<html><body><h1>Page</h1></body></html>');
  course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Drawn slides', createdById: admin.id, status: 'PUBLISHED', publishedVersion: 1, modules: { create: [
    { title: 'Deck', contentType: 'PPT', storagePath: `training/sd-${stamp}.pptx`, displayOrder: 0, required: true },
    { title: 'Page', contentType: 'DOC', storagePath: `training/sd-${stamp}.html`, displayOrder: 1, required: true },
  ] } }, include: { modules: true } });
  modules = Object.fromEntries(course.modules.map((m) => [m.title, m]));
  const quiz = await prisma.assessment.create({ data: { organizationId: org.id, courseId: course.id, createdVia: 'ADMIN_MANUAL', type: 'QUIZ', status: 'APPROVED', title: 'Deck quiz', createdById: admin.id, version: 1 } });
  await prisma.question.create({ data: { assessmentId: quiz.id, type: 'MCQ', prompt: 'Which?', optionsJson: JSON.stringify(['A', 'B']), correctAnswerJson: JSON.stringify('A'), displayOrder: 0 } });
  const a = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.id, scope: 'INDIVIDUAL' } });
  await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: a.id, profileId: agent.id } });
});
after(async () => { await prisma.$disconnect(); });

test('a PowerPoint is drawn as made: the picture at its place, the text in its own size and colour, the slide background', () => {
  const slides = renderPptx(modules.Deck.storagePath);
  assert.equal(slides.length, 1);
  const html = slides[0].html;
  assert.match(html, /background:#0f172a/);                                              // the slide's own background
  assert.match(html, /left:50\.000%;top:0\.000%;width:50\.000%;height:50\.000%/);        // the picture: right half, top half
  assert.match(html, /<img src="data:image\/png;base64,/);
  assert.doesNotMatch(html, /secret|C:\\/);                                              // a file path in the picture's description is never shown
  assert.match(html, /color:#fde68a/); assert.match(html, /font-weight:700/); assert.match(html, /text-align:center/);
  assert.match(html, /font-size:4\.1\d+cqw/);                                           // 40 pt on a 13.33 in slide
  assert.match(html, /Dubai &lt;script&gt;alert\(1\)&lt;\/script&gt;/); assert.doesNotMatch(html, /<script/);   // text is escaped
  assert.equal(renderPptx('training/does-not-exist.pptx'), null);
});

test('text is never cut off by its own box: a title taller than its box still shows in full', () => {
  const z = new AdmZip();
  z.addFile('[Content_Types].xml', Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'));
  z.addFile('ppt/presentation.xml', Buffer.from(`<p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>`));
  z.addFile('ppt/_rels/presentation.xml.rels', Buffer.from(REL('<Relationship Id="rId1" Type="http://x/slide" Target="slides/slide1.xml"/>')));
  // a 30 pt title with 12 pt before it in a box only 0.63 in high (as exported by Google Slides): the text is taller than the box
  const para = () => `<a:p><a:pPr><a:lnSpc><a:spcPct val="115000"/></a:lnSpc><a:spcBef><a:spcPts val="1200"/></a:spcBef><a:buNone/></a:pPr><a:r><a:rPr b="1" sz="3000"/><a:t>Offering to discuss options on the same call</a:t></a:r></a:p>`;
  const box = (id, spc) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="t"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="311700" y="${id * 1000000}"/><a:ext cx="8520600" cy="572700"/></a:xfrm></p:spPr><p:txBody><a:bodyPr ${spc ? 'spcFirstLastPara="1"' : ''} anchor="t"><a:noAutofit/></a:bodyPr>${para()}</p:txBody></p:sp>`;
  z.addFile('ppt/slides/slide1.xml', Buffer.from(`<p:sld ${NS}><p:cSld><p:spTree>${box(1, true)}${box(2, false)}</p:spTree></p:cSld></p:sld>`));
  const dir = resolveStoragePath('training'); fs.mkdirSync(dir, { recursive: true });
  const name = `training/sd-overflow-${Date.now()}.pptx`; fs.writeFileSync(resolveStoragePath(name), z.toBuffer());
  const html = renderPptx(name)[0].html;
  assert.doesNotMatch(html, /overflow:\s*hidden/);                                      // nothing is clipped: no picture here, so no hidden overflow anywhere
  const [asked, ignored] = [...html.matchAll(/<p style="([^"]*)">/g)].map((m) => m[1]);
  assert.match(asked, /margin:[\d.]+cqw 0 /);                                           // spcFirstLastPara="1": the space before counts
  assert.match(ignored, /margin:0 0 /);                                                 // otherwise the first paragraph has none
});

test('the reading page draws the slides in place and a finished item leads on to the next one, then to the quizzes', async () => {
  const page = await get(agent, `/training-read/${modules.Deck.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /doc-reader__slide--drawn/); assert.match(page.text, /sc-canvas/); assert.match(page.text, /<img src="data:image\/png/);
  assert.doesNotMatch(page.text, /target="_blank"/);                                    // reading stays on this page

  await prisma.mediaProgress.updateMany({ where: { profileId: agent.id, trainingModuleId: modules.Deck.id }, data: { startedAt: new Date(Date.now() - 60000) } });
  let r = await post(agent, `/training-material/${modules.Deck.id}/progress`, { percent: 100, pages: 1 });
  assert.equal(r.body.completed, true);
  assert.equal(r.body.next.unlocked, false); assert.equal(r.body.next.url, `/training-read/${modules.Page.id}`); assert.match(r.body.next.label, /Next: Page/);

  await get(agent, `/training-read/${modules.Page.id}`);
  await prisma.mediaProgress.updateMany({ where: { profileId: agent.id, trainingModuleId: modules.Page.id }, data: { startedAt: new Date(Date.now() - 60000) } });
  r = await post(agent, `/training-material/${modules.Page.id}/progress`, { percent: 100, pages: 1 });
  assert.equal(r.body.completed, true);
  assert.equal(r.body.next.unlocked, true); assert.equal(r.body.next.url, `/training-course/${course.id}#practice`); assert.match(r.body.next.label, /practice and quizzes/);

  const again = await get(agent, `/training-read/${modules.Page.id}`);                  // reopened later: the same way on
  assert.match(again.text, /href="\/training-course\/[^"]+#practice"/); assert.match(again.text, /now open/);
  const open = await get(agent, `/training-course/${course.id}`);
  assert.doesNotMatch(open.text, /Locked until you finish/); assert.match(open.text, />Start</);   // the quiz is open
});
