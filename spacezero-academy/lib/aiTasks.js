'use strict';

// Background AI work that is not part of source analysis (which has its own queue in trainingAnalysis.js):
// building a practice package. One AiTask row per unit of work gives us
//   * idempotency  - activeKey is unique while a task is active, so a double click cannot run it twice;
//   * background   - the job poller picks it up; the browser does not have to stay open;
//   * recovery     - a failed or interrupted build keeps what was already generated and only builds the rest;
//   * traceability - task type, model, prompt version, source version, retries and the error are stored.
const { prisma } = require('./prisma');
const { registerJobType, MAX_RETRIES, STUCK_AFTER_MS } = require('./jobQueue');
const { logAudit } = require('./audit');
const { LABEL, QUESTION_TYPES } = require('./practicePlan');
const { draftWhere, isTargetedRetake } = require('./courseVersions');

// Prompt/template versions. Bump when a prompt changes materially so results can be traced to what produced them.
const PROMPTS = {
  'analysis.extract': 'analysis.extract@2',
  'analysis.map': 'analysis.map@2',
  'analysis.validate': 'analysis.validate@2',
  'practice.generate': 'practice.generate@4', // @4: master generation rules (one practice, Level 2, role-play hidden context, quality check)
  'practice.revise': 'practice.revise@2',
  'practice.evaluate': 'practice.evaluate@2',
  'call.transcribe': 'call.transcribe@1',
  'call.analyze': 'call.analyze@1',
};

const PRACTICE_BUILD = 'PRACTICE_BUILD';
const ACTIVE = ['QUEUED', 'RUNNING'];
const safe = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };

/** Queues a task unless an identical one is already active. Returns { task, duplicate }. */
async function enqueue({ organizationId, courseId = null, batchId = null, taskType, payload = {}, requestedById = null, sourceHash = null }) {
  const activeKey = `${taskType}:${courseId || batchId}`;
  const active = await prisma.aiTask.findUnique({ where: { activeKey } }); // the common double click is answered without touching the unique key
  if (active) return { task: active, duplicate: true };
  try {
    const task = await prisma.aiTask.create({ data: { organizationId, courseId, batchId, taskType, activeKey, payloadJson: JSON.stringify(payload), requestedById, sourceHash, promptVersion: PROMPTS['practice.generate'] } });
    return { task, duplicate: false };
  } catch (err) {
    if (err && err.code === 'P2002') return { task: await prisma.aiTask.findUnique({ where: { activeKey } }), duplicate: true };
    throw err;
  }
}

async function finish(id, data) {
  await prisma.aiTask.update({ where: { id }, data: { ...data, activeKey: null, finishedAt: new Date() } });
}

/** Latest build task of a course (active first), for status and the Retry action. */
async function latestBuild(courseId) {
  return prisma.aiTask.findFirst({ where: { courseId, taskType: PRACTICE_BUILD }, orderBy: { createdAt: 'desc' } });
}

async function startBuild({ actor, course, plan, sourceHash = null }) {
  const clean = plan.filter((p) => p && LABEL[p.type]).map((p) => ({ type: p.type, count: p.count, level: p.level, ...(p.add ? { add: true } : {}) }));
  if (!clean.length) return { ok: false, error: 'Choose at least one kind of practice.' };
  const { task, duplicate } = await enqueue({ organizationId: course.organizationId, courseId: course.id, taskType: PRACTICE_BUILD, payload: { plan: clean, version: course.draftVersion || 1 }, requestedById: actor.id, sourceHash });
  if (!duplicate) await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'practice.build_started', targetTable: 'TrainingCourse', targetId: course.id, metadata: { plan: clean, taskId: task.id } });
  return { ok: true, task, duplicate };
}

