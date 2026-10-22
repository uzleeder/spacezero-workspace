'use strict';
// "Learn first, practise after": an employee must watch, listen to and read all required material of a
// training before any practice, quiz or assessment of it opens — enforced by the server, not just hidden.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.MIN_READ_MS = '12000';
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { saveUpload } = require('../lib/storage');
const { mediaGate } = require('../lib/mediaProgress');
const app = require('../server');

let org, admin, agent, other, outsider, cookies = {};
let course, video, pdf, note, quiz, recipient;
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);
const rowOf = (profile, module) => prisma.mediaProgress.findUnique({ where: { profileId_trainingModuleId: { profileId: profile.id, trainingModuleId: module.id } } });
const ago = (ms) => new Date(Date.now() - ms);

async function user(role, name, organizationId = org.id) {
  const p = await prisma.profile.create({ data: { organizationId, fullName: `LF ${name}`, username: `lf_${organizationId}_${name}`, email: `lf_${organizationId}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
  const t = generateToken();
  await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } });
  cookies[p.id] = `sz_session=${t.raw}`;
  return p;
}

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Learn first' } });
  const otherOrg = await prisma.organization.create({ data: { name: 'Learn first other' } });
  admin = await user('ADMIN', 'admin'); agent = await user('TRAVEL_AGENT', 'agent'); other = await user('TRAVEL_AGENT', 'other'); outsider = await user('TRAVEL_AGENT', 'outsider', otherOrg.id);
  course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'LF training', status: 'PUBLISHED', publishedVersion: 1, createdById: admin.id, mandatory: false } }); // even a non-mandatory training teaches first
  const buf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF');
  const stored = await saveUpload({ buffer: buf, size: buf.length, mimetype: 'application/pdf', originalname: 'guide.pdf' }, 'training');
  const mk = (data) => prisma.trainingModule.create({ data: { courseId: course.id, ...data } });
  video = await mk({ title: 'Intro video', contentType: 'VIDEO', storagePath: 'training/none.mp4', sourceRefJson: '{"durationSeconds":60}', displayOrder: 0 });
  pdf = await mk({ title: 'Guide PDF', contentType: 'PDF', storagePath: stored.storagePath, displayOrder: 1 });
  note = await mk({ title: 'Read this note', contentType: 'NOTE', description: 'Always reprice after a change.', displayOrder: 2 });
  await mk({ title: 'Extra reading', contentType: 'PDF', storagePath: stored.storagePath, required: false, displayOrder: 3 });
  await mk({ title: 'Nothing uploaded yet', contentType: 'VIDEO', displayOrder: 4 }); // a placeholder must never lock anybody out
  quiz = await prisma.assessment.create({ data: { organizationId: org.id, courseId: course.id, createdById: admin.id, createdVia: 'ADMIN_MANUAL', type: 'QUIZ', title: 'LF quiz', status: 'APPROVED', version: 1 } });
  const a = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.id, scope: 'INDIVIDUAL' } });
  recipient = await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: a.id, profileId: agent.id } });
  await prisma.trainingAttempt.create({ data: { recipientId: recipient.id, profileId: agent.id, attemptNumber: 1, status: 'IN_PROGRESS' } });
});
after(async () => { await prisma.$disconnect(); });

test('the practice is locked on the server until every required video, document and note is finished', async () => {
  const gate = await mediaGate(agent.id, course.id);
  assert.equal(gate.unlocked, false); assert.equal(gate.total, 3, 'video + PDF + note; optional and empty placeholders do not count'); assert.equal(gate.done, 0);
  // direct requests are refused, however the learner got the URL
  for (const [method, url] of [['get', `/assessments/${quiz.id}/take`], ['post', `/assessments/${quiz.id}/submit`], ['post', `/training/${recipient.id}/complete`]]) {
    const res = await request(app)[method](url).set('Cookie', cookies[agent.id]);
    assert.equal(res.status, 403, `${method} ${url}`);
  }
  assert.match((await get(agent, `/assessments/${quiz.id}/take`)).text, /Finish the material first/);
  // the training page teaches first: one step at a time, material in order, the practice after it - and locked
  const page = await get(agent, `/training-course/${course.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Step 1 of 7/); assert.match(page.text, /Intro video/);
  assert.match(page.text, /data-unlock-on="media"/);                                   // Next waits for the end of the video
  assert.doesNotMatch(page.text, new RegExp(`/assessments/${quiz.id}/take`), 'no way in from the page either');
  const ahead = await get(agent, `/training-course/${course.id}?step=6`);              // the practice step is locked
  assert.match(ahead.text, /Step 1 of 7/); assert.doesNotMatch(ahead.text, new RegExp(`/assessments/${quiz.id}/take`));
});

test('documents count only after they were opened, given some time, and confirmed — never on a bare request', async () => {
  // never opened: refused
  let res = await post(agent, `/training-material/${pdf.id}/acknowledge`);
  assert.match(res.headers.location, /material=open-first/); assert.equal(await rowOf(agent, pdf), null);
  // opening the file starts the clock; confirming at once is "too fast"
  assert.equal((await get(agent, `/training-file/${pdf.id}`)).status, 200);
  assert.ok(await rowOf(agent, pdf)); assert.equal((await rowOf(agent, pdf)).completedAt, null);
  res = await post(agent, `/training-material/${pdf.id}/acknowledge`);
  assert.match(res.headers.location, /material=too-fast/); assert.equal((await rowOf(agent, pdf)).completedAt, null);
  assert.match((await get(agent, `/training-course/${course.id}?material=too-fast`)).text, /at least 12 seconds/);
  // after enough time it counts
  await prisma.mediaProgress.update({ where: { id: (await rowOf(agent, pdf)).id }, data: { startedAt: ago(30000) } });
  res = await post(agent, `/training-material/${pdf.id}/acknowledge`);
  assert.equal(res.status, 302); assert.doesNotMatch(res.headers.location, /material=/);
  assert.ok((await rowOf(agent, pdf)).completedAt);
  assert.equal((await mediaGate(agent.id, course.id)).done, 1);
  // a note's clock starts when ITS step is on screen - not while the learner is still on an earlier step
  await get(agent, `/training-course/${course.id}`);
  assert.equal(await rowOf(agent, note), null);
  // still locked: the video is not finished
  assert.equal((await get(agent, `/assessments/${quiz.id}/take`)).status, 403);
  assert.match((await get(agent, `/training-course/${course.id}`)).text, /Step 1 of 7/);
});

test('videos and recordings need to be played through (the anti-skip player); only then does the practice open', async () => {
  assert.equal((await mediaGate(agent.id, course.id)).unlocked, false);
  // a video is never completed by a form post
  assert.equal((await post(agent, `/training-material/${video.id}/acknowledge`)).status, 404);
  await prisma.mediaProgress.upsert({ where: { profileId_trainingModuleId: { profileId: agent.id, trainingModuleId: video.id } }, create: { profileId: agent.id, trainingModuleId: video.id, completedAt: new Date(), percentComplete: 100, durationSeconds: 60 }, update: { completedAt: new Date() } });
  // the video is done: the training goes on to the next step not finished - the note - and opening it starts its clock
  let page = await get(agent, `/training-course/${course.id}`);
  assert.match(page.text, /Step 3 of 7/); assert.match(page.text, /Always reprice after a change./);
  assert.ok(await rowOf(agent, note));
  assert.match(page.text, /data-doc-reader data-kind="note"/);                        // read like a document: the line fills as you read
  assert.match(page.text, /data-unlock-on="document"/);                                // and Next opens when it is full
  let res = await post(agent, `/training-material/${note.id}/acknowledge`, { step: 3 });
  assert.match(res.headers.location, /material=too-fast&step=3/);                     // too soon: it stays on the note
  await prisma.mediaProgress.update({ where: { id: (await rowOf(agent, note)).id }, data: { startedAt: ago(30000) } });
  res = await post(agent, `/training-material/${note.id}/acknowledge`, { step: 3 });
  assert.equal(res.headers.location, `/training-course/${course.id}?step=4`);          // Next goes on to the next step
  assert.ok((await rowOf(agent, note)).completedAt);
  const gate = await mediaGate(agent.id, course.id);
  assert.equal(gate.unlocked, true); assert.equal(gate.done, 3);
  // optional reading and an empty placeholder never hold anybody up: the learner is now on the practice
  page = await get(agent, `/training-course/${course.id}`);
  assert.match(page.text, /Step 6 of 7/);
  assert.match(page.text, new RegExp(`href="/assessments/${quiz.id}/take" data-step-next>Start quiz<`));
  assert.equal((await get(agent, `/assessments/${quiz.id}/take`)).status, 200);
});

test('security: only assigned learners record material progress; an admin previewing is never locked', async () => {
  assert.equal((await post(other, `/training-material/${pdf.id}/acknowledge`)).status, 404);  // not assigned
  assert.equal((await post(outsider, `/training-material/${pdf.id}/acknowledge`)).status, 404); // other organization
  assert.equal(await rowOf(other, pdf), null);
  assert.equal((await get(other, `/training-file/${pdf.id}`)).status, 404);
  const preview = await get(admin, `/training-course/${course.id}`);
  assert.equal(preview.status, 200); assert.match(preview.text, /Preview: progress is not recorded/);
  assert.match(preview.text, new RegExp(`href="/training-course/${course.id}\\?step=2" data-step-next>Next<`)); // nothing to wait for
  assert.match((await get(admin, `/training-course/${course.id}?step=6`)).text, /Step 6 of 7/);       // every step open
  assert.equal(await prisma.mediaProgress.count({ where: { profileId: admin.id } }), 0, 'previewing records nothing');
});
