'use strict';

// Practice content generators (spec section 6). QUIZ/TECHNICAL/PROCESS_SIM/PRODUCT_KNOWLEDGE
// all share one Question schema and generator (they differ only in prompt framing), so one
// quiz-taking UI (routes/practice.js) serves all four. ROLEPLAY/VOICE generate a scenario
// "config" instead of questions — they're scored live from the attempt's transcript.
const { z } = require('zod');
const { Type } = require('@google/genai');
const { prisma } = require('./prisma');
const { generateStructured } = require('./gemini');
const { shuffleOptions } = require('./shuffleOptions');
const { rulesFor, sourceKindOf } = require('./practiceRules');

const QUESTION_TYPES = ['MCQ', 'MULTI_SELECT', 'ORDERING', 'MATCHING', 'SCENARIO', 'SHORT_ANSWER', 'TRUE_FALSE'];

const TYPE_GUIDANCE = {
  QUIZ: 'Write practical knowledge-check questions grounded in the material. Prefer realistic scenario questions ("A customer wants X — what should you verify?") over trivia ("What is X?"). Mix MCQ, MULTI_SELECT, SCENARIO, and SHORT_ANSWER question types; use TRUE_FALSE and ORDERING/MATCHING sparingly only where genuinely appropriate.',
  TECHNICAL: 'Write technical command/workflow questions that test actual system application (e.g. Sabre/GDS steps), not definitions. Favor SCENARIO and ORDERING (put the correct workflow steps in order) and SHORT_ANSWER for command sequences. Example style: "A client needs JFK-LHR Business Class on October 15. What is the correct workflow to search availability?"',
  PROCESS_SIM: 'Write a realistic situation the learner must handle by choosing the correct next action from the SOP/process being taught. Favor SCENARIO questions with MCQ/MULTI_SELECT options representing different possible actions, testing whether the correct workflow is followed, including decision points.',
  PRODUCT_KNOWLEDGE: 'Write questions that require identifying, comparing, or recommending real products (aircraft, cabins, seats, airlines, lounges) covered in the material — comparisons, "which is more appropriate for this traveler", and identification questions. Favor MCQ, MATCHING (product to feature), and SCENARIO ("recommend the best option for this traveler").',
};

const questionZodSchema = z.object({
  questions: z.array(z.object({
    type: z.enum(QUESTION_TYPES),
    prompt: z.string(),
    options: z.array(z.string()).optional(),
    correctAnswer: z.union([z.string(), z.array(z.string())]),
    explanation: z.string().optional(),
    skillNames: z.array(z.string()).max(4).optional(),
    sourceTitle: z.string().optional(),
    sourceLocation: z.string().optional(),
  })).min(3).max(15),
});

const questionGeminiSchema = {
  type: Type.OBJECT,
  properties: {
    questions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          type: { type: Type.STRING, enum: QUESTION_TYPES },
          prompt: { type: Type.STRING },
          options: { type: Type.ARRAY, items: { type: Type.STRING } },
          correctAnswer: { type: Type.STRING },
          explanation: { type: Type.STRING },
          skillNames: { type: Type.ARRAY, items: { type: Type.STRING } },
          sourceTitle: { type: Type.STRING },
          sourceLocation: { type: Type.STRING },
        },
        required: ['type', 'prompt', 'correctAnswer'],
      },
    },
  },
  required: ['questions'],
};

const LEVEL_GUIDANCE = {
  1: 'Level 1 (Recall): does the learner remember the information?',
  2: 'Level 2 (Understanding): does the learner understand why?',
  3: 'Level 3 (Application): can the learner use the information in a normal situation?',
  4: 'Level 4 (Realistic Scenario): can the learner perform in a realistic work situation?',
  5: 'Level 5 (Difficult Scenario): can the learner handle complications, objections, errors or edge cases?',
};

/**
 * Generates a QUIZ/TECHNICAL/PROCESS_SIM/PRODUCT_KNOWLEDGE Assessment + its Question rows from
 * an approved TrainingAnalysis, and saves them in DRAFT-reviewable (AI_GENERATED) status.
 */
