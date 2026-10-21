'use strict';

// AI Practice = the AI Practice workspace: SOURCE -> ANALYSIS -> PRACTICE -> REVIEW -> TRAINING.
// Each step is its own action the actor starts; uploading never analyzes, analyzing never generates
// practice, and approving never publishes. Organization-scoped on the server; object IDs in the URL
// are always re-checked, never trusted. An Admin may work on any course in the organization. A
// Supervisor may work here ONLY with the Admin-granted 'training.create' or 'training.revise'
// capability (lib/supervisorCapabilities.js), and even then ONLY on courses they created themselves
// — loadCourse() below enforces that ownership scope for every route that uses it, so this is not
// re-checked route by route. The final publish step ("Send to Training") stays Admin-only regardless
// of ownership or capability: a Supervisor prepares a draft and submits it for approval instead —
// see the "Supervisor Training Creation: review" section below.
const express = require('express');
const router = express.Router();
const { unlimitedUpload, withCleanup } = require('../lib/uploads');

const { prisma } = require('../lib/prisma');
const trainingCategories = require('../lib/trainingCategories');
const { ACCEPT, storeFiles, storeCallFiles, releaseFile } = require('../lib/sourceFiles');
const { logAudit } = require('../lib/audit');
const courseDeletion = require('../lib/courseDeletion');
const { getSetting } = require('../lib/orgSettings');
const { checkPassingScore } = require('../lib/courseAudience');
const { roleLabel } = require('../lib/roles');
const state = require('../lib/aiPracticeState');
const versions = require('../lib/courseVersions');
const plan = require('../lib/practicePlan');
const tasks = require('../lib/aiTasks');
const analysisLib = require('../lib/trainingAnalysis');
const { ensureWorkspace } = require('../lib/aiPracticeBackfill');
const { relevanceFor } = require('../lib/practiceRelevance');
const { reviseWithPrompt } = require('../lib/practiceReview');
const { safeParse } = require('../lib/practiceEngine');
const { takeAiSlot } = require('../lib/rateLimit');
const { hasCapability } = require('../lib/supervisorCapabilities');
const { claim, release } = require('../lib/inFlightLock');

const redirectToLogin = (req, res) => res.redirect(`/login?next=${encodeURIComponent(req.originalUrl || '/dashboard')}`);
// Admin: unconditional. Supervisor: only with an explicit, Admin-granted capability — nothing is
// automatic from the SUPERVISOR role alone. Course-level ownership scoping happens in loadCourse().
const creators = async (req, res, next) => {
  const actor = req.profile;
  if (!actor) return redirectToLogin(req, res);
  if (actor.role === 'ADMIN') return next();
  if (actor.role === 'SUPERVISOR' && (await hasCapability(actor, 'training.create') || await hasCapability(actor, 'training.revise'))) return next();
  return res.status(403).render('forbidden');
};
// Starting brand-new material specifically needs 'training.create' — a Supervisor granted only
// 'training.revise' may propose a new version of their existing published training, but may not
// start a fresh one (see the new-version route further down for the mirror-image check).
const mayCreateNew = async (req, res, next) => {
  const actor = req.profile;
  if (!actor) return redirectToLogin(req, res);
  if (actor.role === 'ADMIN') return next();
  if (actor.role === 'SUPERVISOR' && await hasCapability(actor, 'training.create')) return next();
  return res.status(403).render('forbidden');
};
// The final publish is always the Admin's decision — never automatic, and never available to the
// Supervisor who prepared the draft, even for their own course (spec: "may NOT approve/publish
// their own Training"). A Supervisor submits for approval instead (see further down).
const adminOnly = (req, res, next) => {
  if (!req.profile) return redirectToLogin(req, res);
  return req.profile.role === 'ADMIN' ? next() : res.status(403).render('forbidden');
};
// No limit on the size or the number of files: they are streamed to disk (lib/uploads.js), never held in memory.
const upload = unlimitedUpload();
const notFound = (res) => res.status(404).render('not-found', { layout: false });
const { clip } = require('../lib/sourceFiles');

// :id is a cuid. Anything else (calls, new, ...) belongs to another route.
router.param('id', (req, res, next, id) => (/^c[a-z0-9]{20,32}$/.test(id) ? next() : next('route')));

const receive = (field) => withCleanup((req, res, next) => upload.array(field)(req, res, (err) => {
  if (err) req.uploadError = 'The upload could not be read (it may have been interrupted). Please try again.';
  next();
}));

async function loadCourse(actor, id, include = {}) {
  // A Supervisor (even one with training.create/training.revise) never sees another Supervisor's or
  // the Admin's course here — this is the one place that scoping is enforced, so every route below
  // that calls loadCourse() is automatically covered.
  const where = actor.role === 'ADMIN' ? { id, organizationId: actor.organizationId } : { id, organizationId: actor.organizationId, createdById: actor.id };
  const course = await prisma.trainingCourse.findFirst({ where, include });
  // The workspace always works on the version being edited: material added later or removed earlier is not part of it.
  if (course && Array.isArray(course.modules)) course.modules = versions.modulesFor(course.modules, course.draftVersion || 1);
  return course;
}
const editable = (course) => !course.publishedVersion || (course.draftVersion || 1) > course.publishedVersion;
const back = (res, id, params = {}) => res.redirect(`/ai-practice/${id}${Object.keys(params).length ? `?${new URLSearchParams(params).toString()}` : ''}`);
// Gemini calls are the most expensive operation in the app; every route that triggers one (directly
// or via the job queue) checks this first. Returns true (and already responded) when rate limited.
async function aiGate(res, actor, courseId) {
  if (await takeAiSlot(actor)) return false; // counted here: the request is about to start AI work
  back(res, courseId, { error: 'Too many AI requests in a short time. Please wait a few minutes and try again.' });
  return true;
}

