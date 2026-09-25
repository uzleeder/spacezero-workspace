'use strict';

// The Gemini "Training Map" pipeline (spec section 3): Extract -> Map -> Validate. Nothing
// produced here is assignable until an Admin/Supervisor explicitly approves it on the
// Creator Review screen (routes/admin/trainingAnalysis.js). Runs via lib/jobQueue.js so an
// upload request returns immediately instead of blocking on 3 sequential Gemini calls.
const fs = require('fs/promises');
const crypto = require('crypto');
const { z } = require('zod');
const { Type } = require('@google/genai');
const { prisma } = require('./prisma');
const { generateStructured, GeminiError } = require('./gemini');
const { resolveStoragePath } = require('./storage');
const { registerJobType, MAX_RETRIES, STUCK_AFTER_MS } = require('./jobQueue');
const { redactText } = require('./redact');
const { modulesFor } = require('./courseVersions');

const CLASSIFICATIONS = ['SALES_COMMUNICATION', 'TECHNICAL', 'PROCESS_SOP', 'PRODUCT_KNOWLEDGE', 'CUSTOMER_SERVICE', 'LEADERSHIP_SUPERVISOR', 'COMPLIANCE_POLICY', 'MIXED'];
const PRACTICE_METHODS = ['QUIZ', 'ROLEPLAY', 'VOICE', 'TECHNICAL', 'PROCESS_SIM', 'PRODUCT_KNOWLEDGE'];

const EXT_MIME = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.doc': 'application/msword', '.ppt': 'application/vnd.ms-powerpoint',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function guessMimeType(storagePath) {
  const ext = storagePath.slice(storagePath.lastIndexOf('.')).toLowerCase();
  return EXT_MIME[ext] || 'application/octet-stream';
}

/**
 * Turns a course's TrainingModules into Gemini `contents` parts: uploaded files go through the
 * Files API (works for any size up to Gemini's own limits, unlike inlining base64), text-only
 * modules (NOTE/LINK, or any module without a file yet) are included as plain text so the
 * pipeline can still run on a partially-uploaded course.
 */
async function buildContentParts(ai, course, uploadedNames) {
  const parts = [{ text: `Course title: ${course.title}\nCourse description: ${course.description || '(none)'}\n` }];
  const skipped = [];

  for (const mod of course.modules) {
    const header = `\n--- Source: "${mod.title}" (${mod.contentType}) ---\n`;
    if (mod.storagePath) {
      try {
        const document = await require('./documentText').documentText(resolveStoragePath(mod.storagePath));
        if (document !== null) { parts.push({ text: `${header}${redactText(document)}` }); continue; }
        const buffer = await fs.readFile(resolveStoragePath(mod.storagePath));
        const mimeType = guessMimeType(mod.storagePath);
        let uploaded = await ai.files.upload({ file: new Blob([buffer], { type: mimeType }), config: { mimeType, displayName: mod.title } });
        uploadedNames.push(uploaded.name);
        const deadline = Date.now() + 300000;
        while (uploaded.state === 'PROCESSING' && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          uploaded = await ai.files.get({ name: uploaded.name });
        }
        if (uploaded.state !== 'ACTIVE') throw new Error('Source processing failed or timed out.');
        parts.push({ text: header });
        parts.push({ fileData: { fileUri: uploaded.uri, mimeType: uploaded.mimeType } });
      } catch (err) {
        skipped.push({ module: mod.title, reason: err.message || 'upload failed' });
      }
    } else if (mod.externalUrl) {
      skipped.push({ module: mod.title, reason: 'Upload the linked source; a URL alone is not training content.' });
    } else if (mod.description) {
      parts.push({ text: `${header}${redactText(mod.description || '')}${mod.externalUrl ? `\n(External link: ${mod.externalUrl})` : ''}\n` });
    } else {
      skipped.push({ module: mod.title, reason: 'no content uploaded yet' });
    }
  }

  return { parts, skipped };
}

