'use strict';

const express = require('express');
const router = express.Router();

const { prisma } = require('../../lib/prisma');
const { requireRole } = require('../../lib/authMiddleware');
const { QUESTION_TYPES, safeParse } = require('../../lib/practiceEngine');
const { validatePractice, contentHash } = require('../../lib/practiceValidation');
const { QUESTION_ASSESSMENTS, CONFIG_ASSESSMENTS, HAND_EDITABLE, MIN_PASSING, readQuestionForm, reopenIfApproved, regenerateQuestion, reviseWithPrompt, lines, clip } = require('../../lib/practiceReview');
const { logAudit } = require('../../lib/audit');
const { lockReason } = require('../../lib/courseVersions');
const tasks = require('../../lib/aiTasks');
const plan = require('../../lib/practicePlan');
const { claim, release } = require('../../lib/inFlightLock');

const canManage = requireRole('ADMIN'); // AI Practice review tools are Admin-only

function canEditCourse(actor, course) {
  return course.organizationId === actor.organizationId && actor.role === 'ADMIN';
}

// The practice builder lives in AI Practice. The old plan URLs lead there; the POST keeps working and now builds in the background.
router.get('/training/:id/practice-plan', canManage, async (req, res) => {
  const course = await prisma.trainingCourse.findFirst({ where: { id: req.params.id, organizationId: req.profile.organizationId }, select: { id: true } });
  if (!course) return res.status(404).render('not-found', { layout: false });
  res.redirect(`/ai-practice/${course.id}?step=practice`);
});

router.post('/training/:id/practice-plan', canManage, async (req, res) => {
  const actor = req.profile;
  const course = await prisma.trainingCourse.findFirst({ where: { id: req.params.id, organizationId: actor.organizationId }, include: { analysis: true } });
  if (!course) return res.status(404).render('not-found', { layout: false });
  if (!canEditCourse(actor, course)) return res.status(403).render('forbidden');
  if (!course.analysis || course.analysis.status !== 'APPROVED') return res.redirect(`/ai-practice/${course.id}?step=analysis`);
  const chosen = plan.readCustomPlan({ ...req.body, level: req.body.level || safeParse(course.analysis.recommendedIntensityJson, 3) });
  if (chosen.length) await tasks.startBuild({ actor, course, plan: chosen, sourceHash: course.analysis.sourceHash });
  res.redirect(`/ai-practice/${course.id}?step=practice`);
});

async function loadOwnedAssessment(actor, id) {
  const assessment = await prisma.assessment.findFirst({
    where: { id, organizationId: actor.organizationId },
    include: { questions: { orderBy: { displayOrder: 'asc' } }, course: true },
  });
  if (!assessment) return null;
  return assessment;
}

const back = (assessment, q = '') => `/admin/assessments/${assessment.id}${q}`;
const notFound = (res) => res.status(404).render('not-found', { layout: false });

async function renderReview(res, assessment, extra = {}) {
  res.render('admin/assessments/detail', {
    title: assessment.title,
    assessment,
    config: safeParse(assessment.configJson, {}),
    validation: (() => { const v = safeParse(assessment.configJson, {}) && safeParse(assessment.configJson, {}).validation; return v ? { ...v, stale: v.contentHash !== contentHash(assessment) } : null; })(),
    locked: lockReason(assessment),
    answerKeyOf: require('../../lib/answerKey').keyFor, // flags a question whose correct answer is not one of its options
    isQuestionSet: QUESTION_ASSESSMENTS.includes(assessment.type),
    isConfigSet: CONFIG_ASSESSMENTS.includes(assessment.type),
    HAND_EDITABLE,
    QUESTION_TYPES,
    MIN_PASSING,
    notice: null,
    error: null,
    ...extra,
  });
}

