'use strict';

// Stage C for generated practice (spec section 3, "Validate"): after practice is generated, Gemini
// checks it against the training knowledge it came from — is each question/scenario supported by the
// source, is the correct answer supported, does it test application rather than trivia, and was
// anything important left out. The result is ADVICE for the reviewing Admin; it never deletes or
// approves anything. Nothing here trusts the model blindly: the reply is schema-validated.
const crypto = require('crypto');
const { z } = require('zod');
const { Type } = require('@google/genai');
const { prisma } = require('./prisma');
const { generateStructured } = require('./gemini');
const { safeParse } = require('./practiceEngine');

const zodSchema = z.object({
  items: z.array(z.object({ ref: z.string(), supportedBySource: z.boolean(), testsApplication: z.boolean(), note: z.string() })).max(40),
  coverageGaps: z.array(z.string()).max(10),
});
const responseSchema = {
  type: Type.OBJECT,
  properties: {
    items: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { ref: { type: Type.STRING }, supportedBySource: { type: Type.BOOLEAN }, testsApplication: { type: Type.BOOLEAN }, note: { type: Type.STRING } }, required: ['ref', 'supportedBySource', 'testsApplication', 'note'] } },
    coverageGaps: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ['items', 'coverageGaps'],
};

/** What the check looked at, as a stable hash — so an edit made after the check is visible as "stale". */
function contentHash(assessment) {
  const config = safeParse(assessment.configJson, {}) || {};
  const { validation: _validation, ...rest } = config;
  const body = { title: assessment.title, level: assessment.level, config: rest, questions: (assessment.questions || []).map((q) => [q.type, q.prompt, q.optionsJson, q.correctAnswerJson]) };
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
}

function describePractice(assessment) {
  if (assessment.questions && assessment.questions.length) {
    return assessment.questions.map((q, i) => `Q${i + 1} [${q.type}]: ${q.prompt}\n  options: ${q.optionsJson || 'none'}\n  correct answer: ${q.correctAnswerJson}`).join('\n');
  }
  const config = safeParse(assessment.configJson, {}) || {};
  if (Array.isArray(config.nodes)) { // a branching workflow simulation: describe every decision point so it is judged on what it actually contains
    return config.nodes.map((n, i) => `Q${i + 1} [PROCESS_SIM step ${n.id}]: ${n.situation}\n  choices: ${(n.options || []).map((o) => `"${o.label}" (score ${o.score}, feedback: ${o.feedback})`).join(' | ')}`).join('\n');
  }
  return `Q1 [${assessment.type}]: scenario: ${config.scenarioBrief || '(none)'}\n  customer opening: ${config.openingLine || '(none)'}\n  rubric skills: ${JSON.stringify(config.rubricSkills || [])}`;
}

async function validatePractice(assessmentId) {
  const assessment = await prisma.assessment.findUnique({ where: { id: assessmentId }, include: { questions: { orderBy: { displayOrder: 'asc' } }, course: true } });
  if (!assessment || !assessment.courseId) return null;
  const analysis = await prisma.trainingAnalysis.findUnique({ where: { courseId: assessment.courseId } });
  if (!analysis) return null;
  const refs = safeParse(analysis.sourceReferencesJson, {}) || {};
  const result = await generateStructured({
    systemInstruction: 'You are a strict reviewer of generated training practice for a travel agency. Compare each numbered practice item against the training knowledge given. For every item say whether it (and its correct answer) is supported by that knowledge — not invented company policy — and whether it tests APPLICATION in a realistic work situation rather than trivia or memory alone. Keep each note to one short sentence, naming the problem when there is one. Then list important parts of the training that the practice does not cover (coverageGaps); an empty list is fine if coverage is good. Judge only from the material provided.',
    contents: [{ role: 'user', parts: [{ text: `Training: ${assessment.course.title}\nCritical knowledge: ${analysis.criticalKnowledgeJson}\nPractical behaviors: ${analysis.practicalBehaviorsJson}\nCommon mistakes: ${analysis.commonMistakesJson}\nObjectives: ${analysis.objectivesJson}\nSource map: ${JSON.stringify(refs.facts || [])}\n\nPractice to review (${assessment.type}):\n${describePractice(assessment)}` }] }],
    responseSchema,
    zodSchema,
  });
  const total = result.data.items.length;
  const validation = {
    checkedAt: new Date().toISOString(),
    modelVersion: result.modelVersion,
    contentHash: contentHash(assessment),
    total,
    supported: result.data.items.filter((i) => i.supportedBySource).length,
    application: result.data.items.filter((i) => i.testsApplication).length,
    items: result.data.items,
    coverageGaps: result.data.coverageGaps,
  };
  const config = safeParse(assessment.configJson, {}) || {};
  await prisma.assessment.update({ where: { id: assessment.id }, data: { configJson: JSON.stringify({ ...config, validation }) } });
  return validation;
}

module.exports = { validatePractice, contentHash };