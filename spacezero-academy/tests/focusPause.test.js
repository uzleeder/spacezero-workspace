'use strict';
// Training video / audio pauses when the learner leaves the window (another tab, another program, minimised) and
// stays paused until they press play again.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const app = require('../server');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'focus-pause.js'), 'utf8');

// A hand-made page: one <video data-learning-media>, a window and a document that record their listeners.
function makePage({ hasFocus = true, hidden = false } = {}) {
  const listeners = { window: {}, document: {}, media: {} };
  const inserted = [];
  const media = {
    paused: false, ended: false, dataset: { learningMedia: 'm1' },
    pause() { this.paused = true; },
    play() { this.paused = false; (listeners.media.play || []).forEach((fn) => fn()); },
    addEventListener(name, fn) { (listeners.media[name] = listeners.media[name] || []).push(fn); },
    closest() { return { insertAdjacentElement: (where, el) => inserted.push({ where, el }) }; },
  };
  const document = {
    hidden, hasFocus: () => hasFocus,
    querySelectorAll: () => [media],
    createElement: () => ({ setAttribute() {}, hidden: false, textContent: '', className: '' }),
    addEventListener: (n, fn) => { (listeners.document[n] = listeners.document[n] || []).push(fn); },
  };
  const window = { addEventListener: (n, fn) => { (listeners.window[n] = listeners.window[n] || []).push(fn); } };
  vm.runInNewContext(source, { window, document, Array });
  const fire = (target, name) => (listeners[target][name] || []).forEach((fn) => fn());
  return { media, document, inserted, fire };
}

test('leaving the window (another program, another tab, minimised) pauses the video and shows why', () => {
  for (const how of [(p) => p.fire('window', 'blur'), (p) => { p.document.hidden = true; p.fire('document', 'visibilitychange'); }, (p) => p.fire('window', 'pagehide')]) {
    const page = makePage();
    assert.equal(page.media.paused, false);
    how(page);
    assert.equal(page.media.paused, true);
    assert.equal(page.inserted.length, 1);
    assert.match(page.inserted[0].el.textContent, /Paused because you left this window/);
    assert.equal(page.inserted[0].el.hidden, false);
  }
});

test('it never resumes by itself; pressing play with the window active continues and hides the note', () => {
  const page = makePage();
  page.fire('window', 'blur');
  assert.equal(page.media.paused, true);
  page.fire('window', 'focus'); page.fire('document', 'visibilitychange');
  assert.equal(page.media.paused, true);                         // coming back does not restart it
  page.media.play();
  assert.equal(page.media.paused, false);
  assert.equal(page.inserted[0].el.hidden, true);
});

test('play does not start while the window is not the active one or the tab is hidden; already paused or ended media is left alone', () => {
  const away = makePage({ hasFocus: false });
  away.media.paused = true; away.media.play();
  assert.equal(away.media.paused, true);
  const tab = makePage({ hidden: true });
  tab.media.paused = true; tab.media.play();
  assert.equal(tab.media.paused, true);
  const ended = makePage(); ended.media.ended = true; ended.fire('window', 'blur');
  assert.equal(ended.inserted.length, 0);
});

test('the training page loads the script for learners, not for people who have no assignment of it', async () => {
  const org = await prisma.organization.create({ data: { name: 'Focus pause tests' } });
  const mk = async (role, name) => {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `FP ${name}`, username: `fp_${org.id}_${name}`, email: `fp_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
    const t = generateToken(); await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } });
    return { p, cookie: `sz_session=${t.raw}` };
  };
  const admin = await mk('ADMIN', 'admin'); const agent = await mk('TRAVEL_AGENT', 'agent');
  const course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Focus course', createdById: admin.p.id, status: 'PUBLISHED', modules: { create: [{ title: 'Note', contentType: 'NOTE', description: 'read me' }] } } });
  const assignment = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.p.id, scope: 'INDIVIDUAL' } });
  await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: assignment.id, profileId: agent.p.id } });
  const learner = await request(app).get(`/training-course/${course.id}`).set('Cookie', agent.cookie);
  assert.equal(learner.status, 200);
  assert.match(learner.text, /\/static\/js\/focus-pause\.js\?v=/);
  const preview = await request(app).get(`/training-course/${course.id}`).set('Cookie', admin.cookie);
  assert.doesNotMatch(preview.text, /focus-pause\.js/);
  await prisma.$disconnect();
});