// ------------------------------------------------------------------ home
router.get('/ai-practice', creators, async (req, res) => {
  const actor = req.profile;
  await ensureWorkspace(actor).catch((err) => console.error('[ai-practice] backfill failed:', err.message || err));
  const archived = req.query.archived === '1';
  const all = await state.loadSources(actor, { archived });
  const tab = state.TABS.find((t) => t.key === req.query.tab) ? req.query.tab : 'all';
  const q = clip(req.query.q, 80);
  const items = state.filterItems(all, { tab, q });
  const notices = { saved: 'Saved. Start the analysis whenever you are ready.', archived: 'Archived. It is no longer listed here.', deleted: 'Deleted.', restored: 'Restored.' };
  res.render('ai-practice', {
    title: 'AI Practice', items, tabs: state.TABS, counts: state.tabCounts(all), tab, q, archived, total: all.length,
    notice: notices[req.query.notice] || null, error: typeof req.query.error === 'string' ? req.query.error.slice(0, 240) : null,
    savedId: typeof req.query.saved === 'string' ? req.query.saved : '',
  });
});

// ------------------------------------------------------------------ upload (SAVE ONLY)
router.get('/ai-practice/new', mayCreateNew, async (req, res) => {
  const people = await prisma.profile.findMany({ where: { organizationId: req.profile.organizationId, status: 'ACTIVE' }, orderBy: { fullName: 'asc' }, select: { id: true, fullName: true } });
  res.render('ai-practice-new', { title: 'Upload material', error: null, ACCEPT, people, values: {}, kind: req.query.kind === 'call' ? 'call' : 'material', CATEGORIES: trainingCategories.CATEGORIES });
});

router.post('/ai-practice/new', mayCreateNew, receive('files'), async (req, res) => {
  const actor = req.profile;
  const kind = req.body.kind === 'call' ? 'call' : 'material';
  const files = req.files || [];
  const noteText = clip(req.body.noteText, 60000);
  const rerender = (error) => res.status(400).render('ai-practice-new', { title: 'Upload material', error, ACCEPT, people: [], values: req.body, kind, CATEGORIES: trainingCategories.CATEGORIES });
  if (req.uploadError) return rerender(req.uploadError);
  if (!files.length && !(kind === 'material' && noteText)) return rerender(kind === 'call' ? 'Choose at least one recording.' : 'Choose at least one file, or write some notes.');
  const title = clip(req.body.title, 160);

  if (kind === 'call') {
    const calls = await storeCallFiles(files);
    if (calls.error) return rerender(calls.error);
    const saved = calls.recordings;
    // mode is a placeholder until the Admin chooses the purpose when starting the analysis; nothing is analyzed now.
    const batch = await prisma.callBatch.create({ data: { organizationId: actor.organizationId, uploadedById: actor.id, mode: 'BEST_PRACTICE', title: title || null, recordings: { create: saved } } });
    await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'ai_practice.source_uploaded', targetTable: 'CallBatch', targetId: batch.id, metadata: { kind: 'call', files: saved.length } });
    return res.redirect(`/ai-practice?saved=${batch.id}&notice=saved`);
  }

  // Every training has a Training Category from the start; it travels with the training into the Catalog, Assignments and My Training.
  const trainingCategory = trainingCategories.readCategory(req.body.trainingCategory);
  if (!trainingCategory) return rerender('Choose a Training Category: Product, Sales or System & Workflow.');
  const stored = await storeFiles(files);
  if (stored.error) return rerender(stored.error);
  const modules = stored.modules;
  if (noteText) modules.push({ title: 'Notes', contentType: 'NOTE', description: noteText, displayOrder: modules.length });
  const courseTitle = title || (modules[0] ? modules[0].title : 'Untitled material');
  const floor = await getSetting(actor.organizationId, 'training.minPassingScore');
  const course = await prisma.trainingCourse.create({ data: { organizationId: actor.organizationId, title: courseTitle, createdById: actor.id, origin: 'AI_PRACTICE', status: 'DRAFT', passingScore: floor, trainingCategory, modules: { create: modules } } });
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'ai_practice.source_uploaded', targetTable: 'TrainingCourse', targetId: course.id, metadata: { kind: 'material', files: files.length, notes: Boolean(noteText) } });
  res.redirect(`/ai-practice?saved=${course.id}&notice=saved`);
});