async function generateQuestionAssessment({ course, analysis, actor, type, level = 3, questionCount = 6, focusSkills = null, status = 'AI_GENERATED' }) {
  const skillNames = focusSkills && focusSkills.length ? focusSkills : safeParse(analysis.extractedSkillsJson, []);
  const focusInstruction = focusSkills && focusSkills.length
    ? `This is TARGETED RETAKE practice — the learner previously scored poorly on exactly these skills: ${JSON.stringify(focusSkills)}. Write every question to test ONLY these skills, at a HIGHER difficulty than a first attempt (vary the scenarios/wording so it isn't the same question repeated, but it must test the same underlying competency). Do NOT write questions about unrelated skills the learner already demonstrated.`
    : '';
  const contents = [{
    role: 'user',
    parts: [{
      text: `Course: ${course.title}\nCritical knowledge: ${analysis.criticalKnowledgeJson}\nPractical behaviors: ${analysis.practicalBehaviorsJson}\nCommon mistakes: ${analysis.commonMistakesJson}\nRelevant skills: ${JSON.stringify(skillNames)}\nSource map: ${JSON.stringify((safeParse(analysis.sourceReferencesJson, {}) || {}).facts || [])}\n\nGenerate ${questionCount} questions at difficulty ${LEVEL_GUIDANCE[level] || LEVEL_GUIDANCE[3]}`,
    }],
  }];

  const result = await generateStructured({
    systemInstruction: `${rulesFor({ kind: sourceKindOf(analysis), type })}\n\nYou are writing a ${type.replace('_', ' ')} practice assessment for travel agency employees, based strictly on the training material summarized below. ${TYPE_GUIDANCE[type]} ${focusInstruction} Every question must be answerable from the given material — never invent company rules. For MCQ/MULTI_SELECT/MATCHING/ORDERING, put the answer choices in "options" and the correct one(s) in "correctAnswer" (comma-separate multiple correct answers). Tag each question with the 1-4 most relevant skill names from the provided list where applicable. Where you can, set sourceTitle and sourceLocation to the source and the page, slide, timestamp or section that teaches the answer (from the source map below); leave them empty rather than guessing.`,
    contents,
    responseSchema: questionGeminiSchema,
    zodSchema: questionZodSchema,
  });

  return prisma.$transaction(async (tx) => {
    const assessment = await tx.assessment.create({
      data: {
        organizationId: course.organizationId,
        courseId: course.id,
        createdVia: 'AI_TRAINING_ANALYSIS',
        type,
        title: focusSkills && focusSkills.length ? `${course.title} — Targeted retake (${focusSkills.join(', ')})` : `${course.title} — ${type.replace('_', ' ')}`,
        level,
        passingScore: course.passingScore,
        status,
        configJson: focusSkills?.length ? JSON.stringify({ targetedRetake: true, focusSkills }) : null,
        createdById: actor.id,
        modelVersion: result.modelVersion,
      },
    });

    for (const [i, q] of result.data.questions.entries()) {
      await tx.question.create({
        data: {
          assessmentId: assessment.id,
          type: q.type,
          prompt: q.prompt,
          // The AI writes the correct answer first; stir the choices so it is not always "A".
          optionsJson: q.options ? JSON.stringify(shuffleOptions(q.type, q.options)) : null,
          correctAnswerJson: JSON.stringify(q.correctAnswer),
          explanation: q.explanation || null,
          skillIdsJson: JSON.stringify(q.skillNames || []),
          sourceRefJson: q.sourceTitle ? JSON.stringify({ title: q.sourceTitle, location: q.sourceLocation || '' }) : null,
          displayOrder: i,
        },
      });
    }

    return assessment;
  });
}

const roleplayZodSchema = z.object({
  customerPersonality: z.string(),
  scenarioBrief: z.string(),
  openingLine: z.string(),
  rubricSkills: z.array(z.string()).min(3).max(8),
  // Hidden from the learner: what only the AI customer and the scorer know.
  hiddenContext: z.string().optional(),
  expectedTechnique: z.string().optional(),
});