const ANALYSIS_PROMPTS = { extract: 'analysis.extract@2', map: 'analysis.map@2', validate: 'analysis.validate@2' };
const ACTIVE_STATUSES = ['QUEUED', 'EXTRACTING', 'MAPPING', 'VALIDATING'];
const AUDIENCE_ROLES = ['TRAVEL_AGENT', 'FLIGHT_EXPERT', 'SUPERVISOR'];
const CONFIDENCE = ['HIGH', 'MEDIUM', 'NEEDS_REVIEW'];
const PURPOSES = ['AUTO', 'SALES_COMMUNICATION', 'TECHNICAL', 'PROCESS_SOP', 'PRODUCT_KNOWLEDGE', 'CUSTOMER_SERVICE', 'LEADERSHIP_SUPERVISOR', 'MIXED'];
const PURPOSE_LABEL = { AUTO: 'Auto detect', SALES_COMMUNICATION: 'Sales', TECHNICAL: 'Technical', PROCESS_SOP: 'Process / SOP', PRODUCT_KNOWLEDGE: 'Product knowledge', CUSTOMER_SERVICE: 'Customer service', LEADERSHIP_SUPERVISOR: 'Leadership', MIXED: 'Mixed' };

/** A fingerprint of the material as it is now. If it changes after an analysis, the analysis is stale. */
function computeSourceHash(modules) {
  const h = crypto.createHash('sha256');
  for (const m of [...modules].sort((x, y) => x.id.localeCompare(y.id))) h.update(`${m.id}|${m.title}|${m.contentType}|${m.storagePath || ''}|${m.externalUrl || ''}|${m.description || ''}\n`);
  return h.digest('hex').slice(0, 32);
}

const purposeHint = (purpose) => (purpose && purpose !== 'AUTO' && PURPOSE_LABEL[purpose] ? ` The administrator says this material is mainly about: ${PURPOSE_LABEL[purpose]}. Use that as a hint, but classify by what the material actually contains.` : '');

const extractZodSchema = z.object({
  criticalKnowledge: z.array(z.string()).max(30),
  practicalBehaviors: z.array(z.string()).max(30),
  commonMistakes: z.array(z.string()).max(20),
  procedures: z.array(z.string()).max(20).optional(),
  // Where the important facts/steps come from (page, slide, timestamp or section). Optional and best effort.
  sourceMap: z.array(z.object({ fact: z.string(), sourceTitle: z.string(), location: z.string() })).max(40).optional(),
});

const extractGeminiSchema = {
  type: Type.OBJECT,
  properties: {
    criticalKnowledge: { type: Type.ARRAY, items: { type: Type.STRING } },
    practicalBehaviors: { type: Type.ARRAY, items: { type: Type.STRING } },
    commonMistakes: { type: Type.ARRAY, items: { type: Type.STRING } },
    procedures: { type: Type.ARRAY, items: { type: Type.STRING } },
    sourceMap: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { fact: { type: Type.STRING }, sourceTitle: { type: Type.STRING }, location: { type: Type.STRING } }, required: ['fact', 'sourceTitle', 'location'] } },
  },
  required: ['criticalKnowledge', 'practicalBehaviors', 'commonMistakes'],
};

const supportSchema = z.object({ factNumbers: z.array(z.number().int()).max(8), confidence: z.enum(CONFIDENCE) });
const mapZodSchema = z.object({
  classifications: z.array(z.enum(CLASSIFICATIONS)).min(1),
  objectives: z.array(z.string()).min(1).max(8),
  extractedSkills: z.array(z.string()).min(1).max(12),
  difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']),
  recommendedMethods: z.array(z.enum(PRACTICE_METHODS)).min(1),
  recommendedIntensity: z.number().int().min(1).max(5),
  audienceRoles: z.array(z.enum(AUDIENCE_ROLES)).max(3).optional(),
  estimatedMinutes: z.number().int().min(1).max(600).optional(),
  objectiveSupport: z.array(supportSchema.extend({ objective: z.string() })).max(8).optional(),
  skillSupport: z.array(supportSchema.extend({ skill: z.string() })).max(12).optional(),
});

