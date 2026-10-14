'use strict';

// Admin review tools for AI-generated practice (AI Practice → Ready for Review). Everything here
// changes ONE thing at a time: a single question can be regenerated without touching the others,
// and an "ask the AI" prompt revises only what the instruction affects. Any edit to an already
// approved practice sends it back to review, so nothing changes under learners' feet unnoticed.
const { z } = require('zod');
const { prisma } = require('./prisma');
const { generateStructured } = require('./gemini');
const { shuffleOptions } = require('./shuffleOptions');
const { QUESTION_TYPES, LEVEL_GUIDANCE, TYPE_GUIDANCE, questionZodSchema, questionGeminiSchema, roleplayZodSchema, roleplayGeminiSchema, safeParse } = require('./practiceEngine');

const QUESTION_ASSESSMENTS = ['QUIZ', 'TECHNICAL', 'PROCESS_SIM', 'PRODUCT_KNOWLEDGE'];
const CONFIG_ASSESSMENTS = ['ROLEPLAY', 'VOICE'];
// Question types an Admin can author by hand (the rest can be edited for wording and regenerated).
const HAND_EDITABLE = ['MCQ', 'MULTI_SELECT', 'TRUE_FALSE', 'SHORT_ANSWER'];
const MIN_PASSING = 70;

const oneQuestionZod = z.object({
  type: z.enum(QUESTION_TYPES),
  prompt: z.string().min(3),
  options: z.array(z.string()).optional(),
  correctAnswer: z.union([z.string(), z.array(z.string())]),
  explanation: z.string().optional(),
  skillNames: z.array(z.string()).max(4).optional(),
  sourceTitle: z.string().optional(),
  sourceLocation: z.string().optional(),
});
const oneQuestionGemini = questionGeminiSchema.properties.questions.items;

