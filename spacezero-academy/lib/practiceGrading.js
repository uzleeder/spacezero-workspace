'use strict';

// Objective grading for MCQ/MULTI_SELECT/ORDERING/MATCHING/TRUE_FALSE happens locally
// (deterministic, no AI call needed). SCENARIO/SHORT_ANSWER free-text answers are graded by a
// single batched Gemini call per attempt, comparing each answer against its correctAnswer/
// explanation — never trusted blindly: the response is Zod-validated like every other Gemini
// call, and a failed grading call fails the whole submission rather than silently guessing.
const { z } = require('zod');
const { Type } = require('@google/genai');
const { generateStructured } = require('./gemini');
const { safeParse } = require('./practiceEngine');
const { correctOf } = require('./correctAnswers');

function normalize(value) {
  return String(value ?? '').trim().toLowerCase();
}

// A learner's answer to a multi-answer question arrives as a list of option texts (or one text).
const toArray = (value) => (Array.isArray(value) ? value : value == null || value === '' ? [] : [value]);

function gradeObjective(question, learnerAnswer) {
  // For the multi-answer types this is the real list of option texts, even when an option contains a comma and the
  // answer was stored as one comma-joined string (lib/correctAnswers.js reads it back through the options).
  const correct = correctOf(question);
  if (question.type === 'MCQ' || question.type === 'TRUE_FALSE') {
    const isCorrect = normalize(learnerAnswer) === normalize(correct);
    return { isCorrect, scorePercent: isCorrect ? 100 : 0 };
  }
  if (question.type === 'MULTI_SELECT' || question.type === 'MATCHING') {
    const correctSet = new Set(correct.map(normalize));
    const answerSet = new Set(toArray(learnerAnswer).filter(Boolean).map(normalize));
    const isCorrect = correctSet.size === answerSet.size && [...correctSet].every((v) => answerSet.has(v));
    return { isCorrect, scorePercent: isCorrect ? 100 : 0 };
  }
  if (question.type === 'ORDERING') {
    const correctArr = correct.map(normalize);
    const answerArr = toArray(learnerAnswer).map(normalize);
    const isCorrect = correctArr.length === answerArr.length && correctArr.every((v, i) => v === answerArr[i]);
    return { isCorrect, scorePercent: isCorrect ? 100 : 0 };
  }
  return null; // free-text — graded by Gemini
}

const freeTextZodSchema = z.object({
  results: z.array(z.object({ index: z.number().int(), scorePercent: z.number().min(0).max(100), feedback: z.string() })),
});
const freeTextGeminiSchema = {
  type: Type.OBJECT,
  properties: {
    results: {
      type: Type.ARRAY,
      items: { type: Type.OBJECT, properties: { index: { type: Type.INTEGER }, scorePercent: { type: Type.INTEGER }, feedback: { type: Type.STRING } }, required: ['index', 'scorePercent', 'feedback'] },
    },
  },
  required: ['results'],
};

async function gradeFreeTextBatch(items) {
  if (items.length === 0) return [];
  const prompt = items.map((it, i) => `[${i}] Question: ${it.question.prompt}\nExpected/acceptable answer: ${JSON.stringify(safeParse(it.question.correctAnswerJson, ''))}\nLearner's answer: ${it.learnerAnswer || '(blank)'}`).join('\n\n');
  const result = await generateStructured({
    systemInstruction: 'Grade each learner answer 0-100 against the expected answer for a corporate training assessment. Give partial credit for a substantively correct answer even if worded differently; 0 for blank or wrong. One short sentence of feedback per item.',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    responseSchema: freeTextGeminiSchema,
    zodSchema: freeTextZodSchema,
  });
  if (result.data.results.length !== items.length || new Set(result.data.results.map(r => r.index)).size !== items.length || result.data.results.some(r => r.index < 0 || r.index >= items.length)) throw new Error('AI grading returned missing or duplicate answers. Please retry.');
  return result.data.results;
}

/**
 * Grades a full attempt. Returns { overallScore, perQuestion: [{questionId, scorePercent, isCorrect, feedback}], skillBreakdown: {skillName: {correct, total}} }
 */
async function gradeAttempt(questions, answers) {
  const perQuestion = new Array(questions.length);
  const freeTextIndices = [];

  questions.forEach((q, i) => {
    const objective = gradeObjective(q, answers[q.id]);
    if (objective) perQuestion[i] = { questionId: q.id, ...objective };
    else freeTextIndices.push(i);
  });

  if (freeTextIndices.length > 0) {
    const items = freeTextIndices.map((i) => ({ question: questions[i], learnerAnswer: answers[questions[i].id] }));
    const graded = await gradeFreeTextBatch(items);
    for (const g of graded) {
      const i = freeTextIndices[g.index];
      if (i === undefined) continue;
      perQuestion[i] = { questionId: questions[i].id, scorePercent: g.scorePercent, isCorrect: g.scorePercent >= 70, feedback: g.feedback };
    }
  }

  // Any question the grader never returned a result for (shouldn't normally happen) counts as 0.
  for (let i = 0; i < questions.length; i++) if (!perQuestion[i]) throw new Error('Incomplete grading. No attempt was saved.');

  const overallScore = perQuestion.length ? Math.round(perQuestion.reduce((sum, p) => sum + p.scorePercent, 0) / perQuestion.length) : 0;

  const skillBreakdown = {};
  questions.forEach((q, i) => {
    const skills = safeParse(q.skillIdsJson, []);
    for (const skill of skills) {
      skillBreakdown[skill] = skillBreakdown[skill] || { totalScore: 0, count: 0 };
      skillBreakdown[skill].totalScore += perQuestion[i].scorePercent;
      skillBreakdown[skill].count += 1;
    }
  });
  const skillAverages = Object.fromEntries(
    Object.entries(skillBreakdown).map(([name, v]) => [name, Math.round(v.totalScore / v.count)])
  );

  return { overallScore, perQuestion, skillBreakdown: skillAverages };
}

module.exports = { gradeAttempt };
