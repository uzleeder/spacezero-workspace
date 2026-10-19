'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gradeAttempt } = require('../lib/practiceGrading');

test('MCQ grades correct and incorrect answers objectively', async () => {
  const questions = [{ id: 'q1', type: 'MCQ', correctAnswerJson: JSON.stringify('B'), skillIdsJson: '[]' }];
  const correct = await gradeAttempt(questions, { q1: 'B' });
  assert.equal(correct.overallScore, 100);
  const wrong = await gradeAttempt(questions, { q1: 'A' });
  assert.equal(wrong.overallScore, 0);
});

// Regression test: Gemini's correctAnswer field is a single STRING even for multi-value
// question types — it comma-separates multiple correct answers into that one string rather
// than returning a real array. Grading must treat "A, B, C" the same as ["A","B","C"].
test('MULTI_SELECT grades correctly when Gemini returns a comma-joined string instead of an array', async () => {
  const questions = [{
    id: 'q1',
    type: 'MULTI_SELECT',
    correctAnswerJson: JSON.stringify('Flexible dates, Lounge access, Extra baggage'),
    skillIdsJson: '[]',
  }];
  const graded = await gradeAttempt(questions, { q1: ['Flexible dates', 'Lounge access', 'Extra baggage'] });
  assert.equal(graded.overallScore, 100, 'selecting exactly the comma-joined correct answers should score 100');

  const partial = await gradeAttempt(questions, { q1: ['Flexible dates'] });
  assert.equal(partial.overallScore, 0, 'an incomplete selection should not be marked fully correct');
});

test('MULTI_SELECT also grades correctly when Gemini returns a real array', async () => {
  const questions = [{ id: 'q1', type: 'MULTI_SELECT', correctAnswerJson: JSON.stringify(['A', 'B']), skillIdsJson: '[]' }];
  const graded = await gradeAttempt(questions, { q1: ['B', 'A'] });
  assert.equal(graded.overallScore, 100, 'order should not matter for multi-select');
});

test('ORDERING requires the exact sequence, comma-joined or array form', async () => {
  const questions = [{ id: 'q1', type: 'ORDERING', correctAnswerJson: JSON.stringify('Step 1, Step 2, Step 3'), skillIdsJson: '[]' }];
  const correct = await gradeAttempt(questions, { q1: ['Step 1', 'Step 2', 'Step 3'] });
  assert.equal(correct.overallScore, 100);
  const wrongOrder = await gradeAttempt(questions, { q1: ['Step 2', 'Step 1', 'Step 3'] });
  assert.equal(wrongOrder.overallScore, 0);
});

test('TRUE_FALSE grading is case-insensitive', async () => {
  const questions = [{ id: 'q1', type: 'TRUE_FALSE', correctAnswerJson: JSON.stringify('False'), skillIdsJson: '[]' }];
  const graded = await gradeAttempt(questions, { q1: 'false' });
  assert.equal(graded.overallScore, 100);
});

test('skill breakdown averages scores per tagged skill across questions', async () => {
  const questions = [
    { id: 'q1', type: 'MCQ', correctAnswerJson: JSON.stringify('A'), skillIdsJson: JSON.stringify(['Objection Handling']) },
    { id: 'q2', type: 'MCQ', correctAnswerJson: JSON.stringify('A'), skillIdsJson: JSON.stringify(['Objection Handling', 'Closing']) },
  ];
  const graded = await gradeAttempt(questions, { q1: 'A', q2: 'B' }); // q1 correct (100), q2 wrong (0)
  assert.equal(graded.skillBreakdown['Objection Handling'], 50); // (100+0)/2
  assert.equal(graded.skillBreakdown['Closing'], 0); // only q2 touches it, which was wrong
});

// An option may itself contain a comma: the correct answers are a real list, and an older comma-joined key is
// rebuilt against the options instead of being cut apart at every comma.
const commaOptions = JSON.stringify(['Seat selection, meals', 'Lounge access', 'Wi-Fi']);

test('MULTI_SELECT with an option that contains a comma grades correctly (list key and older comma-joined key)', async () => {
  for (const key of [['Seat selection, meals', 'Lounge access'], 'Seat selection, meals,Lounge access']) {
    const questions = [{ id: 'q1', type: 'MULTI_SELECT', optionsJson: commaOptions, correctAnswerJson: JSON.stringify(key), skillIdsJson: '[]' }];
    assert.equal((await gradeAttempt(questions, { q1: ['Lounge access', 'Seat selection, meals'] })).overallScore, 100, `key ${JSON.stringify(key)}`);
    assert.equal((await gradeAttempt(questions, { q1: ['Lounge access'] })).overallScore, 0);
  }
});

test('a single checked box is one whole option, never split at its comma', async () => {
  const questions = [{ id: 'q1', type: 'MULTI_SELECT', optionsJson: commaOptions, correctAnswerJson: JSON.stringify(['Seat selection, meals']), skillIdsJson: '[]' }];
  assert.equal((await gradeAttempt(questions, { q1: 'Seat selection, meals' })).overallScore, 100);
});

test('ORDERING steps that contain commas keep their sequence', async () => {
  const optionsJson = JSON.stringify(['Check dates, cabin and stops', 'Search availability', 'Quote the options']);
  const questions = [{ id: 'q1', type: 'ORDERING', optionsJson, correctAnswerJson: JSON.stringify('Check dates, cabin and stops,Search availability,Quote the options'), skillIdsJson: '[]' }];
  assert.equal((await gradeAttempt(questions, { q1: ['Check dates, cabin and stops', 'Search availability', 'Quote the options'] })).overallScore, 100);
  assert.equal((await gradeAttempt(questions, { q1: ['Search availability', 'Check dates, cabin and stops', 'Quote the options'] })).overallScore, 0);
});

test('a single-choice key copied with different case or punctuation still matches its option', async () => {
  const questions = [{ id: 'q1', type: 'MCQ', optionsJson: JSON.stringify(['Check the fare rules first', 'Quote at once']), correctAnswerJson: JSON.stringify('check the fare rules first.'), skillIdsJson: '[]' }];
  assert.equal((await gradeAttempt(questions, { q1: 'Check the fare rules first' })).overallScore, 100);
});