const lines = (value) => String(value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const clip = (value, max) => String(value ?? '').trim().slice(0, max);

/** Validates a hand-written question. Returns { error } or { data } ready for prisma. */
function readQuestionForm(body, fixedType = null) {
  const type = fixedType || String(body.type || '');
  if (!QUESTION_TYPES.includes(type)) return { error: 'Choose a question type.' };
  const prompt = clip(body.prompt, 1000);
  if (prompt.length < 3) return { error: 'Write the question.' };
  const explanation = clip(body.explanation, 1000) || null;
  const skills = lines(String(body.skills || '').replace(/,/g, '\n')).slice(0, 4);
  const base = { type, prompt, explanation, skillIdsJson: JSON.stringify(skills) };

  if (!HAND_EDITABLE.includes(type)) return { data: base, wordingOnly: true }; // ORDERING / MATCHING / SCENARIO keep their structure

  if (type === 'TRUE_FALSE') {
    const answer = String(body.correctAnswer || '').toLowerCase() === 'false' ? 'False' : 'True';
    return { data: { ...base, optionsJson: JSON.stringify(['True', 'False']), correctAnswerJson: JSON.stringify(answer) } };
  }
  if (type === 'SHORT_ANSWER') {
    const answer = clip(body.correctAnswer, 1000);
    if (!answer) return { error: 'Write the expected answer.' };
    return { data: { ...base, optionsJson: null, correctAnswerJson: JSON.stringify(answer) } };
  }
  const options = lines(body.options).slice(0, 8);
  if (options.length < 2) return { error: 'Give at least two answer options, one per line.' };
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return { error: 'Answer options must be different from each other.' };
  const correct = lines(String(body.correctAnswer || '').replace(/;/g, '\n'));
  const matched = correct.map((c) => options.find((o) => o.toLowerCase() === c.toLowerCase())).filter(Boolean);
  if (!correct.length || matched.length !== correct.length) return { error: 'The correct answer must be one of the options (copy it exactly).' };
  if (type === 'MCQ' && matched.length !== 1) return { error: 'A single-choice question has exactly one correct answer.' };
  return { data: { ...base, optionsJson: JSON.stringify(options), correctAnswerJson: JSON.stringify(type === 'MCQ' ? matched[0] : matched.join(',')) } };
}

/** An edit to an approved practice sends it back to review. */
async function reopenIfApproved(tx, assessment) {
  if (assessment.status === 'APPROVED') {
    await tx.assessment.update({ where: { id: assessment.id }, data: { status: 'AI_GENERATED', approvedById: null, approvedAt: null } });
    return true;
  }
  return false;
}

async function courseContext(assessment) {
  const course = assessment.course;
  const analysis = course ? await prisma.trainingAnalysis.findUnique({ where: { courseId: course.id } }) : null;
  return {
    title: course ? course.title : assessment.title,
    text: analysis
      ? `Critical knowledge: ${analysis.criticalKnowledgeJson}\nPractical behaviors: ${analysis.practicalBehaviorsJson}\nCommon mistakes: ${analysis.commonMistakesJson}\nRelevant skills: ${analysis.extractedSkillsJson}`
      : '',
  };
}

const persistQuestionData = (q) => ({
  type: q.type,
  prompt: q.prompt,
  // The AI writes the correct answer first; stir the choices so it is not always "A".
  optionsJson: q.options ? JSON.stringify(shuffleOptions(q.type, q.options)) : null,
  correctAnswerJson: JSON.stringify(q.correctAnswer),
  explanation: q.explanation || null,
  skillIdsJson: JSON.stringify(q.skillNames || []),
  sourceRefJson: q.sourceTitle ? JSON.stringify({ title: q.sourceTitle, location: q.sourceLocation || '' }) : null,
});

const sameChoices = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');

/** Regenerates ONE question, following an optional Admin instruction; every other question is left untouched. */
async function regenerateQuestion({ assessment, question, instruction }) {
  const ctx = await courseContext(assessment);
  const others = assessment.questions.filter((q) => q.id !== question.id).map((q) => q.prompt);
  const result = await generateStructured({
    systemInstruction: `You are rewriting ONE question of a ${assessment.type.replace('_', ' ')} practice assessment for travel agency employees. ${TYPE_GUIDANCE[assessment.type] || ''} Stay strictly within the training material given — never invent company rules. Keep the question type "${question.type}" unless the instruction clearly needs another. For MCQ/MULTI_SELECT/MATCHING/ORDERING put the choices in "options" and the correct one(s) in "correctAnswer" (comma-separate multiple).`,
    contents: [{ role: 'user', parts: [{ text: `Course: ${ctx.title}\n${ctx.text}\nDifficulty: ${LEVEL_GUIDANCE[assessment.level] || LEVEL_GUIDANCE[3]}\n\nQuestion to replace: ${question.prompt}\nOptions: ${question.optionsJson || 'none'}\nCurrent correct answer: ${question.correctAnswerJson}\n\nDo NOT repeat any of these other questions:\n${others.map((p) => `- ${p}`).join('\n') || '(none)'}\n\nAdmin instruction: ${instruction || 'Write a better replacement for this question.'}` }] }],
    responseSchema: oneQuestionGemini,
    zodSchema: oneQuestionZod,
  });
  return prisma.$transaction(async (tx) => {
    await tx.question.update({ where: { id: question.id }, data: persistQuestionData(result.data) });
    await reopenIfApproved(tx, assessment);
    return result;
  });
}

/**
 * "Give the AI another prompt": revises the practice as instructed. For question sets the AI gets
 * the current questions and must return the FULL list, leaving unaffected questions word for word;
 * only rows that actually changed are rewritten. For role-play/voice it revises the scenario config.
 */
async function reviseWithPrompt({ assessment, instruction }) {
  const ctx = await courseContext(assessment);
  if (CONFIG_ASSESSMENTS.includes(assessment.type)) {
    const config = safeParse(assessment.configJson, {});
    const result = await generateStructured({
      systemInstruction: `You are revising a sales role-play scenario for travel agency employees. Apply the Admin's instruction and change only what it affects; keep everything else exactly as is. The simulated customer must stay realistic (never artificially easy). ${LEVEL_GUIDANCE[assessment.level] || LEVEL_GUIDANCE[3]} Return the complete scenario.`,
      contents: [{ role: 'user', parts: [{ text: `Course: ${ctx.title}\n${ctx.text}\n\nCurrent scenario: ${JSON.stringify({ customerPersonality: config.customerPersonality, scenarioBrief: config.scenarioBrief, openingLine: config.openingLine, rubricSkills: config.rubricSkills })}\n\nAdmin instruction: ${instruction}` }] }],
      responseSchema: roleplayGeminiSchema,
      zodSchema: roleplayZodSchema,
    });
    await prisma.$transaction(async (tx) => {
      await tx.assessment.update({ where: { id: assessment.id }, data: { configJson: JSON.stringify({ ...config, ...result.data }) } });
      await reopenIfApproved(tx, assessment);
    });
    return { changed: 1, kind: 'scenario' };
  }
  if (!QUESTION_ASSESSMENTS.includes(assessment.type) || (assessment.type === 'PROCESS_SIM' && safeParse(assessment.configJson, {}).nodes)) {
    throw Object.assign(new Error('This practice cannot be revised with a prompt; edit it directly.'), { userFacing: true });
  }
  const current = assessment.questions.map((q) => ({ type: q.type, prompt: q.prompt, options: safeParse(q.optionsJson, undefined), correctAnswer: safeParse(q.correctAnswerJson, ''), explanation: q.explanation || undefined, skillNames: safeParse(q.skillIdsJson, []) }));
  const result = await generateStructured({
    systemInstruction: `You are revising a ${assessment.type.replace('_', ' ')} practice assessment for travel agency employees. Apply the Admin's instruction. Return the FULL list of questions: copy every question the instruction does not affect exactly as given, and rewrite or add only what it requires. Stay within the training material. ${TYPE_GUIDANCE[assessment.type] || ''}`,
    contents: [{ role: 'user', parts: [{ text: `Course: ${ctx.title}\n${ctx.text}\nDifficulty: ${LEVEL_GUIDANCE[assessment.level] || LEVEL_GUIDANCE[3]}\n\nCurrent questions:\n${JSON.stringify(current)}\n\nAdmin instruction: ${instruction}` }] }],
    responseSchema: questionGeminiSchema,
    zodSchema: questionZodSchema,
  });
  const next = result.data.questions;
  let changed = 0;
  await prisma.$transaction(async (tx) => {
    for (const [i, q] of next.entries()) {
      const existing = assessment.questions[i];
      const data = { ...persistQuestionData(q), displayOrder: i };
      // A question the AI left as it was keeps the order it already has (otherwise every revision would "change" every question).
      if (existing && sameChoices(safeParse(existing.optionsJson, null), q.options)) data.optionsJson = existing.optionsJson;
      if (existing) {
        const same = existing.prompt === data.prompt && existing.optionsJson === data.optionsJson && existing.correctAnswerJson === data.correctAnswerJson && existing.type === data.type && (existing.explanation || null) === data.explanation;
        if (!same) { await tx.question.update({ where: { id: existing.id }, data }); changed += 1; }
      } else {
        await tx.question.create({ data: { ...data, assessmentId: assessment.id } });
        changed += 1;
      }
    }
    const surplus = assessment.questions.slice(next.length);
    if (surplus.length) { await tx.question.deleteMany({ where: { id: { in: surplus.map((q) => q.id) } } }); changed += surplus.length; }
    if (changed) await reopenIfApproved(tx, assessment);
  });
  return { changed, kind: 'questions' };
}

module.exports = { QUESTION_ASSESSMENTS, CONFIG_ASSESSMENTS, HAND_EDITABLE, MIN_PASSING, readQuestionForm, reopenIfApproved, regenerateQuestion, reviseWithPrompt, lines, clip };