/** Re-queues a failed build. Anything already generated stays; only the missing components are built. */
async function retryBuild({ actor, course }) {
  const last = await latestBuild(course.id);
  if (!last || last.status !== 'FAILED') return { ok: false, error: 'There is nothing to retry.' };
  const payload = safe(last.payloadJson, {});
  // An "add" item is not skipped just because practice of that type exists, so a retry must only ask for what the failed run did not build.
  const built = (safe(last.resultJson, {}).built || []);
  payload.plan = (payload.plan || []).map((item) => (item.add ? { ...item, count: QUESTION_TYPES.includes(item.type) ? (built.some((b) => b.type === item.type) ? 0 : 1) : item.count - built.filter((b) => b.type === item.type).length } : item)).filter((item) => item.count > 0);
  if (!payload.plan.length) return { ok: false, error: 'Everything in that request was already built.' };
  const { task, duplicate } = await enqueue({ organizationId: course.organizationId, courseId: course.id, taskType: PRACTICE_BUILD, payload, requestedById: actor.id, sourceHash: last.sourceHash });
  if (!duplicate) {
    await prisma.aiTask.update({ where: { id: task.id }, data: { retryCount: last.retryCount + 1 } });
    await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'practice.build_retried', targetTable: 'TrainingCourse', targetId: course.id, metadata: { taskId: task.id } });
  }
  return { ok: true, task, duplicate };
}

// ------------------------------------------------------------------ generating one component
/**
 * Generates ONE practice component (an assessment) of the given type and stamps it with the version, prompt
 * version and status the package needs. Used by the background build and by single-component regeneration, so
 * nothing else is ever regenerated. `count` is the number of questions for question-based practice.
 */
async function generateComponent({ course, analysis, actor, type, level = 3, count = 6, focusSkills = null }) {
  const { generateQuestionAssessment, generateRoleplayAssessment } = require('./practiceEngine');
  let created;
  if (QUESTION_TYPES.includes(type)) created = await generateQuestionAssessment({ course, analysis, actor, type, level, questionCount: count, focusSkills });
  else if (type === 'ROLEPLAY' || type === 'VOICE') created = await generateRoleplayAssessment({ course, analysis, actor, level, type, focusSkills });
  else if (type === 'PROCESS_SIM') created = await require('./processSimulation').generateProcessAssessment({ course, analysis, actor, level, focusSkills });
  else throw new Error(`Unknown practice type ${type}`);
  const stamped = await prisma.assessment.update({ where: { id: created.id }, data: { version: course.draftVersion || 1, promptVersion: PROMPTS['practice.generate'], passingScore: Math.max(created.passingScore, course.passingScore) }, include: { questions: { select: { id: true } } } });
  // AI check against the source: advice for the reviewer only, never a gate.
  await require('./practiceValidation').validatePractice(stamped.id).catch(async (err) => {
    console.error('[practice] validation failed:', err.message || err);
    await logAudit({ organizationId: course.organizationId, actorId: actor.id, action: 'practice.validation_failed', targetTable: 'Assessment', targetId: stamped.id });
  });
  return stamped;
}

/** How much of a plan item is already there (so a retry builds only what is missing). */
function alreadyBuilt(existing, item) {
  const of = existing.filter((a) => a.type === item.type);
  return QUESTION_TYPES.includes(item.type) ? (of.length ? 1 : 0) : of.length;
}