// ------------------------------------------------------------------ bulk (kept small on purpose)
router.post('/ai-practice/bulk', creators, async (req, res) => {
  const actor = req.profile;
  const action = String(req.body.action || '');
  const picked = (Array.isArray(req.body.ids) ? req.body.ids : req.body.ids ? [req.body.ids] : []).map(String).slice(0, 100);
  if (!['archive', 'delete', 'delete-all', 'analyze'].includes(action) || !picked.length) return res.redirect('/ai-practice?error=Choose+what+to+do+and+select+at+least+one+item.');
  // \"Delete including trainings in use\" is an Admin's decision (a Supervisor's choice falls back to the safe delete).
  const force = action === 'delete-all' && actor.role === 'ADMIN' && !req.impersonation;
  if (action === 'delete-all' && !force) return res.redirect('/ai-practice?error=Only+an+Admin+can+delete+trainings+that+are+in+use.');
  if (force && req.body.confirm !== '1') {
    const items = [];
    for (const token of picked) {
      const [kind, id] = token.split(':');
      if (kind === 'material') { const c = await loadCourse(actor, id); if (c && c.origin === 'AI_PRACTICE') items.push({ token, title: c.title, kind: 'Training source', impact: await courseDeletion.deletionImpact(c) }); }
      else if (kind === 'call') { const b = await prisma.callBatch.findFirst({ where: { id, organizationId: actor.organizationId } }); if (b) items.push({ token, title: b.title || 'Call recordings', kind: 'Call recordings', impact: null }); }
    }
    return res.render('ai-practice/bulk-delete', { title: 'Delete selected', items });
  }
  const result = { done: 0, skipped: 0 };
  for (const token of picked) {
    const [kind, id] = token.split(':');
    if (kind === 'material') {
      const course = await loadCourse(actor, id, { analysis: true });
      if (!course || course.origin !== 'AI_PRACTICE') { result.skipped += 1; continue; }
      if (action === 'archive') { await versions.archiveSource(actor, course); result.done += 1; }
      else if (force) { await courseDeletion.deleteCourse(actor, course); result.done += 1; } // an Admin: whatever its state, with its assignments and attempts
      else if (action === 'delete') { if ((await versions.deletionPolicy(course)).canDelete) { await removeCourse(actor, course); result.done += 1; } else result.skipped += 1; }
      else if (action === 'analyze') {
        if (course.analysis || !(await prisma.trainingModule.count({ where: { courseId: course.id } }))) { result.skipped += 1; continue; }
        const row = await analysisLib.enqueueAnalysis(course.id, { purpose: 'AUTO', startedById: actor.id });
        if (!row.duplicate) await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'ai_practice.analysis_started', targetTable: 'TrainingCourse', targetId: course.id, metadata: { purpose: 'AUTO', bulk: true } });
        result.done += 1;
      }
    } else if (kind === 'call') {
      const batch = await prisma.callBatch.findFirst({ where: { id, organizationId: actor.organizationId } });
      if (!batch || action === 'analyze') { result.skipped += 1; continue; } // calls need a purpose and consent, chosen one at a time
      if (action === 'archive') { await prisma.callBatch.update({ where: { id }, data: { archivedAt: new Date() } }); await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'ai_practice.source_archived', targetTable: 'CallBatch', targetId: id }); result.done += 1; }
      else if (await removeBatch(actor, batch, { force })) result.done += 1; else result.skipped += 1;
    } else result.skipped += 1;
  }
  const label = { archive: 'archived', delete: 'deleted', 'delete-all': 'deleted', analyze: 'sent for analysis' }[action];
  res.redirect(`/ai-practice?notice=${action === 'analyze' ? 'saved' : label === 'archived' ? 'archived' : 'deleted'}${result.skipped ? `&error=${encodeURIComponent(`${result.done} ${label}; ${result.skipped} skipped (in use, already analyzed, or not compatible).`)}` : ''}`);
});

async function removeCourse(actor, course) {
  const modules = await prisma.trainingModule.findMany({ where: { courseId: course.id }, select: { storagePath: true } });
  await prisma.$transaction([prisma.aiTask.deleteMany({ where: { courseId: course.id } }), prisma.trainingCourse.delete({ where: { id: course.id } })]);
  for (const m of modules) await releaseFile(m.storagePath);
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'ai_practice.source_deleted', targetTable: 'TrainingCourse', targetId: course.id, metadata: { title: course.title } });
}

/** Calls are only deleted when their analysis did not turn into training - unless an Admin forces it (the training made from them stays). */
async function removeBatch(actor, batch, { force = false } = {}) {
  if (!force && batch.generatedCourseId && await prisma.trainingCourse.findUnique({ where: { id: batch.generatedCourseId }, select: { id: true } })) return false;
  if (!['UPLOADED', 'FAILED', 'READY_FOR_REVIEW', 'APPROVED'].includes(batch.status)) return false;
  const recordings = await prisma.callRecording.findMany({ where: { callBatchId: batch.id }, select: { storagePath: true } });
  await prisma.callBatch.delete({ where: { id: batch.id } });
  for (const r of recordings) await releaseFile(r.storagePath);
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'calls.deleted', targetTable: 'CallBatch', targetId: batch.id });
  return true;
}

// ------------------------------------------------------------------ detail page
router.get('/ai-practice/:id', creators, async (req, res) => {
  const actor = req.profile;
  await ensureWorkspace(actor).catch(() => undefined);
  const course = await loadCourse(actor, req.params.id, { analysis: true, modules: { orderBy: { displayOrder: 'asc' } }, createdBy: { select: { fullName: true } }, submittedBy: { select: { fullName: true } } });
  if (!course) return notFound(res);
  if (course.origin !== 'AI_PRACTICE') return res.redirect(`/admin/training/${course.id}`); // hand-built training is managed in Training

  const [components, build, history, batch, reviewHistory] = await Promise.all([
    state.loadComponents(course), tasks.latestBuild(course.id), versions.versionHistory(course.id),
    prisma.callBatch.findFirst({ where: { generatedCourseId: course.id }, select: { id: true, title: true } }),
    versions.reviewHistory(course.id),
  ]);
  const live = components.filter((c) => !versions.isTargetedRetake(c));
  const st = state.courseState(course, { build, components: live, isAdmin: actor.role === 'ADMIN' });
  const stepKey = state.STEPS.find((s) => s.key === req.query.step) ? req.query.step : state.STEPS[Math.min(st.step, 5) - 1].key;

  const analysis = course.analysis;
  const parsed = analysis ? {
    objectives: safeParse(analysis.objectivesJson, []), skills: safeParse(analysis.extractedSkillsJson, []), knowledge: safeParse(analysis.criticalKnowledgeJson, []),
    behaviors: safeParse(analysis.practicalBehaviorsJson, []), mistakes: safeParse(analysis.commonMistakesJson, []), methods: safeParse(analysis.recommendedMethodsJson, []),
    classifications: safeParse(analysis.classificationsJson, []), notes: safeParse(analysis.validationNotesJson, []), refs: safeParse(analysis.sourceReferencesJson, {}) || {},
    insights: safeParse(analysis.insightsJson, {}) || {}, intensity: safeParse(analysis.recommendedIntensityJson, 3),
  } : null;
  const ready = analysis && ['READY_FOR_REVIEW', 'APPROVED'].includes(analysis.status);
  const relevance = ready ? await relevanceFor(actor, { skills: parsed.skills, audienceRoles: parsed.insights.audienceRoles || [] }) : null;
  const stale = Boolean(analysis && analysis.sourceHash && analysis.sourceHash !== analysisLib.computeSourceHash(course.modules));
  const result = build && build.resultJson ? safeParse(build.resultJson, {}) : {};
  // Mirrors the actual guard on POST .../new-version: an Admin always may; a Supervisor needs
  // training.revise specifically (training.create alone is not enough to revise existing training).
  // Shown as a button regardless of this used to just 403 when a create-only Supervisor clicked it.
  const canCreateNewVersion = actor.role === 'ADMIN' || await hasCapability(actor, 'training.revise');

  res.set('Cache-Control', 'private, no-store');
  res.render('ai-practice/detail', {
    title: course.title, course, st, step: stepKey, steps: state.STEPS, analysis, parsed, relevance, stale, components: live, groups: plan.groupComponents(live),
    build, buildResult: result, history, callBatch: batch, editable: editable(course), recommended: analysis ? plan.recommendedPlan(analysis) : [], sourceKind: analysis ? plan.sourceSummary(analysis) : null,
    PLAN: plan, PURPOSE_LABEL: analysisLib.PURPOSE_LABEL, ACCEPT, roleLabel, TYPE_LABEL: state.TYPE_LABEL,
    notice: typeof req.query.notice === 'string' ? req.query.notice.slice(0, 200) : null, error: typeof req.query.error === 'string' ? req.query.error.slice(0, 300) : null,
    autoRefresh: ['ANALYZING', 'BUILDING'].includes(st.key) && !st.halted,
    isAdmin: actor.role === 'ADMIN', reviewHistory, canCreateNewVersion,
    CATEGORIES: trainingCategories.CATEGORIES, categoryLabel: trainingCategories.categoryLabel, suggestedCategory: analysis ? trainingCategories.suggestFromClassifications(analysis.classificationsJson) : '',
  });
});

