'use strict';
// Quizzes cannot be copied, pasted into, printed or casually captured by learners; Admins (who preview and review) are not
// restricted. A web page cannot stop a phone camera, so the protection is a deterrent plus a trace (the watermark).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const app = require('../server');

let org, admin, agent, quiz, role, cookies = {};
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Quiz protection tests' } });
  const mk = async (role, name) => {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `QP ${name}`, username: `qp_${org.id}_${name}`, email: `qp_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
    const t = generateToken(); await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookies[p.id] = `sz_session=${t.raw}`;
    return p;
  };
  admin = await mk('ADMIN', 'admin'); agent = await mk('TRAVEL_AGENT', 'agent');
  const course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Guarded course', createdById: admin.id, status: 'PUBLISHED' } });
  const assignment = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.id, scope: 'INDIVIDUAL' } });
  await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: assignment.id, profileId: agent.id } });
  quiz = await prisma.assessment.create({ data: { organizationId: org.id, courseId: course.id, createdVia: 'ADMIN_MANUAL', type: 'QUIZ', status: 'APPROVED', title: 'Guarded quiz', createdById: admin.id, version: 1 } });
  await prisma.question.create({ data: { assessmentId: quiz.id, type: 'MCQ', prompt: 'Which?', optionsJson: JSON.stringify(['A', 'B']), correctAnswerJson: JSON.stringify('A'), displayOrder: 0 } });
  role = await prisma.assessment.create({ data: { organizationId: org.id, courseId: course.id, createdVia: 'ADMIN_MANUAL', type: 'ROLEPLAY', status: 'APPROVED', title: 'Guarded role-play', createdById: admin.id, version: 1 } });
});
after(async () => { await prisma.$disconnect(); });

test('a learner\'s quiz and role-play pages carry the guard, the watermark with their own name, and are never cached', async () => {
  for (const url of [`/assessments/${quiz.id}/take`, `/assessments/${role.id}/roleplay`]) {
    const page = await get(agent, url);
    assert.equal(page.status, 200, url);
    assert.match(page.text, /data-quiz-watermark="QP agent · @qp_[^"]+ · \d{4}-\d\d-\d\d \d\d:\d\d UTC"/, url);
    assert.match(page.text, /data-quiz-cover hidden/);
    assert.match(page.text, /\/static\/js\/protect-quiz\.js\?v=/);
    assert.match(page.headers['cache-control'], /no-store/);
  }
});

test('Admins are not restricted: the guard renders for learners and supervisors only', async () => {
  const render = (profile) => ejs.renderFile(path.join(root, 'views/partials/quiz-guard.ejs'), { profile, asset: (p) => p });
  assert.equal((await render({ role: 'ADMIN', fullName: 'A', username: 'a' })).trim(), '');
  for (const r of ['TRAVEL_AGENT', 'FLIGHT_EXPERT', 'SUPERVISOR']) assert.match(await render({ role: r, fullName: 'Pat Doe', username: 'pat' }), /data-quiz-watermark="Pat Doe · @pat/);
  assert.equal((await render(undefined)).trim(), '');
});

test('every practice and result page includes the guard', () => {
  for (const f of ['quiz', 'process', 'voice', 'roleplay', 'quiz-result', 'roleplay-result']) assert.match(read(`views/practice/${f}.ejs`), /include\('\.\.\/partials\/quiz-guard'\)/, f);
});

test('the guard script blocks copy, cut, paste (by any route), drag, the context menu, print, capture keys and hides the page without focus', () => {
  const js = read('public/js/protect-quiz.js');
  for (const piece of [
    "'copy', 'cut', 'paste', 'dragstart', 'dragover', 'drop', 'contextmenu'",   // clipboard, drag and drop, menu
    'insertFrom(Paste|Drop|Yank)',                                              // pasting by menu / middle click / drag
    "'c', 'x', 'v', 's', 'p', 'u'",                                             // Ctrl/Cmd + C X V S P U
    "key === 'insert'",                                                         // Shift+Insert / Ctrl+Insert
    "key === 'f12'",                                                            // developer tools
    "'3', '4', '5', 's'",                                                       // macOS / Windows capture shortcuts
    "event.key === 'PrintScreen'",                                              // PrintScreen
    'navigator.clipboard.writeText',                                            // the clipboard is emptied
    "window.addEventListener('blur'", "document.addEventListener('visibilitychange'", // hidden without focus
    "window.addEventListener('beforeprint'",
    'MutationObserver',                                                         // the watermark is put back if removed
  ]) assert.ok(js.includes(piece), piece);
  const css = read('public/css/styles.css');
  assert.match(css, /body\.quiz-guarded, body\.quiz-guarded \* \{ -webkit-user-select: none; user-select: none;/);
  assert.match(css, /body\.quiz-guarded input, body\.quiz-guarded textarea \{ -webkit-user-select: text; user-select: text; \}/); // typing still works
  assert.match(css, /@media print \{ body\.quiz-guarded > \* \{ display: none !important; \}/);
  assert.match(css, /\.quiz-watermark \{ position: fixed; inset: 0; z-index: 9990; pointer-events: none;/);
  assert.doesNotThrow(() => new Function(js)); // it parses
});