const roleplayGeminiSchema = {
  type: Type.OBJECT,
  properties: {
    customerPersonality: { type: Type.STRING },
    scenarioBrief: { type: Type.STRING },
    openingLine: { type: Type.STRING },
    rubricSkills: { type: Type.ARRAY, items: { type: Type.STRING } },
    hiddenContext: { type: Type.STRING },
    expectedTechnique: { type: Type.STRING },
  },
  required: ['customerPersonality', 'scenarioBrief', 'openingLine', 'rubricSkills'],
};

const CUSTOMER_PERSONALITIES = ['busy executive', 'price-sensitive traveler', 'skeptical traveler', 'returning premium customer', 'luxury traveler', 'difficult customer', 'comparison shopper', '"I\'ll think about it" customer', 'customer who wants to get off the phone quickly'];

/**
 * Generates a ROLEPLAY Assessment's scenario config (no Question rows — the practice itself is
 * a live turn-based chat scored from the transcript at the end).
 */
async function generateRoleplayAssessment({ course, analysis, actor, level = 3, focusSkills = null, status = 'AI_GENERATED', type = 'ROLEPLAY' }) {
  const personality = CUSTOMER_PERSONALITIES[Math.floor(Math.random() * CUSTOMER_PERSONALITIES.length)];
  const result = await generateStructured({
    systemInstruction: `${rulesFor({ kind: sourceKindOf(analysis), type })}\n\nYou are designing a realistic client role-play for travel agency employees, based on this training material. The learner plays the travel agent; the AI plays the customer. The customer personality must be: "${personality}". The simulated customer must react naturally and must NOT be artificially easy — ${LEVEL_GUIDANCE[level] || LEVEL_GUIDANCE[3]}. Fill the fields like this: scenarioBrief = ONLY the client situation the learner will read (who is calling and what they ask for; no hints, no technique, no budget). openingLine = the customer's realistic first message. rubricSkills = 3-6 GENERAL skill categories (from: Opening, Discovery, Listening, Confidence, Call control, Client engagement, Product knowledge, Price presentation, Objection handling, Professionalism, Closing, Next-step creation) - never technique-specific wording. hiddenContext = what only the customer knows and reveals gradually: the real budget, the hidden objection, and what unlocks it. expectedTechnique = the technique or behaviour from the training that a good agent would use here and how to recognise it - used only to evaluate the learner afterwards.`,
    contents: [{ role: 'user', parts: [{ text: `Course: ${course.title}\nCritical knowledge: ${analysis.criticalKnowledgeJson}\nPractical behaviors: ${analysis.practicalBehaviorsJson}\n${focusSkills?.length ? `Targeted retake: focus the scenario and rubric ONLY on these weak skills: ${JSON.stringify(focusSkills)}. Use a new situation to test the same competencies.` : ''}` }] }],
    responseSchema: roleplayGeminiSchema,
    zodSchema: roleplayZodSchema,
  });

  return prisma.assessment.create({
    data: {
      organizationId: course.organizationId,
      courseId: course.id,
      createdVia: 'AI_TRAINING_ANALYSIS',
      type,
      title: `${course.title} — ${type === 'VOICE' ? 'Voice practice' : 'Role-play'}`,
      level,
      passingScore: course.passingScore,
      status,
      createdById: actor.id,
      modelVersion: result.modelVersion,
      configJson: JSON.stringify({ ...result.data, ...(focusSkills?.length ? { targetedRetake: true, focusSkills } : {}) }),
    },
  });
}

function safeParse(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

module.exports = { generateQuestionAssessment, generateRoleplayAssessment, QUESTION_TYPES, LEVEL_GUIDANCE, TYPE_GUIDANCE, questionZodSchema, questionGeminiSchema, roleplayZodSchema, roleplayGeminiSchema, safeParse };