router.post('/ai-practice/:id/rename', creators, async (req, res) => {
  const course = await loadCourse(req.profile, req.params.id);
  if (!course) return notFound(res);
  const title = clip(req.body.title, 160);
  if (title.length < 2) return back(res, course.id, { error: 'Enter a name.' });
  await prisma.trainingCourse.update({ where: { id: course.id }, data: { title } });
  await logAudit({ organizationId: course.organizationId, actorId: req.profile.id, action: 'ai_practice.source_renamed', targetTable: 'TrainingCourse', targetId: course.id });
  back(res, course.id, { notice: 'Renamed.' });
});

router.post('/ai-practice/:id/sources', creators, receive('files'), async (req, res) => {
  const course = await loadCourse(req.profile, req.params.id, { modules: true });
  if (!course) return notFound(res);
  if (!editable(course)) return back(res, course.id, { error: 'This is in Training. Create a new version before changing its material.' });
  if (req.uploadError) return back(res, course.id, { error: req.uploadError });
  const files = req.files || []; const noteText = clip(req.body.noteText, 60000);
  if (!files.length && !noteText) return back(res, course.id, { error: 'Choose a file or write some notes to add.' });
  const stored = await storeFiles(files);
  if (stored.error) return back(res, course.id, { error: stored.error });
  const rows = stored.modules.map((m, i) => ({ ...m, courseId: course.id, addedInVersion: course.draftVersion || 1, displayOrder: course.modules.length + i }));
  if (noteText) rows.push({ courseId: course.id, title: clip(req.body.noteTitle, 120) || 'Notes', contentType: 'NOTE', description: noteText, addedInVersion: course.draftVersion || 1, displayOrder: course.modules.length + rows.length });
  await prisma.trainingModule.createMany({ data: rows });
  await logAudit({ organizationId: course.organizationId, actorId: req.profile.id, action: 'ai_practice.material_added', targetTable: 'TrainingCourse', targetId: course.id, metadata: { added: rows.length } });
  back(res, course.id, { step: 'source', notice: `Added ${rows.length} item${rows.length === 1 ? '' : 's'}. ${'Analyze again to include it.'}` });
});

router.post('/ai-practice/:id/sources/:moduleId/remove', creators, async (req, res) => {
  const course = await loadCourse(req.profile, req.params.id, { analysis: true, modules: true });
  if (!course) return notFound(res);
  if (!editable(course)) return back(res, course.id, { error: 'This is in Training. Create a new version before changing its material.' });
  if (course.analysis && analysisLib.ACTIVE_STATUSES.includes(course.analysis.status)) return back(res, course.id, { error: 'Wait for the analysis to finish first.' });
  const mod = course.modules.find((m) => m.id === req.params.moduleId);
  if (!mod) return notFound(res);
  if ((mod.addedInVersion || 1) === (course.draftVersion || 1)) { // added in this very draft: it never reached anyone, so it can really go
    await prisma.trainingModule.delete({ where: { id: mod.id } });
    await releaseFile(mod.storagePath);
  } else { // part of an earlier version: it stays for the people who have that version and is only left out of this one
    await prisma.trainingModule.update({ where: { id: mod.id }, data: { removedInVersion: course.draftVersion || 1 } });
  }
  await logAudit({ organizationId: course.organizationId, actorId: req.profile.id, action: 'ai_practice.material_removed', targetTable: 'TrainingModule', targetId: mod.id });
  back(res, course.id, { step: 'source', notice: 'Removed.' });
});

// ------------------------------------------------------------------ analysis
router.get('/ai-practice/:id/analyze', creators, async (req, res) => {
  const course = await loadCourse(req.profile, req.params.id, { analysis: true, modules: { orderBy: { displayOrder: 'asc' } } });
  if (!course) return notFound(res);
  if (course.analysis && req.query.again !== '1') return back(res, course.id, { step: 'analysis' });
  const library = await prisma.libraryItem.findMany({ where: { organizationId: req.profile.organizationId, archivedAt: null }, orderBy: { title: 'asc' }, take: 100, select: { id: true, title: true } });
  res.render('ai-practice/analyze', { title: `Analyze — ${course.title}`, course, library, PURPOSES: analysisLib.PURPOSES, PURPOSE_LABEL: analysisLib.PURPOSE_LABEL, TYPE_LABEL: state.TYPE_LABEL, error: typeof req.query.error === 'string' ? req.query.error.slice(0, 200) : null, again: req.query.again === '1' });
});