async function runBuild(taskId) {
  const task = await prisma.aiTask.findUnique({ where: { id: taskId } });
  if (!task || task.status !== 'RUNNING') return;
  const payload = safe(task.payloadJson, {});
  const [course, actor] = await Promise.all([
    prisma.trainingCourse.findUnique({ where: { id: task.courseId }, include: { analysis: true } }),
    prisma.profile.findUnique({ where: { id: task.requestedById } }),
  ]);
  if (!course || !course.analysis || !actor) return finish(task.id, { status: 'FAILED', errorMessage: 'The source or the person who started this no longer exists.' });
  if ((course.draftVersion || 1) !== (payload.version || 1)) return finish(task.id, { status: 'FAILED', errorMessage: 'The version being built changed. Start the build again.' });

  const built = []; const failures = []; let model = null;
  for (const item of payload.plan || []) {
    const existing = (await prisma.assessment.findMany({ where: draftWhere(course) })).filter((a) => !isTargetedRetake(a));
    const have = item.add ? 0 : alreadyBuilt(existing, item); // "add" always builds more; a plain plan only builds what is missing
    const need = QUESTION_TYPES.includes(item.type) ? (have ? 0 : 1) : Math.max(0, item.count - have);
    for (let i = 0; i < need; i += 1) {
      try {
        const made = await generateComponent({ course, analysis: course.analysis, actor, type: item.type, level: item.level, count: item.count });
        model = made.modelVersion || model;
        built.push({ type: item.type, id: made.id });
        if (need > 1) await prisma.assessment.update({ where: { id: made.id }, data: { title: `${made.title} (${have + i + 1})` } });
        else if (item.add) await prisma.assessment.update({ where: { id: made.id }, data: { title: `${made.title} (added)` } });
      } catch (err) {
        failures.push({ type: item.type, error: String(err.message || err).slice(0, 300) });
        break; // the same failure would repeat; the Admin can retry the rest
      }
    }
  }
  const total = (await prisma.assessment.count({ where: draftWhere(course) }));
  if (failures.length && !built.length && !total) {
    await finish(task.id, { status: 'FAILED', model, errorMessage: failures[0].error, resultJson: JSON.stringify({ built, failures }) });
    return;
  }
  await finish(task.id, { status: failures.length ? 'FAILED' : 'DONE', model, errorMessage: failures.length ? `Could not build: ${failures.map((f) => LABEL[f.type]).join(', ')}` : null, resultJson: JSON.stringify({ built, failures }) });
  await logAudit({ organizationId: task.organizationId, actorId: task.requestedById, action: failures.length ? 'practice.build_partial' : 'practice.generated', targetTable: 'TrainingCourse', targetId: course.id, metadata: { built: built.length, failed: failures.map((f) => f.type), taskId: task.id } });
}

registerJobType({
  name: 'practiceBuild',
  async findNext() {
    const next = await prisma.aiTask.findFirst({ where: { taskType: PRACTICE_BUILD, status: 'QUEUED' }, orderBy: { createdAt: 'asc' } });
    if (!next) return null;
    const claimed = await prisma.aiTask.updateMany({ where: { id: next.id, status: 'QUEUED' }, data: { status: 'RUNNING', startedAt: new Date() } });
    return claimed.count ? { id: next.id, run: () => runBuild(next.id).catch((err) => finish(next.id, { status: 'FAILED', errorMessage: String(err.message || err).slice(0, 300) })) } : null;
  },
  async requeueStuck() {
    const stuck = await prisma.aiTask.findMany({ where: { taskType: PRACTICE_BUILD, status: 'RUNNING', updatedAt: { lt: new Date(Date.now() - STUCK_AFTER_MS) } } });
    for (const row of stuck) {
      if (row.retryCount + 1 < MAX_RETRIES) await prisma.aiTask.update({ where: { id: row.id }, data: { status: 'QUEUED', retryCount: row.retryCount + 1, errorMessage: 'Recovered after an interruption.' } });
      else await finish(row.id, { status: 'FAILED', errorMessage: 'Interrupted too many times. Retry the build.' });
    }
  },
});

/** Runs the oldest queued build of a course now (used by the poller's claim logic and by tests). */
async function runQueuedBuild(courseId) {
  const next = await prisma.aiTask.findFirst({ where: { courseId, taskType: PRACTICE_BUILD, status: 'QUEUED' }, orderBy: { createdAt: 'asc' } });
  if (!next) return null;
  const claimed = await prisma.aiTask.updateMany({ where: { id: next.id, status: 'QUEUED' }, data: { status: 'RUNNING', startedAt: new Date() } });
  if (!claimed.count) return null;
  await runBuild(next.id);
  return prisma.aiTask.findUnique({ where: { id: next.id } });
}

module.exports = { PROMPTS, PRACTICE_BUILD, ACTIVE, enqueue, latestBuild, startBuild, retryBuild, generateComponent, runBuild, runQueuedBuild, finish };