router.get('/assessments/:id', canManage, async (req, res) => {
  const assessment = await loadOwnedAssessment(req.profile, req.params.id);
  if (!assessment) return notFound(res);
  const notices = { saved: 'Saved. Approve it again when you are happy with the changes.', revised: 'The AI revised the practice — review the changes below.', checked: 'The AI check finished — see the results below.' };
  await renderReview(res, assessment, { notice: notices[req.query.notice] || null, error: typeof req.query.error === 'string' ? req.query.error.slice(0, 240) : null });
});

// What the learner will see — nothing here is recorded as an attempt and no answers are shown.
router.get('/assessments/:id/preview', canManage, async (req, res) => {
  const assessment = await loadOwnedAssessment(req.profile, req.params.id);
  if (!assessment) return notFound(res);
  res.render('admin/assessments/preview', {
    title: 'Preview — ' + assessment.title,
    assessment,
    config: safeParse(assessment.configJson, {}),
    questions: assessment.questions.map((q) => ({ ...q, options: safeParse(q.optionsJson, []) })),
  });
});

router.post('/assessments/:id/update', canManage, async (req, res) => {
  const actor = req.profile;
  const assessment = await loadOwnedAssessment(actor, req.params.id);
  if (!assessment || assessment.status === 'ARCHIVED') return notFound(res);
  if (lockReason(assessment)) return renderReview(res.status(409), assessment, { error: lockReason(assessment) });
  const title = clip(req.body.title, 160);
  const level = Number(req.body.level);
  const passingScore = Number(req.body.passingScore);
  if (title.length < 2) return renderReview(res.status(400), assessment, { error: 'Enter a title.' });
  if (!Number.isInteger(level) || level < 1 || level > 5) return renderReview(res.status(400), assessment, { error: 'Difficulty must be between 1 and 5.' });
  if (!Number.isInteger(passingScore) || passingScore < MIN_PASSING || passingScore > 100) return renderReview(res.status(400), assessment, { error: `The passing score must be between ${MIN_PASSING} and 100.` });

  const data = { title, level, passingScore, instructions: clip(req.body.instructions, 2000) || null };
  const config = safeParse(assessment.configJson, {});
  const changed = [];
  if (title !== assessment.title) changed.push('title');
  if (level !== assessment.level) changed.push('difficulty');
  if (passingScore !== assessment.passingScore) changed.push('passingScore');
  if ((data.instructions || null) !== (assessment.instructions || null)) changed.push('instructions');
  if (CONFIG_ASSESSMENTS.includes(assessment.type)) {
    const rubric = lines(String(req.body.rubricSkills || '').replace(/,/g, '\n')).slice(0, 8);
    if (rubric.length < 3) return renderReview(res.status(400), assessment, { error: 'Keep at least three rubric skills.' });
    const next = { ...config, customerPersonality: clip(req.body.customerPersonality, 300), scenarioBrief: clip(req.body.scenarioBrief, 2000), openingLine: clip(req.body.openingLine, 500), rubricSkills: rubric };
    // Hidden from learners: only edited when the form sends them, so an older form never wipes them.
    if (req.body.hiddenContext !== undefined) next.hiddenContext = clip(req.body.hiddenContext, 2000);
    if (req.body.expectedTechnique !== undefined) next.expectedTechnique = clip(req.body.expectedTechnique, 2000);
    if (!next.scenarioBrief || !next.openingLine) return renderReview(res.status(400), assessment, { error: 'The scenario brief and the customer opening line cannot be empty.' });
    for (const key of ['customerPersonality', 'scenarioBrief', 'openingLine', 'hiddenContext', 'expectedTechnique']) if ((next[key] || '') !== (config[key] || '')) changed.push(key);
    if (JSON.stringify(next.rubricSkills) !== JSON.stringify(config.rubricSkills)) changed.push('rubric');
    data.configJson = JSON.stringify(next);
  }
  await prisma.$transaction(async (tx) => {
    await tx.assessment.update({ where: { id: assessment.id }, data });
    if (changed.length) await reopenIfApproved(tx, assessment);
  });
  if (changed.length) await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'assessment.edited', targetTable: 'Assessment', targetId: assessment.id, metadata: { fields: changed } });
  res.redirect(back(assessment, '?notice=saved'));
});