router.post('/ai-practice/:id/analyze', creators, async (req, res) => {
  const actor = req.profile;
  const course = await loadCourse(actor, req.params.id, { modules: true });
  if (!course) return notFound(res);
  if (!editable(course)) return back(res, course.id, { error: 'This is in Training. Create a new version to analyze new material.' });
  if (!course.modules.length) return back(res, course.id, { error: 'Add some material first.' });
  if (await aiGate(res, actor, course.id)) return;
  const purpose = analysisLib.PURPOSES.includes(req.body.purpose) ? req.body.purpose : 'AUTO';
  // Optional approved reference knowledge: only Library items of this organization, chosen explicitly, at most 5.
  const wanted = (Array.isArray(req.body.referenceIds) ? req.body.referenceIds : req.body.referenceIds ? [req.body.referenceIds] : []).map(String).slice(0, 5);
  const referenceItemIds = wanted.length ? (await prisma.libraryItem.findMany({ where: { id: { in: wanted }, organizationId: actor.organizationId, archivedAt: null }, select: { id: true } })).map((i) => i.id) : [];
  const row = await analysisLib.enqueueAnalysis(course.id, { purpose, startedById: actor.id, referenceItemIds }); // idempotent: a second click changes nothing
  if (!row.duplicate) {
    await prisma.trainingCourse.update({ where: { id: course.id }, data: { purpose } });
    await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: req.body.again === '1' ? 'ai_practice.analysis_restarted' : 'ai_practice.analysis_started', targetTable: 'TrainingCourse', targetId: course.id, metadata: { purpose } });
  }
  back(res, course.id, { step: 'analysis' });
});

router.post('/ai-practice/:id/analysis/retry', creators, async (req, res) => {
  const course = await loadCourse(req.profile, req.params.id);
  if (!course) return notFound(res);
  if (await aiGate(res, req.profile, course.id)) return;
  const row = await analysisLib.retryAnalysis(course.id, { startedById: req.profile.id }); // keeps the steps that already finished
  if (row) await logAudit({ organizationId: course.organizationId, actorId: req.profile.id, action: 'ai_practice.analysis_retried', targetTable: 'TrainingCourse', targetId: course.id });
  back(res, course.id, { step: 'analysis' });
});

router.post('/ai-practice/:id/analysis/resume', creators, async (req, res) => {
  const course = await loadCourse(req.profile, req.params.id, { analysis: true });
  if (!course) return notFound(res);
  const a = course.analysis;
  if (a && analysisLib.ACTIVE_STATUSES.includes(a.status) && Date.now() - a.updatedAt.getTime() > state.STUCK_MS) {
    const moved = await prisma.trainingAnalysis.updateMany({ where: { id: a.id, updatedAt: a.updatedAt, status: { in: analysisLib.ACTIVE_STATUSES } }, data: { status: 'QUEUED', queuedAt: new Date(), errorMessage: 'Resumed by an administrator.' } });
    if (moved.count) await logAudit({ organizationId: course.organizationId, actorId: req.profile.id, action: 'ai_practice.analysis_resumed', targetTable: 'TrainingCourse', targetId: course.id });
  }
  back(res, course.id, { step: 'analysis' });
});

router.post('/ai-practice/:id/analysis/approve', creators, async (req, res) => {
  const course = await loadCourse(req.profile, req.params.id, { analysis: true });
  if (!course || !course.analysis) return notFound(res);
  await approveAnalysis(req.profile, course);
  back(res, course.id, { step: 'practice' });
});

async function approveAnalysis(actor, course) {
  if (!course.analysis || course.analysis.status !== 'READY_FOR_REVIEW') return false;
  const moved = await prisma.trainingAnalysis.updateMany({ where: { id: course.analysis.id, status: 'READY_FOR_REVIEW' }, data: { status: 'APPROVED', approvedById: actor.id, approvedAt: new Date() } });
  if (moved.count) await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'training.analysis_approved', targetTable: 'TrainingCourse', targetId: course.id });
  return Boolean(moved.count);
}

// ------------------------------------------------------------------ practice builder
router.post('/ai-practice/:id/practice/build', creators, async (req, res) => {
  const actor = req.profile;
  const course = await loadCourse(actor, req.params.id, { analysis: true });
  if (!course || !course.analysis) return notFound(res);
  if (!editable(course)) return back(res, course.id, { step: 'practice', error: 'This version is in Training. Create a new version to change its practice.' });
  if (!['READY_FOR_REVIEW', 'APPROVED'].includes(course.analysis.status)) return back(res, course.id, { step: 'analysis', error: 'The analysis is not ready yet.' });
  const chosen = req.body.mode === 'custom' ? plan.readCustomPlan(req.body) : plan.recommendedPlan(course.analysis);
  if (!chosen.length) return back(res, course.id, { step: 'practice', error: 'Choose at least one kind of practice.' });
  if (await aiGate(res, actor, course.id)) return;
  await approveAnalysis(actor, course); // "Create practice" is the Admin's confirmation that the analysis is right
  const started = await tasks.startBuild({ actor, course, plan: chosen, sourceHash: course.analysis.sourceHash });
  if (!started.ok) return back(res, course.id, { step: 'practice', error: started.error });
  back(res, course.id, { step: 'practice' });
});

router.post('/ai-practice/:id/practice/retry', creators, async (req, res) => {
  const course = await loadCourse(req.profile, req.params.id);
  if (!course) return notFound(res);
  if (!editable(course)) return back(res, course.id, { step: 'practice', error: 'This version is in Training.' });
  if (await aiGate(res, req.profile, course.id)) return;
  const r = await tasks.retryBuild({ actor: req.profile, course });
  back(res, course.id, r.ok ? { step: 'practice' } : { step: 'practice', error: r.error });
});