const supportGemini = (key) => ({ type: Type.ARRAY, items: { type: Type.OBJECT, properties: { [key]: { type: Type.STRING }, factNumbers: { type: Type.ARRAY, items: { type: Type.INTEGER } }, confidence: { type: Type.STRING, enum: CONFIDENCE } }, required: [key, 'factNumbers', 'confidence'] } });
const mapGeminiSchema = {
  type: Type.OBJECT,
  properties: {
    classifications: { type: Type.ARRAY, items: { type: Type.STRING, enum: CLASSIFICATIONS } },
    objectives: { type: Type.ARRAY, items: { type: Type.STRING } },
    extractedSkills: { type: Type.ARRAY, items: { type: Type.STRING } },
    difficulty: { type: Type.STRING, enum: ['EASY', 'MEDIUM', 'HARD'] },
    recommendedMethods: { type: Type.ARRAY, items: { type: Type.STRING, enum: PRACTICE_METHODS } },
    recommendedIntensity: { type: Type.INTEGER },
    audienceRoles: { type: Type.ARRAY, items: { type: Type.STRING, enum: AUDIENCE_ROLES } },
    estimatedMinutes: { type: Type.INTEGER },
    objectiveSupport: supportGemini('objective'),
    skillSupport: supportGemini('skill'),
  },
  required: ['classifications', 'objectives', 'extractedSkills', 'difficulty', 'recommendedMethods', 'recommendedIntensity'],
};

const validateZodSchema = z.object({
  supportedBySource: z.boolean(),
  notes: z.array(z.string()).max(15),
});

const validateGeminiSchema = {
  type: Type.OBJECT,
  properties: {
    supportedBySource: { type: Type.BOOLEAN },
    notes: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ['supportedBySource', 'notes'],
};

const STEP_ORDER = ['EXTRACT', 'MAP', 'VALIDATE'];
const stepDone = (analysis, step) => STEP_ORDER.indexOf(analysis.completedStep || '') >= STEP_ORDER.indexOf(step);
const parseJson = (value, fallback) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };

/**
 * Turns the model's claims into grounded insights. The APPLICATION decides how sure to be: a claim with no
 * supporting source fact is always "needs review", and one whose evidence has no location is at most "medium".
 */
function groundInsights({ objectives, skills, objectiveSupport = [], skillSupport = [], facts }) {
  const cap = (confidence, evidence) => {
    if (!evidence.length) return 'NEEDS_REVIEW';
    if (confidence === 'HIGH' && evidence.every((e) => !e.location)) return 'MEDIUM';
    return confidence;
  };
  const evidenceFor = (support) => (support ? [...new Set(support.factNumbers)].filter((n) => n >= 1 && n <= facts.length).map((n) => facts[n - 1]) : []);
  return {
    objectives: objectives.map((text) => {
      const support = objectiveSupport.find((s) => s.objective.trim().toLowerCase() === text.trim().toLowerCase());
      const evidence = evidenceFor(support);
      return { text, confidence: cap(support ? support.confidence : 'NEEDS_REVIEW', evidence), evidence };
    }),
    skills: skills.map((name) => {
      const support = skillSupport.find((s) => s.skill.trim().toLowerCase() === name.trim().toLowerCase());
      const evidence = evidenceFor(support);
      return { name, confidence: cap(support ? support.confidence : 'NEEDS_REVIEW', evidence), evidence };
    }),
  };
}

async function fail(analysisId, analysis, geminiError) {
  const nextRetryCount = analysis.retryCount + 1;
  if (geminiError.retryable && nextRetryCount < MAX_RETRIES) {
    await prisma.trainingAnalysis.update({ where: { id: analysisId }, data: { status: 'QUEUED', retryCount: nextRetryCount, errorMessage: geminiError.message } });
  } else {
    await prisma.trainingAnalysis.update({ where: { id: analysisId }, data: { status: 'FAILED', retryCount: nextRetryCount, errorMessage: geminiError.message } });
  }
}

