'use strict';
// The training page goes through a training ONE step at a time (lib/trainingSteps.js): material in order, then the
// practices, then "Training complete". A learner is on the first step not finished and cannot go past it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stepsOf, stepToShow, materialKind } = require('../lib/trainingSteps');

const mod = (id, contentType, extra = {}) => ({ id, title: id, contentType, storagePath: 'training/x', ...extra });
const modules = [mod('video', 'VIDEO'), mod('note', 'NOTE', { storagePath: null, description: 'Text' }), mod('extra', 'PDF'), mod('pdf', 'PDF')];
const assessments = [{ id: 'quiz', title: 'Quiz', type: 'QUIZ' }, { id: 'role', title: 'Role-play', type: 'ROLEPLAY' }];
const requiredIds = new Set(['video', 'note', 'pdf']); // "extra" is optional reading

test('steps: material in order, then the practices, then the finish step; the learner is on the first one not finished', () => {
  let plan = stepsOf({ modules, assessments, isLearner: true, requiredIds });
  assert.deepEqual(plan.steps.map((s) => [s.number, s.kind, s.title]), [[1, 'video', 'video'], [2, 'note', 'note'], [3, 'document', 'extra'], [4, 'document', 'pdf'], [5, 'practice', 'Quiz'], [6, 'practice', 'Role-play'], [7, 'finish', 'Training complete']]);
  assert.equal(plan.current, 0);
  assert.deepEqual(plan.steps.map((s) => s.open), [true, false, false, false, false, false, false]); // nothing past the current step
  // the video and the note done: optional reading never holds anybody up, the PDF is next
  plan = stepsOf({ modules, assessments, isLearner: true, requiredIds, doneIds: new Set(['video', 'note']) });
  assert.equal(plan.current, 3);
  assert.equal(stepToShow(plan, '1'), 0);       // going back is fine
  assert.equal(stepToShow(plan, '3'), 2);       // so is optional reading before the current step
  assert.equal(stepToShow(plan, '6'), 3);       // going ahead is not: the current step instead
  assert.equal(stepToShow(plan, 'junk'), 3);
  // everything done and passed: the finish step
  plan = stepsOf({ modules, assessments, isLearner: true, requiredIds, doneIds: new Set(['video', 'note', 'pdf']), passedIds: new Set(['quiz', 'role']) });
  assert.equal(plan.current, 6); assert.equal(plan.steps[6].kind, 'finish');
  assert.deepEqual(plan.steps.slice(4, 6).map((s) => [s.label, s.done]), [['Quiz', true], ['Role-play', true]]);
});

test('a preview starts at the beginning and can open every step; nothing blocks', () => {
  const plan = stepsOf({ modules, assessments, isLearner: false, requiredIds });
  assert.equal(plan.current, 0);
  assert.ok(plan.steps.every((s) => s.open && !s.blocking));
  assert.equal(stepToShow(plan, '6'), 5);
});

test('what kind of step each piece of material is', () => {
  assert.equal(materialKind(mod('a', 'AUDIO')), 'audio');
  assert.equal(materialKind(mod('r', 'CALL_RECORDING')), 'audio');
  assert.equal(materialKind(mod('v', 'VIDEO', { storagePath: null })), 'missing');           // nothing uploaded yet
  assert.equal(materialKind(mod('l', 'LINK', { storagePath: null, externalUrl: 'https://example.com' })), 'link');
  assert.equal(materialKind(mod('l2', 'LINK', { storagePath: null, externalUrl: 'javascript:alert(1)' })), 'missing');
  assert.equal(materialKind(mod('d', 'DOC')), 'document');
});