router.post('/ai-practice/:id/practice/add', creators, async (req, res) => {
  const actor = req.profile;
  const course = await loadCourse(actor, req.params.id, { analysis: true });
  if (!course || !course.analysis || course.analysis.status !== 'APPROVED') return notFound(res);
  if (!editable(course)) return back(res, course.id, { step: 'practice', error: 'This version is in Training. Create a new version to change its practice.' });
  let type = String(req.body.type || ''); let level = req.body.level;
  if (type === 'SCENARIO') { type = 'ROLEPLAY'; level = 5; }          // a difficult scenario = an AI role-play at the highest difficulty
  if (type === 'CALL_COACHING') type = 'VOICE';                         // call coaching = the learner speaks the call and is coached on it
  if (!plan.COMPONENT_TYPES.includes(type)) return back(res, course.id, { step: 'practice', error: 'Choose what to add.' });
  if (await aiGate(res, actor, course.id)) return;
  const item = plan.describe(type, req.body.count, level);
  const started = await tasks.startBuild({ actor, course, plan: [{ ...item, add: true }], sourceHash: course.analysis.sourceHash }); // "add" always builds one more
  back(res, course.id, started.ok ? { step: 'practice' } : { step: 'practice', error: started.error });
});

async function loadComponent(req, res, { needsAnalysis = false } = {}) {
  const course = await loadCourse(req.profile, req.params.id, { analysis: true });
  if (!course) { notFound(res); return {}; }
  const component = await prisma.assessment.findFirst({ where: { id: req.params.aid, organizationId: course.organizationId, courseId: course.id, version: course.draftVersion || 1, archivedAt: null }, include: { questions: { select: { id: true } }, course: true } });
  if (!component || versions.isTargetedRetake(component)) { notFound(res); return {}; } // another course's / version's component looks like it does not exist
  if (!editable(course)) { back(res, course.id, { step: 'practice', error: 'This version is in Training. Create a new version to change its practice.' }); return {}; }
  if (needsAnalysis && (!course.analysis || course.analysis.status !== 'APPROVED')) { back(res, course.id, { step: 'analysis' }); return {}; }
  return { course, component };
}