async function withQuestion(req, res) {
  const assessment = await loadOwnedAssessment(req.profile, req.params.id);
  if (!assessment || assessment.status === 'ARCHIVED' || !QUESTION_ASSESSMENTS.includes(assessment.type)) { notFound(res); return {}; }
  const question = req.params.qid ? assessment.questions.find((q) => q.id === req.params.qid) : null;
  if (req.params.qid && !question) { notFound(res); return {}; } // a question ID from another assessment looks like a missing one
  if (lockReason(assessment)) { renderReview(res.status(409), assessment, { error: lockReason(assessment) }); return {}; }
  return { assessment, question };
}

router.post('/assessments/:id/questions', canManage, async (req, res) => {
  const { assessment } = await withQuestion(req, res);
  if (!assessment) return;
  const parsed = readQuestionForm(req.body);
  if (parsed.error || parsed.wordingOnly) return renderReview(res.status(400), assessment, { error: parsed.error || 'Add single-choice, multiple-choice, true/false or short-answer questions by hand; other types come from the AI.' });
  if (assessment.questions.length >= 30) return renderReview(res.status(400), assessment, { error: 'A practice can have at most 30 questions.' });
  await prisma.$transaction(async (tx) => {
    await tx.question.create({ data: { ...parsed.data, assessmentId: assessment.id, displayOrder: assessment.questions.length } });
    await reopenIfApproved(tx, assessment);
  });
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'assessment.question_added', targetTable: 'Assessment', targetId: assessment.id });
  res.redirect(back(assessment, '?notice=saved'));
});

router.post('/assessments/:id/questions/:qid', canManage, async (req, res) => {
  const { assessment, question } = await withQuestion(req, res);
  if (!assessment) return;
  const parsed = readQuestionForm(req.body, question.type);
  if (parsed.error) return renderReview(res.status(400), assessment, { error: parsed.error });
  const { type: _type, ...data } = parsed.data; // the type of an existing question never changes
  await prisma.$transaction(async (tx) => {
    await tx.question.update({ where: { id: question.id }, data });
    await reopenIfApproved(tx, assessment);
  });
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'assessment.question_edited', targetTable: 'Assessment', targetId: assessment.id, metadata: { questionId: question.id } });
  res.redirect(back(assessment, '?notice=saved'));
});

router.post('/assessments/:id/questions/:qid/delete', canManage, async (req, res) => {
  const { assessment, question } = await withQuestion(req, res);
  if (!assessment) return;
  await prisma.$transaction(async (tx) => {
    await tx.question.delete({ where: { id: question.id } });
    const rest = await tx.question.findMany({ where: { assessmentId: assessment.id }, orderBy: { displayOrder: 'asc' }, select: { id: true } });
    for (const [i, row] of rest.entries()) await tx.question.update({ where: { id: row.id }, data: { displayOrder: i } });
    await reopenIfApproved(tx, assessment);
  });
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'assessment.question_removed', targetTable: 'Assessment', targetId: assessment.id, metadata: { questionId: question.id } });
  res.redirect(back(assessment, '?notice=saved'));
});

router.post('/assessments/:id/questions/:qid/regenerate', canManage, async (req, res) => {
  const { assessment, question } = await withQuestion(req, res);
  if (!assessment) return;
  // Same shared lock as the AI Practice builder's component actions (lib/inFlightLock): this edits
  // the same Assessment row a builder "Adjust"/"Make harder" could be mid-edit on, and a double-click
  // here alone would otherwise race two Gemini rewrites of the same question.
  if (!claim(`assessment:${assessment.id}`)) return renderReview(res.status(409), assessment, { error: 'Already working on this — please wait for it to finish.' });
  try {
    await regenerateQuestion({ assessment, question, instruction: clip(req.body.instruction, 500) });
  } catch (err) {
    await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'assessment.regenerate_failed', targetTable: 'Assessment', targetId: assessment.id, metadata: { questionId: question.id, error: err.message } });
    return renderReview(res.status(502), assessment, { error: 'The AI could not rewrite this question right now. Nothing was changed — try again.' });
  } finally {
    release(`assessment:${assessment.id}`);
  }
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'assessment.question_regenerated', targetTable: 'Assessment', targetId: assessment.id, metadata: { questionId: question.id, hasInstruction: Boolean(req.body.instruction) } });
  res.redirect(back(assessment, '?notice=revised'));
});