async function runPipeline(analysisId) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  let analysis = await prisma.trainingAnalysis.findUnique({ where: { id: analysisId }, include: { course: { include: { modules: true, organization: { include: { skills: true } } } } } });
  if (!analysis) return;
  const course = analysis.course;
  course.modules = modulesFor(course.modules, course.draftVersion || 1); // only the material of the version being analyzed
  const existingSkillNames = (course.organization?.skills || []).map((s) => s.name);
  const uploadedNames = [];
  const sourceHash = computeSourceHash(course.modules);
  // Steps that already finished for THIS material are kept: a retry after a failure continues instead of starting over.
  if (analysis.sourceHash && analysis.sourceHash !== sourceHash) analysis = { ...analysis, completedStep: null };
  const purpose = analysis.purpose || 'AUTO';
  const insights = parseJson(analysis.insightsJson, {}) || {};

  await prisma.trainingAnalysis.update({ where: { id: analysisId }, data: { status: stepDone(analysis, 'EXTRACT') ? (stepDone(analysis, 'MAP') ? 'VALIDATING' : 'MAPPING') : 'EXTRACTING', startedAt: analysis.startedAt || new Date(), sourceHash, promptVersion: `${ANALYSIS_PROMPTS.extract},${ANALYSIS_PROMPTS.map},${ANALYSIS_PROMPTS.validate}` } });

  try {
    let contents = null; let skipped = [];
    const sourceContents = async () => {
      if (contents) return contents;
      const built = await buildContentParts(ai, course, uploadedNames);
      skipped = built.skipped;
      if (skipped.length || !course.modules.length) throw new Error(skipped.map((s) => `${s.module}: ${s.reason}`).join('; ') || 'Add training material before analysis.');
      // Approved reference knowledge the Admin explicitly chose (Library items: title + description only, redacted).
      // It is background for interpretation, never a source: facts may only be cited from the "--- Source:" headers.
      const refIds = Array.isArray(insights.referenceItemIds) ? insights.referenceItemIds : [];
      if (refIds.length) {
        const items = await prisma.libraryItem.findMany({ where: { id: { in: refIds }, organizationId: course.organizationId, archivedAt: null }, select: { title: true, description: true } });
        if (items.length) built.parts.push({ text: `\n--- Approved reference knowledge (background only; do NOT cite it as a source) ---\n${items.map((i) => `${redactText(i.title)}: ${redactText(i.description || '')}`).join('\n')}\n` });
      }
      contents = [{ role: 'user', parts: built.parts }];
      return contents;
    };

    let extractData;
    if (stepDone(analysis, 'EXTRACT')) {
      extractData = { criticalKnowledge: parseJson(analysis.criticalKnowledgeJson, []), practicalBehaviors: parseJson(analysis.practicalBehaviorsJson, []), commonMistakes: parseJson(analysis.commonMistakesJson, []), procedures: insights.procedures || [], sourceMap: insights.sourceMap || [] };
    } else {
      const extract = await generateStructured({
        task: 'analysis.extract', promptVersion: ANALYSIS_PROMPTS.extract,
        systemInstruction: `You are analyzing corporate training material for a travel agency. Use ONLY what the source material itself says: do not add the name of the agency, or any fact, that the material does not state. Extract concrete, specific facts/rules/procedures/terminology/warnings as "criticalKnowledge"; workflows, communication techniques, and expected employee actions as "practicalBehaviors"; and any explicitly-mentioned mistakes agents commonly make as "commonMistakes". List step-by-step workflows or SOP steps you find as "procedures". Cover facts, rules, procedures, concepts, terminology, examples, warnings, decision points and expected employee actions. Also return "sourceMap": for the most important facts and steps (up to 40), the exact source title as written in the "--- Source:" header and where inside it the point appears (page number, slide number, timestamp as mm:ss, or section heading); use an empty string when the location cannot be determined — never guess a location. Do not invent anything not present in the source material.${purposeHint(purpose)}`,
        contents: await sourceContents(),
        responseSchema: extractGeminiSchema,
        zodSchema: extractZodSchema,
      });
      extractData = extract.data;
      insights.procedures = extract.data.procedures || [];
      insights.sourceMap = extract.data.sourceMap || [];
      await prisma.trainingAnalysis.update({
        where: { id: analysisId },
        data: {
          status: 'MAPPING', completedStep: 'EXTRACT',
          criticalKnowledgeJson: JSON.stringify(extract.data.criticalKnowledge),
          practicalBehaviorsJson: JSON.stringify(extract.data.practicalBehaviors),
          commonMistakesJson: JSON.stringify(extract.data.commonMistakes),
          insightsJson: JSON.stringify(insights),
          modelVersion: extract.modelVersion,
        },
      });
    }

    // Facts the model can point at, each with where it comes from. Only sources that really are part of this material are kept.
    const known = new Map(course.modules.map((m) => [m.title.trim().toLowerCase(), m]));
    const facts = (extractData.sourceMap || []).filter((f) => known.has(f.sourceTitle.trim().toLowerCase())).map((f) => ({ fact: f.fact, moduleId: known.get(f.sourceTitle.trim().toLowerCase()).id, sourceTitle: known.get(f.sourceTitle.trim().toLowerCase()).title, location: f.location.trim() }));

    let mapData;
    if (stepDone(analysis, 'MAP')) {
      mapData = { classifications: parseJson(analysis.classificationsJson, []), objectives: parseJson(analysis.objectivesJson, []), extractedSkills: parseJson(analysis.extractedSkillsJson, []), difficulty: analysis.difficulty, recommendedMethods: parseJson(analysis.recommendedMethodsJson, []), recommendedIntensity: parseJson(analysis.recommendedIntensityJson, 3) };
    } else {
      const numbered = facts.map((f, i) => `#${i + 1} ${f.fact} [${f.sourceTitle}${f.location ? `, ${f.location}` : ''}]`).join('\n');
      const map = await generateStructured({
        task: 'analysis.map', promptVersion: ANALYSIS_PROMPTS.map,
        systemInstruction: `You are classifying and mapping corporate training material for a travel agency. Classify the material against one or more of: ${CLASSIFICATIONS.join(', ')}. Write 2-6 concrete learning objectives (what the employee should be able to DO afterward, not just "understand"). Name the specific skills this material builds — prefer matching these existing organization skill names where genuinely relevant: ${existingSkillNames.join(', ') || '(none defined yet)'}. Rate difficulty and recommend which practice method(s) fit best from: ${PRACTICE_METHODS.join(', ')} — prefer practical methods (ROLEPLAY/VOICE/TECHNICAL/PROCESS_SIM) over QUIZ alone when the material teaches a skill rather than pure facts, but ALSO include QUIZ whenever the material states rules, facts, steps or terminology the employee must know before practising (a knowledge check comes first, practical practice builds on it). Do not recommend methods the material cannot support (for example TECHNICAL for a pure sales lesson, or ROLEPLAY for a system command procedure). Recommend a practice intensity from 1 (recall only) to 5 (difficult realistic scenarios). Also return: "audienceRoles" (which of ${AUDIENCE_ROLES.join(', ')} this is meant for, based on the content only), "estimatedMinutes" (realistic learning time), and for EVERY objective and skill an entry in "objectiveSupport"/"skillSupport" listing the numbers (#n) of the grounded facts below that support it and your confidence (HIGH, MEDIUM, or NEEDS_REVIEW when the material is ambiguous or thin). Never cite a fact number that does not exist.${purposeHint(purpose)}`,
        contents: [{ role: 'user', parts: [{ text: `Extracted critical knowledge: ${JSON.stringify(extractData.criticalKnowledge)}\nExtracted practical behaviors: ${JSON.stringify(extractData.practicalBehaviors)}\nCommon mistakes: ${JSON.stringify(extractData.commonMistakes)}\nGrounded facts:\n${numbered || '(none with a known source)'}` }] }],
        responseSchema: mapGeminiSchema,
        zodSchema: mapZodSchema,
      });
      mapData = map.data;
      const grounded = groundInsights({ objectives: map.data.objectives, skills: map.data.extractedSkills, objectiveSupport: map.data.objectiveSupport, skillSupport: map.data.skillSupport, facts });
      Object.assign(insights, { ...grounded, audienceRoles: map.data.audienceRoles || [], estimatedMinutes: map.data.estimatedMinutes || null, purpose, difficulty: map.data.difficulty });
      await prisma.trainingAnalysis.update({
        where: { id: analysisId },
        data: {
          status: 'VALIDATING', completedStep: 'MAP',
          classificationsJson: JSON.stringify(map.data.classifications),
          objectivesJson: JSON.stringify(map.data.objectives),
          extractedSkillsJson: JSON.stringify(map.data.extractedSkills),
          difficulty: map.data.difficulty,
          recommendedMethodsJson: JSON.stringify(map.data.recommendedMethods),
          recommendedIntensityJson: JSON.stringify(map.data.recommendedIntensity),
          insightsJson: JSON.stringify(insights),
          modelVersion: map.modelVersion,
        },
      });
    }

    let validation;
    if (stepDone(analysis, 'VALIDATE')) {
      validation = { data: { supportedBySource: analysis.sourceReferencesJson ? parseJson(analysis.sourceReferencesJson, {}).validationSupported !== false : true, notes: parseJson(analysis.validationNotesJson, []) }, modelVersion: analysis.modelVersion };
    } else {
      validation = await generateStructured({
        task: 'analysis.validate', promptVersion: ANALYSIS_PROMPTS.validate,
        systemInstruction: 'You are fact-checking a training analysis against its own source material. Confirm every objective and piece of critical knowledge is genuinely supported by the source (not invented), that no company rule appears fabricated, and that important material was not missed. List any concerns as short notes; if everything looks well-supported, return an empty notes array and supportedBySource: true.',
        contents: [
          ...(await sourceContents()),
          { role: 'user', parts: [{ text: `Proposed objectives: ${JSON.stringify(mapData.objectives)}\nProposed critical knowledge: ${JSON.stringify(extractData.criticalKnowledge)}` }] },
        ],
        responseSchema: validateGeminiSchema,
        zodSchema: validateZodSchema,
      });
    }

    const sourceReferences = skipped.length ? { skippedSources: skipped } : {};
    // The validator is advice for the human reviewer, not a gate: a single unsupported detail must not throw away a whole analysis.
    // Concerns stay visible in the review screen, and nothing can be assigned until an Admin approves.
    const validationNotes = validation.data.supportedBySource ? validation.data.notes : ['The AI checker could not fully confirm this analysis against the source. Review these points before approving:', ...validation.data.notes];
    sourceReferences.validationSupported = validation.data.supportedBySource;
    sourceReferences.sources = course.modules.map((m) => ({ moduleId: m.id, title: m.title, type: m.contentType }));
    sourceReferences.facts = facts;

    await prisma.trainingAnalysis.update({
      where: { id: analysisId },
      data: {
        status: 'READY_FOR_REVIEW', completedStep: 'VALIDATE',
        validationNotesJson: JSON.stringify(validationNotes),
        sourceReferencesJson: JSON.stringify(sourceReferences),
        modelVersion: validation.modelVersion,
        completedAt: new Date(),
        errorMessage: null,
      },
    });
  } catch (err) {
    await fail(analysisId, analysis, err instanceof GeminiError ? err : new GeminiError(err.message || String(err)));
  } finally {
    for (const name of uploadedNames) await ai.files.delete({ name }).catch(() => undefined);
  }
}