router.post('/ai-practice/:id/components/:aid/regenerate', creators, async (req, res) => {
  const { course, component } = await loadComponent(req, res, { needsAnalysis: true });
  if (!component) return;
  if (await aiGate(res, req.profile, course.id)) return;
  // Not covered by aiGate (a rate limit, not an idempotency guard): without this, a double-click or
  // a retried request races two concurrent Gemini generations for one click and archives the
  // original twice, leaving two replacements instead of one.
  if (!claim(`assessment:${component.id}`)) return back(res, course.id, { step: 'practice', error: 'Already working on this — please wait for it to finish.' });
  try {
    const made = await tasks.generateComponent({ course, analysis: course.analysis, actor: req.profile, type: component.type, level: component.level, count: Math.max(3, component.questions.length || 6) });
    await prisma.assessment.update({ where: { id: component.id }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
    await logAudit({ organizationId: course.organizationId, actorId: req.profile.id, action: 'practice.component_regenerated', targetTable: 'Assessment', targetId: made.id, metadata: { replaced: component.id } });
  } catch (err) {
    await logAudit({ organizationId: course.organizationId, actorId: req.profile.id, action: 'practice.regenerate_failed', targetTable: 'Assessment', targetId: component.id, metadata: { error: String(err.message || err).slice(0, 200) } });
    return back(res, course.id, { step: 'practice', error: 'The AI could not rebuild this right now. Nothing was changed — try again.' });
  } finally {
    release(`assessment:${component.id}`);
  }
  back(res, course.id, { step: 'practice', notice: 'Rebuilt. Only this practice was regenerated.' });
});

router.post('/ai-practice/:id/components/:aid/harder', creators, async (req, res) => {
  const { course, component } = await loadComponent(req, res);
  if (!component) return;
  if (await aiGate(res, req.profile, course.id)) return;
  // Also closes a lost-update race: two concurrent "make harder" clicks both reading component.level
  // before either writes would otherwise both set level+1 instead of compounding to level+2.
  if (!claim(`assessment:${component.id}`)) return back(res, course.id, { step: 'practice', error: 'Already working on this — please wait for it to finish.' });
  try {
    const full = await prisma.assessment.findFirst({ where: { id: component.id }, include: { questions: { orderBy: { displayOrder: 'asc' } }, course: true } });
    await reviseWithPrompt({ assessment: full, instruction: 'Make this more difficult: add complications, a less cooperative customer or trickier edge cases, while staying strictly within the training material.' });
    await prisma.assessment.update({ where: { id: component.id }, data: { level: Math.min(5, component.level + 1) } });
  } catch (err) {
    if (err.userFacing) return back(res, course.id, { step: 'practice', error: err.message });
    return back(res, course.id, { step: 'practice', error: 'The AI could not make this harder right now. Nothing was changed — try again.' });
  } finally {
    release(`assessment:${component.id}`);
  }
  await logAudit({ organizationId: course.organizationId, actorId: req.profile.id, action: 'practice.component_made_harder', targetTable: 'Assessment', targetId: component.id });
  back(res, course.id, { step: 'practice', notice: 'Made harder.' });
});

router.post('/ai-practice/:id/components/:aid/adjust', creators, async (req, res) => {
  const { course, component } = await loadComponent(req, res);
  if (!component) return;
  const instruction = clip(req.body.instruction, 600);
  if (instruction.length < 5) return back(res, course.id, { step: 'practice', error: 'Tell the AI what to change, for example "Focus more on closing".' });
  if (await aiGate(res, req.profile, course.id)) return;
  if (!claim(`assessment:${component.id}`)) return back(res, course.id, { step: 'practice', error: 'Already working on this — please wait for it to finish.' });
  try {
    const full = await prisma.assessment.findFirst({ where: { id: component.id }, include: { questions: { orderBy: { displayOrder: 'asc' } }, course: true } });
    await reviseWithPrompt({ assessment: full, instruction });
  } catch (err) {
    if (err.userFacing) return back(res, course.id, { step: 'practice', error: err.message });
    return back(res, course.id, { step: 'practice', error: 'The AI could not apply that right now. Nothing was changed — try again.' });
  } finally {
    release(`assessment:${component.id}`);
  }
  await logAudit({ organizationId: course.organizationId, actorId: req.profile.id, action: 'assessment.revised_with_prompt', targetTable: 'Assessment', targetId: component.id, metadata: { via: 'builder' } });
  back(res, course.id, { step: 'practice', notice: 'Adjusted. Review the change.' });
});

router.post('/ai-practice/:id/components/:aid/delete', creators, async (req, res) => {
  const { course, component } = await loadComponent(req, res);
  if (!component) return;
  await prisma.assessment.update({ where: { id: component.id }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
  await logAudit({ organizationId: course.organizationId, actorId: req.profile.id, action: 'assessment.deleted', targetTable: 'Assessment', targetId: component.id, metadata: { via: 'builder' } });
  back(res, course.id, { step: 'practice', notice: 'Removed.' });
});

// ------------------------------------------------------------------ review, approve, preview
router.get('/ai-practice/:id/preview', creators, async (req, res) => {
  const course = await loadCourse(req.profile, req.params.id);
  if (!course) return notFound(res);
  const parts = (await state.loadComponents(course)).filter((c) => !versions.isTargetedRetake(c));
  const full = await prisma.assessment.findMany({ where: { id: { in: parts.map((p) => p.id) } }, include: { questions: { orderBy: { displayOrder: 'asc' } } }, orderBy: { createdAt: 'asc' } });
  // Nothing on this page writes anything: no attempt, no score, no skill evidence, and answers are not shown.
  res.render('ai-practice/preview', { title: `Preview — ${course.title}`, course, parts: full.map((a) => ({ ...a, config: safeParse(a.configJson, {}), qs: a.questions.map((q) => ({ ...q, options: safeParse(q.optionsJson, []) })) })), PLAN: plan });
});

router.post('/ai-practice/:id/approve', creators, async (req, res) => {
  const course = await loadCourse(req.profile, req.params.id);
  if (!course) return notFound(res);
  if (!editable(course)) return back(res, course.id, { step: 'review', error: 'This version is already in Training.' });
  const r = await versions.approvePackage(req.profile, course);
  back(res, course.id, r.ok ? { step: 'review', notice: 'Approved — ready to send to Training.' } : { step: 'review', error: r.error });
});

// The Training Category of this training (also settable later, e.g. for a training that predates categories).
router.post('/ai-practice/:id/category', creators, async (req, res) => {
  const course = await loadCourse(req.profile, req.params.id);
  if (!course) return notFound(res);
  const trainingCategory = trainingCategories.readCategory(req.body.trainingCategory);
  if (!trainingCategory) return back(res, course.id, { step: 'review', error: 'Choose Product, Sales or System & Workflow.' });
  if (trainingCategory !== course.trainingCategory) {
    await prisma.trainingCourse.update({ where: { id: course.id }, data: { trainingCategory } });
    await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'training.category_set', targetTable: 'TrainingCourse', targetId: course.id, metadata: { from: course.trainingCategory || null, to: trainingCategory } });
  }
  back(res, course.id, { step: 'review', notice: `Training category: ${trainingCategories.categoryLabel(trainingCategory)}.` });
});

router.post('/ai-practice/:id/approve/revoke', creators, async (req, res) => {
  const course = await loadCourse(req.profile, req.params.id);
  if (!course) return notFound(res);
  const r = await versions.revokeApproval(req.profile, course);
  back(res, course.id, r.ok ? { step: 'review', notice: 'Approval withdrawn. The practice is a draft again.' } : { step: 'review', error: r.error });
});

// ---- Supervisor Training Creation: submit for Admin approval ----
// A Supervisor (with training.create/training.revise) hands their prepared draft to an Admin —
// this is their terminal action here; only an Admin may publish (below). Reachable by an Admin too
// (harmless no-op-ish path) but the UI only ever offers it to a Supervisor working their own draft.
router.post('/ai-practice/:id/submit-for-approval', creators, async (req, res) => {
  const course = await loadCourse(req.profile, req.params.id);
  if (!course) return notFound(res);
  const r = await versions.submitForApproval(req.profile, course);
  back(res, course.id, r.ok ? { step: 'review', notice: r.alreadySubmitted ? 'Already submitted — waiting for an admin to review it.' : 'Submitted for admin approval.' } : { step: 'review', error: r.error });
});

// Admin sends a submitted draft back with a note. The Supervisor keeps the same draft to revise —
// nothing here discards their work, matching "Preserve review/submission history."
router.post('/ai-practice/:id/review/request-changes', adminOnly, async (req, res) => {
  const course = await loadCourse(req.profile, req.params.id);
  if (!course) return notFound(res);
  const r = await versions.requestChanges(req.profile, course, req.body.note);
  back(res, course.id, r.ok ? { step: 'review', notice: 'Sent back with your note.' } : { step: 'review', error: r.error });
});

// ------------------------------------------------------------------ send to Training (Admin only — see adminOnly above)
router.get('/ai-practice/:id/send', adminOnly, async (req, res) => {
  const actor = req.profile;
  const course = await loadCourse(actor, req.params.id, { analysis: true, modules: { orderBy: { displayOrder: 'asc' } } });
  if (!course) return notFound(res);
  if (course.publishedVersion >= (course.draftVersion || 1) && course.status === 'PUBLISHED') return res.redirect(`/admin/training/${course.id}`);
  const blocker = await versions.sendBlocker(course);
  const components = (await state.loadComponents(course)).filter((c) => !versions.isTargetedRetake(c));
  const insights = safeParse(course.analysis && course.analysis.insightsJson, {}) || {};
  res.render('ai-practice/send', {
    CATEGORIES: trainingCategories.CATEGORIES, suggestedCategory: course.trainingCategory || trainingCategories.suggestFromClassifications(course.analysis && course.analysis.classificationsJson),
    title: `Send to Training — ${course.title}`, course, components, blocker, roleLabel, PLAN: plan, skills: safeParse(course.analysis && course.analysis.extractedSkillsJson, []),
    suggestedRole: course.roleKey || (insights.audienceRoles && insights.audienceRoles.length === 1 ? insights.audienceRoles[0] : ''), minutes: insights.estimatedMinutes || course.durationMinutes || '',
    minPassingScore: await getSetting(actor.organizationId, 'training.minPassingScore'), error: typeof req.query.error === 'string' ? req.query.error.slice(0, 240) : null,
  });
});

router.post('/ai-practice/:id/send', adminOnly, async (req, res) => {
  const actor = req.profile;
  const course = await loadCourse(actor, req.params.id);
  if (!course) return notFound(res);
  const title = clip(req.body.title, 160) || course.title;
  const passingScore = Number(req.body.passingScore || course.passingScore);
  const scoreError = await checkPassingScore(actor.organizationId, passingScore);
  if (scoreError || !Number.isInteger(passingScore)) return res.redirect(`/ai-practice/${course.id}/send?error=${encodeURIComponent(scoreError || 'Enter a valid passing score.')}`);
  const roleKey = ['TRAVEL_AGENT', 'FLIGHT_EXPERT', 'SUPERVISOR'].includes(req.body.roleKey) ? req.body.roleKey : null;
  const minutes = req.body.durationMinutes ? Number(req.body.durationMinutes) : null;
  const trainingCategory = trainingCategories.readCategory(req.body.trainingCategory) || trainingCategories.readCategory(course.trainingCategory);
  if (!trainingCategory) return res.redirect(`/ai-practice/${course.id}/send?error=${encodeURIComponent('Choose a Training Category: Product, Sales or System & Workflow.')}`);
  const r = await versions.sendToTraining(actor, course, { trainingCategory, title, description: clip(req.body.description, 15000) || course.description, mandatory: req.body.mandatory === '1', onboardingForNewHires: req.body.onboarding === '1', passingScore, roleKey, durationMinutes: Number.isInteger(minutes) && minutes > 0 && minutes < 1000 ? minutes : null });
  if (!r.ok) return res.redirect(`/ai-practice/${course.id}/send?error=${encodeURIComponent(r.error)}`);
  res.redirect(`/ai-practice/${course.id}?step=training&notice=${encodeURIComponent(r.alreadySent ? 'Already sent to Training.' : `Sent to Training as version ${r.version}.`)}`);
});

router.post('/ai-practice/:id/new-version', creators, async (req, res) => {
  const actor = req.profile;
  if (actor.role === 'SUPERVISOR' && !(await hasCapability(actor, 'training.revise'))) return res.status(403).render('forbidden');
  const course = await loadCourse(actor, req.params.id);
  if (!course) return notFound(res);
  const r = await versions.createNewVersion(actor, course);
  back(res, course.id, r.ok ? { step: 'practice', notice: r.existing ? `Version ${r.version} is already being edited.` : `Version ${r.version} created as a copy. Version ${course.publishedVersion} stays in Training untouched.` } : { step: 'training', error: r.error });
});

router.post('/ai-practice/:id/version/discard', creators, async (req, res) => {
  const course = await loadCourse(req.profile, req.params.id);
  if (!course) return notFound(res);
  const r = await versions.discardDraftVersion(req.profile, course);
  back(res, course.id, r.ok ? { step: 'training', notice: 'The draft version was discarded.' } : { step: 'training', error: r.error });
});

// ------------------------------------------------------------------ housekeeping
router.post('/ai-practice/:id/archive', creators, async (req, res) => {
  const course = await loadCourse(req.profile, req.params.id);
  if (!course) return notFound(res);
  await versions.archiveSource(req.profile, course);
  res.redirect('/ai-practice?notice=archived');
});

router.post('/ai-practice/:id/restore', creators, async (req, res) => {
  const course = await loadCourse(req.profile, req.params.id);
  if (!course) return notFound(res);
  await versions.restoreSource(req.profile, course);
  res.redirect('/ai-practice?notice=restored');
});

router.post('/ai-practice/:id/delete', creators, async (req, res) => {
  const course = await loadCourse(req.profile, req.params.id);
  if (!course) return notFound(res);
  const policy = await versions.deletionPolicy(course);
  // An Admin may delete anything (a Supervisor their own training when all its assignments are theirs): show what it
  // affects and let them confirm (the training page does the delete).
  if (!policy.canDelete && !req.impersonation && await require('../lib/courseDeletion').mayDeleteCourse(req.profile, course)) return res.redirect(`/admin/training/${course.id}/delete`);
  if (!policy.canDelete) { // never destroy what training or skill evidence depends on: hide it instead
    await versions.archiveSource(req.profile, course);
    return res.redirect(`/ai-practice?notice=archived&error=${encodeURIComponent(`Archived instead of deleted, because ${policy.reasons.join(' and ')}.`)}`);
  }
  await removeCourse(req.profile, course);
  res.redirect('/ai-practice?notice=deleted');
});

router.post('/ai-practice/:id/duplicate', creators, async (req, res) => {
  const actor = req.profile;
  const course = await loadCourse(actor, req.params.id, { modules: true });
  if (!course) return notFound(res);
  const copy = await prisma.trainingCourse.create({ data: { organizationId: actor.organizationId, title: `${course.title} (copy)`, description: course.description, createdById: actor.id, origin: 'AI_PRACTICE', status: 'DRAFT', passingScore: course.passingScore, modules: { create: course.modules.map((m, i) => ({ title: m.title, description: m.description, contentType: m.contentType, storagePath: m.storagePath, externalUrl: m.externalUrl, durationMinutes: m.durationMinutes, required: m.required, sourceRefJson: m.sourceRefJson, displayOrder: i })) } } });
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'ai_practice.source_duplicated', targetTable: 'TrainingCourse', targetId: copy.id, metadata: { from: course.id } });
  res.redirect(`/ai-practice/${copy.id}`);
});

// Old bookmarks: Call Intelligence is no longer a separate area.
router.get('/call-intelligence', (req, res) => res.redirect('/ai-practice'));
router.get('/call-intelligence/:id', (req, res) => res.redirect(`/ai-practice/calls/${encodeURIComponent(req.params.id)}`));

module.exports = router;