router.post('/assessments/:id/revise', canManage, async (req, res) => {
  const assessment = await loadOwnedAssessment(req.profile, req.params.id);
  if (!assessment || assessment.status === 'ARCHIVED') return notFound(res);
  if (lockReason(assessment)) return renderReview(res.status(409), assessment, { error: lockReason(assessment) });
  const instruction = clip(req.body.instruction, 600);
  if (instruction.length < 5) return renderReview(res.status(400), assessment, { error: 'Tell the AI what to change, for example "Make this role-play harder".' });
  if (!claim(`assessment:${assessment.id}`)) return renderReview(res.status(409), assessment, { error: 'Already working on this — please wait for it to finish.' });
  let outcome;
  try {
    outcome = await reviseWithPrompt({ assessment, instruction });
  } catch (err) {
    if (err.userFacing) return renderReview(res.status(400), assessment, { error: err.message });
    await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'assessment.revise_failed', targetTable: 'Assessment', targetId: assessment.id, metadata: { error: err.message } });
    return renderReview(res.status(502), assessment, { error: 'The AI could not apply that right now. Nothing was changed — try again.' });
  } finally {
    release(`assessment:${assessment.id}`);
  }
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'assessment.revised_with_prompt', targetTable: 'Assessment', targetId: assessment.id, metadata: { kind: outcome.kind, changed: outcome.changed } });
  res.redirect(back(assessment, '?notice=revised'));
});

router.post('/assessments/:id/approve', canManage, async (req, res) => {
  const assessment = await loadOwnedAssessment(req.profile, req.params.id);
  if (!assessment) return notFound(res);
  if (lockReason(assessment)) return renderReview(res.status(409), assessment, { error: lockReason(assessment) });
  if (QUESTION_ASSESSMENTS.includes(assessment.type) && !assessment.configJson?.includes('"nodes"') && assessment.questions.length === 0) {
    return renderReview(res.status(409), assessment, { error: 'Add at least one question before approving.' });
  }
  await prisma.assessment.update({ where: { id: assessment.id }, data: { status: 'APPROVED', approvedById: req.profile.id, approvedAt: new Date() } });
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'assessment.approved', targetTable: 'Assessment', targetId: assessment.id });
  res.redirect(`/ai-practice/${assessment.courseId}?step=review`);
});

// Re-runs the AI check against the source knowledge (after edits, or if the first check was unavailable).
router.post('/assessments/:id/validate', canManage, async (req, res) => {
  const assessment = await loadOwnedAssessment(req.profile, req.params.id);
  if (!assessment || assessment.status === 'ARCHIVED') return notFound(res);
  try {
    await validatePractice(assessment.id);
  } catch (err) {
    console.error('[practice] validation failed:', err.message || err);
    return renderReview(res.status(502), assessment, { error: 'The AI check is not available right now. Nothing was changed — try again.' });
  }
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'assessment.validated', targetTable: 'Assessment', targetId: assessment.id });
  res.redirect(back(assessment, '?notice=checked'));
});

router.post('/assessments/:id/delete', canManage, async (req, res) => {
  const assessment = await loadOwnedAssessment(req.profile, req.params.id);
  if (!assessment) return res.status(404).render('not-found', { layout: false });
  if (lockReason(assessment)) return renderReview(res.status(409), assessment, { error: lockReason(assessment) });
  const courseId = assessment.courseId;
  await prisma.assessment.update({ where: { id: assessment.id }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'assessment.deleted', targetTable: 'Assessment', targetId: assessment.id });
  res.redirect(`/ai-practice/${courseId}?step=practice`);
});

module.exports = router;