/**
 * Queues an analysis. IDEMPOTENT: if one is already queued or running, nothing is reset and no second one is
 * created (a double click on "Start analysis" is harmless). `restart` clears earlier results (a fresh re-analysis);
 * `retry` (see retryAnalysis) keeps finished steps.
 */
async function enqueueAnalysis(courseId, { purpose = null, startedById = null, referenceItemIds = [] } = {}) {
  const insightsJson = JSON.stringify(referenceItemIds.length ? { referenceItemIds } : {});
  const reset = { insightsJson, status: 'QUEUED', retryCount: 0, errorMessage: null, queuedAt: new Date(), startedAt: null, completedAt: null, approvedById: null, approvedAt: null, completedStep: null, sourceHash: null, ...(purpose ? { purpose } : {}), ...(startedById ? { startedById } : {}) };
  const existing = await prisma.trainingAnalysis.findUnique({ where: { courseId } });
  if (!existing) {
    try { return await prisma.trainingAnalysis.create({ data: { courseId, status: 'QUEUED', purpose, startedById, insightsJson } }); } catch (err) {
      if (err && err.code === 'P2002') return Object.assign(await prisma.trainingAnalysis.findUnique({ where: { courseId } }), { duplicate: true });
      throw err;
    }
  }
  const claimed = await prisma.trainingAnalysis.updateMany({ where: { courseId, status: { notIn: ACTIVE_STATUSES } }, data: reset });
  const row = await prisma.trainingAnalysis.findUnique({ where: { courseId } });
  return claimed.count ? row : Object.assign(row, { duplicate: true });
}

