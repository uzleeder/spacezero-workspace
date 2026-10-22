'use strict';
// ONE retake path: after any failed try, Try again opens a new set of questions on the weak skills - at the same
// difficulty and pass mark as the original - and the wait after a failed try (training.retakeWaitMinutes) applies to
// the whole family: the original quiz, every new set, and the fallback to the original "as it is". No limit on tries.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const gemini = require('../lib/gemini');
let written = 8; let broken = 0; const prompts = [];
mock.method(gemini, 'generateStructured', async (input) => {
  prompts.push(input);
  // `broken` questions have no correct answer among their options (they cannot be fixed by the rewrite either)
  const item = (i) => (i < broken
    ? { type: 'MCQ', prompt: `Broken ${i}`, options: ['A', 'B'], correctAnswer: 'Neither', skillNames: ['Discovery'] }
    : { type: 'MCQ', prompt: `Set question ${i}`, options: ['Right', 'Wrong'], correctAnswer: 'Right', skillNames: ['Discovery'] });
  const isRepair = /correct answer is not one of the options/.test(JSON.stringify(input.contents));
  return { modelVersion: 'test', data: { questions: isRepair ? [] : Array.from({ length: written }, (_, i) => item(i)) } };
});
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const app = require('../server');

let org, admin; const cookies = {}; let n = 0;
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const idIn = (location) => location.split('/')[2];
async function person(role = 'TRAVEL_AGENT') {
  n += 1;
  const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: `Path ${n}`, username: `rp_${org.id}_${n}`, email: `rp_${org.id}_${n}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
  const t = generateToken(); await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookies[p.id] = `sz_session=${t.raw}`;
  return p;
}
/** A quiz of `count` questions (level 2, pass mark 80) in a training whose assignment asks at least `minimumScore`. */
async function setup({ count = 10, minimumScore = 70 } = {}) {
  const course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: `Path ${++n}`, createdById: admin.id, status: 'PUBLISHED', passingScore: 70, publishedVersion: 1, analysis: { create: { status: 'APPROVED' } } } });
  const quiz = await prisma.assessment.create({ data: { organizationId: org.id, courseId: course.id, createdVia: 'ADMIN_MANUAL', type: 'QUIZ', title: 'Original quiz', status: 'APPROVED', level: 2, passingScore: 80, createdById: admin.id, version: 1 } });
  for (let i = 0; i < count; i += 1) await prisma.question.create({ data: { assessmentId: quiz.id, type: 'MCQ', prompt: `Original ${i}`, optionsJson: JSON.stringify(['Right', 'Wrong']), correctAnswerJson: JSON.stringify('Right'), skillIdsJson: JSON.stringify(['Discovery']), displayOrder: i } });
  const learner = await person();
  const assignment = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.id, scope: 'INDIVIDUAL', courseVersion: 1, minimumScore } });
  const recipient = await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: assignment.id, profileId: learner.id } });
  return { course, quiz, learner, recipient };
}
const answerAll = async (learner, assessment, value) => {
  const qs = await prisma.question.findMany({ where: { assessmentId: assessment.id } });
  return post(learner, `/assessments/${assessment.id}/submit`, Object.fromEntries(qs.map((q) => [`q_${q.id}`, value])));
};
const rewind = (learner, minutes) => prisma.trainingAttempt.updateMany({ where: { profileId: learner.id, assessmentId: { not: null } }, data: { completedAt: new Date(Date.now() - minutes * 60000) } });

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Retake path tests' } }); // the default 10-minute wait
  admin = await person('ADMIN');
});
after(async () => { mock.restoreAll(); await prisma.$disconnect(); });

test('a failed try starts the wait for the whole practice: the result counts down, Try again is not even prepared yet', async () => {
  const { quiz, learner, course } = await setup();
  const failed = await answerAll(learner, quiz, 'Wrong');
  assert.match(failed.text, /Not passed yet/);
  assert.match(failed.text, /You can try again in <strong data-retake-left>10 minutes<\/strong>/);
  assert.match(failed.text, new RegExp(`href="/training-course/${course.id}\\?step=1" data-retake-review>Review the material<`));
  assert.match(failed.text, /data-retake-try hidden>/);                                     // Try again appears when the countdown ends
  const before = prompts.length;
  const early = await post(learner, `/assessments/${quiz.id}/remediate`);                  // pressing it early anyway (an old tab)
  assert.equal(early.status, 429); assert.match(early.text, /You can try again in/);
  assert.equal(prompts.length, before);                                                      // nothing prepared, no AI spent
  assert.equal((await get(learner, `/assessments/${quiz.id}/take`)).status, 429);           // the original waits too
});

test('Try again after the wait: a new set at the SAME difficulty and pass mark, on the weak skills, at least 8 questions; its failure starts the wait for the original too', async () => {
  const { quiz, learner } = await setup({ minimumScore: 85 });
  await answerAll(learner, quiz, 'Wrong');
  await rewind(learner, 11);
  const response = await post(learner, `/assessments/${quiz.id}/remediate`);
  assert.equal(response.status, 302);
  const set = await prisma.assessment.findUnique({ where: { id: idIn(response.headers.location) } });
  assert.equal(set.level, 2);                                                                // not one level harder
  assert.equal(set.passingScore, 80);                                                        // the original quiz's own pass mark
  const prompt = prompts.at(-1);
  assert.match(JSON.stringify(prompt.contents), /8 questions/);                              // at least 8 asked for
  assert.match(prompt.systemInstruction, /SAME difficulty as the original practice/); assert.doesNotMatch(prompt.systemInstruction, /HIGHER difficulty/);
  const page = await get(learner, response.headers.location);
  assert.equal(page.status, 200);
  assert.match(page.text, /85%/);                                                            // the assignment's minimum still applies on top
  // failing the new set starts the wait for the original quiz and for another set alike
  await answerAll(learner, set, 'Wrong');
  assert.equal((await get(learner, `/assessments/${quiz.id}/take`)).status, 429);
  assert.equal((await post(learner, `/assessments/${quiz.id}/remediate`)).status, 429);
  assert.equal((await post(learner, `/assessments/${set.id}/remediate`)).status, 429);
});

test('an unused set prepared for an OLDER failure is never reopened: each new failure gets its own set', async () => {
  const { quiz, learner } = await setup();
  await answerAll(learner, quiz, 'Wrong');
  await rewind(learner, 11);
  const first = idIn((await post(learner, `/assessments/${quiz.id}/remediate`)).headers.location);
  assert.equal((await post(learner, `/assessments/${quiz.id}/remediate`)).headers.location.split('/')[2], first); // a second tap: the same set
  await prisma.assessment.update({ where: { id: first }, data: { createdAt: new Date(Date.now() - 30 * 60000) } }); // prepared a while ago
  // the learner then fails the original quiz as it is (the fallback) - a newer failure than the one the set was made for
  await answerAll(learner, quiz, 'Wrong');
  await rewind(learner, 11);
  const second = idIn((await post(learner, `/assessments/${quiz.id}/remediate`)).headers.location);
  assert.notEqual(second, first);
});

test('a set that keeps fewer than 5 usable questions is not offered: the fallback is the original quiz, and the wait applies to it', async () => {
  const { quiz, learner } = await setup();
  await answerAll(learner, quiz, 'Wrong');
  await rewind(learner, 11);
  written = 8; broken = 4;                                                                   // only 4 good questions
  const response = await post(learner, `/assessments/${quiz.id}/remediate`);
  written = 8; broken = 0;
  assert.equal(response.status, 503);
  assert.match(response.text, /A new set of questions could not be prepared right now\./);
  assert.match(response.text, new RegExp(`href="/assessments/${quiz.id}/take" data-result-next>Take the quiz as it is<`));
  assert.equal(await prisma.assessment.count({ where: { courseId: quiz.courseId } }), 1);  // nothing half-made was saved
  // the fallback: the original quiz opens now (the wait is over); failing it starts the wait again
  assert.equal((await get(learner, `/assessments/${quiz.id}/take`)).status, 200);
  await answerAll(learner, quiz, 'Wrong');
  const waiting = await get(learner, `/assessments/${quiz.id}/take`);
  assert.equal(waiting.status, 429); assert.match(waiting.text, />Review the material</);
});

test('a short original quiz: the set asks for as many questions as the original has, and needs that many', async () => {
  const { quiz, learner } = await setup({ count: 3 });
  await answerAll(learner, quiz, 'Wrong');
  await rewind(learner, 11);
  written = 3;
  const response = await post(learner, `/assessments/${quiz.id}/remediate`);
  written = 8;
  assert.equal(response.status, 302);
  assert.match(JSON.stringify(prompts.at(-1).contents), /3 questions/);
});

test('review mode: a finished required video keeps no speed cap, free seeking and keeps playing when the window is left', () => {
  const fs = require('fs'); const path = require('path');
  const media = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'media-progress.js'), 'utf8');
  assert.match(media, /if \(!finished\(\) && media\.playbackRate > 1\.2\) media\.playbackRate = 1\.2;/);
  assert.match(media, /if \(!finished\(\) && media\.currentTime > frontier \+ 1\)/);
  assert.match(media, /if \(finished\(\) && announced\) return Promise\.resolve\(\{ skipped: true \}\);/);
  const focus = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'focus-pause.js'), 'utf8');
  assert.match(focus, /if \(el\.paused \|\| el\.ended \|\| el\.dataset\.done === 'true'\) return;/);
});
