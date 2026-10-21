'use strict';

// Smart Retake (spec section 9) decisions, used by POST /assessments/:id/remediate:
//   * which skills a retake aims at - the ones below the pass mark, else the weakest, else the whole practice;
//   * what it is written from - the learner's own version of the material, never a newer draft;
//   * whether a retake for this failure was already prepared (a second tap or a refresh opens it again).
const { prisma } = require('./prisma');
const { modulesFor, retakeOf } = require('./courseVersions');
const { computeSourceHash } = require('./trainingAnalysis');
const { keyFor } = require('./answerKey');

const safeParse = (value, fallback) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };

/**
 * The skills a retake aims at, from the failed attempt's skill breakdown: every skill below the pass mark; when
 * none is (the overall score can fail while each skill passes), the weakest one or two. An empty list means the
 * practice tagged no skills, and the retake covers the whole practice again.
 */
function focusSkillsFor(skillBreakdown, passingScore) {
  const scored = Object.entries(skillBreakdown || {}).filter(([, score]) => typeof score === 'number' && Number.isFinite(score) && score >= 0);
  const weak = scored.filter(([, score]) => score < passingScore).map(([skill]) => skill);
  if (weak.length) return weak;
  return scored.sort((a, b) => a[1] - b[1]).slice(0, 2).map(([skill]) => skill);
}

/** The failed practice itself as the source of a retake: it was written from the learner's version of the material. */
function analysisFromPractice(practice, analysis) {
  const config = safeParse(practice.configJson, {}) || {};
  const questions = (practice.questions || []).map((q) => ({ question: q.prompt, correctAnswer: keyFor(q).answers, explanation: q.explanation || undefined }));
  const scenario = [config.scenarioBrief, config.hiddenContext, config.expectedTechnique, ...(config.nodes || []).map((n) => n.situation)].filter(Boolean);
  const skills = [...new Set([...(practice.questions || []).flatMap((q) => safeParse(q.skillIdsJson, [])), ...(config.rubricSkills || []), ...(config.skills || [])])];
  return {
    criticalKnowledgeJson: JSON.stringify(questions.length ? questions : scenario),
    practicalBehaviorsJson: '[]',
    commonMistakesJson: '[]',
    sourceReferencesJson: '{}',
    extractedSkillsJson: JSON.stringify(skills),
    // the kind of source (sales, technical, ...) is the same whichever version is analysed
    insightsJson: analysis ? analysis.insightsJson : null,
    classificationsJson: analysis ? analysis.classificationsJson : null,
  };
}

/**
 * What a retake is written from: the course analysis while it still describes the material of the learner's
 * version. Once a newer version's material has been analysed (a draft in AI Practice), the practice the learner
 * failed is the source instead, so a retake never tests material the learner was not given.
 * course: loaded with { analysis, modules }; practice: the failed assessment with its questions; version: the learner's.
 */
function retakeSource(course, practice, version = practice.version || 1) {
  const { analysis } = course;
  const describesVersion = analysis && (analysis.sourceHash
    ? analysis.sourceHash === computeSourceHash(modulesFor(course.modules, version))
    : (course.draftVersion || 1) <= version); // no fingerprint: trusted only while no later version has been drafted
  return describesVersion ? analysis : analysisFromPractice(practice, analysis);
}

/**
 * A retake this learner already has for this failure and has not started (the newest), or null - so a double tap,
 * a refreshed page or a second click opens the same retake instead of building (and paying for) another.
 */
async function preparedRetake(actor, practice, originalId, failedAttempt) {
  const candidates = await prisma.assessment.findMany({
    where: { courseId: practice.courseId, createdById: actor.id, type: practice.type, status: 'APPROVED', archivedAt: null, createdAt: { gte: failedAttempt.completedAt || failedAttempt.createdAt }, configJson: { contains: originalId } },
    include: { attempts: { where: { profileId: actor.id }, select: { id: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return candidates.find((a) => retakeOf(a) === originalId && a.attempts.length === 0) || null;
}

module.exports = { focusSkillsFor, retakeSource, analysisFromPractice, preparedRetake };