/** Re-queues a FAILED analysis, keeping every step that already finished for the same material. */
async function retryAnalysis(courseId, { startedById = null } = {}) {
  const existing = await prisma.trainingAnalysis.findUnique({ where: { courseId }, include: { course: { include: { modules: true } } } });
  if (!existing || existing.status !== 'FAILED') return null;
  const sameMaterial = existing.sourceHash && existing.sourceHash === computeSourceHash(modulesFor(existing.course.modules, existing.course.draftVersion || 1));
  const claimed = await prisma.trainingAnalysis.updateMany({ where: { courseId, status: 'FAILED' }, data: { status: 'QUEUED', retryCount: 0, errorMessage: null, queuedAt: new Date(), ...(sameMaterial ? {} : { completedStep: null, sourceHash: null }), ...(startedById ? { startedById } : {}) } });
  return claimed.count ? prisma.trainingAnalysis.findUnique({ where: { courseId } }) : null;
}

registerJobType({
  name: 'trainingAnalysis',
  async findNext() {
    const next = await prisma.trainingAnalysis.findFirst({ where: { status: 'QUEUED' }, orderBy: { queuedAt: 'asc' } });
    if (!next) return null;
    return { id: next.id, run: () => runPipeline(next.id) };
  },
  async requeueStuck() {
    const cutoff = new Date(Date.now() - STUCK_AFTER_MS);
    const stuck = await prisma.trainingAnalysis.findMany({
      where: { status: { in: ['EXTRACTING', 'MAPPING', 'VALIDATING'] }, updatedAt: { lt: cutoff } },
    });
    for (const row of stuck) {
      const nextRetryCount = row.retryCount + 1;
      await prisma.trainingAnalysis.update({
        where: { id: row.id },
        data: nextRetryCount < MAX_RETRIES
          ? { status: 'QUEUED', retryCount: nextRetryCount, errorMessage: 'Recovered after being stuck in processing.' }
          : { status: 'FAILED', retryCount: nextRetryCount, errorMessage: 'Stuck in processing and exceeded retry limit.' },
      });
    }
  },
});

module.exports = { enqueueAnalysis, retryAnalysis, runPipeline, computeSourceHash, groundInsights, ANALYSIS_PROMPTS, ACTIVE_STATUSES, PURPOSES, PURPOSE_LABEL, CLASSIFICATIONS, PRACTICE_METHODS };
