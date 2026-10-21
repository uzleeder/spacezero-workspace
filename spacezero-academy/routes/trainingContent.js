'use strict';
const router = require('express').Router();
const { unlimitedUpload, withCleanup } = require('../lib/uploads');
const { prisma } = require('../lib/prisma');
const { requireSession, requireRole } = require('../lib/authMiddleware');
const { validateUpload, saveUpload, resolveStoragePath, sampleOf } = require('../lib/storage');
const { classify, EXT } = require('../lib/sourceFiles');
const EXT_KNOWN = (file) => Boolean(EXT[require('node:path').extname((file && file.originalname) || '').toLowerCase()]);
const { safeParse } = require('../lib/practiceEngine');
const { logAudit } = require('../lib/audit');
const { mediaGate, MEDIA_TYPES, DOC_TYPES, MIN_READ_MS, durationOf, advanceProgress } = require('../lib/mediaProgress');
const { probeMedia } = require('../lib/mediaProbe');
const { completionState, autoFinishForProfile } = require('../lib/trainingCompletion');
const viewer = require('../lib/materialViewer');
const upload = unlimitedUpload(); // any size: streamed to disk (lib/uploads.js)

async function allowedCourse(actor, id) {
  return prisma.trainingCourse.findFirst({ where: {
    id, organizationId: actor.organizationId, archivedAt: null,
    ...(actor.role === 'ADMIN' ? {} : { OR: [
      ...(actor.role === 'SUPERVISOR' ? [{ createdById: actor.id }] : []),
      { status: 'PUBLISHED', assignments: { some: { organizationId: actor.organizationId, recipients: { some: { profileId: actor.id } } } } },
    ] }),
  }, include: { modules: { orderBy: { displayOrder: 'asc' } } } });
}

/** A learner opening read-material starts its clock; the server later checks they really spent time with it. */
async function noteOpened(profile, module) {
  if (profile.role === 'ADMIN' || !DOC_TYPES.includes(module.contentType) || require('../lib/requestContext').readOnly()) return; // an Admin looking at the account records nothing
  const mine = await prisma.trainingAssignmentRecipient.findFirst({ where: { profileId: profile.id, assignment: { courseId: module.courseId } }, select: { id: true } });
  if (!mine) return; // previewing (a supervisor who owns the course) records nothing
  await prisma.mediaProgress.upsert({ where: { profileId_trainingModuleId: { profileId: profile.id, trainingModuleId: module.id } }, create: { profileId: profile.id, trainingModuleId: module.id }, update: {} });
}

// External reference links open through here so the server knows the learner really opened them.
router.get('/training-link/:moduleId', requireSession, async (req, res) => {
  const module = await prisma.trainingModule.findUnique({ where: { id: req.params.moduleId } });
  if (!module || module.contentType !== 'LINK' || !/^https?:\/\//i.test(module.externalUrl || '') || !await allowedCourse(req.profile, module.courseId)) return res.status(404).send('Not found');
  await noteOpened(req.profile, module);
  res.redirect(module.externalUrl);
});

// "I have read / finished this": accepted only for material the learner opened, after a minimum time with it.
router.post('/training-material/:moduleId/acknowledge', requireSession, async (req, res) => {
  const module = await prisma.trainingModule.findUnique({ where: { id: req.params.moduleId } });
  const course = module ? await allowedCourse(req.profile, module.courseId) : null;
  if (!module || !course || !DOC_TYPES.includes(module.contentType)) return res.status(404).send('Not found');
  const mine = await prisma.trainingAssignmentRecipient.findFirst({ where: { profileId: req.profile.id, assignment: { courseId: course.id } }, select: { id: true } });
  if (!mine) return res.status(404).send('Not found');
  const back = `/training-course/${course.id}`;
  const row = await prisma.mediaProgress.findUnique({ where: { profileId_trainingModuleId: { profileId: req.profile.id, trainingModuleId: module.id } } });
  if (!row) return res.redirect(`${back}?material=open-first`);              // it was never opened
  if (Date.now() - row.startedAt.getTime() < MIN_READ_MS) return res.redirect(`${back}?material=too-fast`); // and not skimmed in a second
  if (!row.completedAt) await prisma.mediaProgress.update({ where: { id: row.id }, data: { completedAt: new Date(), percentComplete: 100, lastActivityAt: new Date() } });
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'training.material_completed', targetTable: 'TrainingModule', targetId: module.id });
  await autoFinishForProfile(req.profile.id, { assignment: { courseId: course.id } }).catch((err) => console.error('auto-finish failed', err.message)); // it may have been the last thing left
  res.redirect(back);
});

// Reading progress of a document, sent by the reading page while the learner reads (percent of the file scrolled through).
// The bar can only go up. The item is finished when the END has been reached AND the learner has had a fair amount of
// time with it (a minimum, longer for longer files): reaching the bottom in a second does not finish it.
router.post('/training-material/:moduleId/progress', requireSession, async (req, res) => {
  const module = await prisma.trainingModule.findUnique({ where: { id: req.params.moduleId } });
  const course = module ? await allowedCourse(req.profile, module.courseId) : null;
  if (!module || !course || !DOC_TYPES.includes(module.contentType)) return res.status(404).json({ error: 'Not found' });
  const mine = req.profile.role === 'ADMIN' ? null : await prisma.trainingAssignmentRecipient.findFirst({ where: { profileId: req.profile.id, assignment: { courseId: course.id } }, select: { id: true } });
  if (!mine) return res.json({ preview: true, percent: 0, completed: false }); // an Admin / the creator previewing records nothing
  const sent = Number(req.body.percent);
  if (!Number.isFinite(sent)) return res.status(400).json({ error: 'Invalid progress' });
  const percent = Math.max(0, Math.min(100, sent));
  const pages = Math.max(1, Math.min(300, Math.round(Number(req.body.pages) || 1)));
  const key = { profileId_trainingModuleId: { profileId: req.profile.id, trainingModuleId: module.id } };
  const row = await prisma.mediaProgress.upsert({ where: key, create: { profileId: req.profile.id, trainingModuleId: module.id }, update: {} });
  const now = Date.now();
  const reached = Math.max(row.percentComplete, percent);
  const requiredMs = Math.max(MIN_READ_MS, pages * 3000);
  const waitMs = Math.max(0, requiredMs - (now - row.startedAt.getTime()));
  const finishing = !row.completedAt && reached >= 99 && waitMs === 0;
  const data = { percentComplete: finishing ? 100 : Math.min(reached, 99.5), lastActivityAt: new Date(now) };
  if (row.completedAt) data.percentComplete = 100;
  if (finishing) data.completedAt = new Date(now);
  await prisma.mediaProgress.update({ where: { id: row.id }, data });
  if (finishing) {
    await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'training.material_completed', targetTable: 'TrainingModule', targetId: module.id });
    await autoFinishForProfile(req.profile.id, { assignment: { courseId: course.id } }).catch((err) => console.error('auto-finish failed', err.message)); // it may have been the last thing left
  }
  const completed = Boolean(row.completedAt || finishing);
  res.json({ percent: data.percentComplete, completed, waitMs: reached >= 99 && !row.completedAt && !finishing ? waitMs : 0, ...(completed ? { next: await nextStep(req.profile, course, module) } : {}) });
});

/** Where the learner goes once a document is finished: the practice and quizzes when everything required is done, else the next item still to do. */
async function nextStep(profile, course, module) {
  const back = `/training-course/${course.id}`;
  if (profile.role === 'ADMIN') return { url: course.origin === 'AI_PRACTICE' && course.status !== 'PUBLISHED' ? `/ai-practice/${course.id}` : back, label: 'Back →', unlocked: false, message: '' };
  const gate = await mediaGate(profile.id, course.id);
  if (gate.unlocked) {
    const quizzes = await prisma.assessment.count({ where: { courseId: course.id, status: 'APPROVED' } });
    return quizzes
      ? { url: `${back}#practice`, label: 'Open the practice and quizzes →', unlocked: true, message: 'All required material is finished - the practice and quizzes are now open.' }
      : { url: back, label: 'Back to the training →', unlocked: true, message: 'All required material is finished.' };
  }
  const left = gate.modules.filter((m) => m.id !== module.id && !gate.finished(m));
  const next = left.find((m) => m.storagePath && DOC_TYPES.includes(m.contentType)) || left[0];
  if (!next) return { url: back, label: 'Back to the training →', unlocked: false, message: '' };
  const readable = next.storagePath && DOC_TYPES.includes(next.contentType);
  return { url: readable ? `/training-read/${next.id}` : `${back}#m-${next.id}`, label: `Next: ${next.title} →`, unlocked: false, message: `${left.length} required item${left.length === 1 ? '' : 's'} left before the practice and quizzes open.` };
}

// The reading page for one document: the file as it was uploaded (PDF pages, the Word document, the slides, the picture),
// shown inside the app, with a line at the bottom that fills as the learner reads and finishes the item at the end.
// View-only for everyone but Admins.
router.get('/training-read/:moduleId', requireSession, async (req, res) => {
  const module = await prisma.trainingModule.findUnique({ where: { id: req.params.moduleId } });
  const course = module ? await allowedCourse(req.profile, module.courseId) : null;
  if (!module || !course || !module.storagePath || MEDIA_TYPES.includes(module.contentType)) return res.status(404).send('Not found');
  await noteOpened(req.profile, module); // opening a document starts its clock
  const kind = viewer.readerKind({ type: module.contentType, storagePath: module.storagePath });
  const { html = null, slides = null } = await viewer.readerContent(kind, module.storagePath);
  const readable = ['pdf', 'image', 'font', 'html'].includes(kind) ? true : kind === 'slides' ? slides : html;
  const progress = await prisma.mediaProgress.findUnique({ where: { profileId_trainingModuleId: { profileId: req.profile.id, trainingModuleId: module.id } } });
  res.set('Cache-Control', 'private, no-store');
  const finished = Boolean(progress && progress.completedAt);
  res.render('training-read', {
    title: module.title, module, course, kind: readable ? kind : 'unsupported', html, slides, protect: req.profile.role !== 'ADMIN',
    next: finished ? await nextStep(req.profile, course, module) : { url: `/training-course/${course.id}`, label: 'Back to the training →', unlocked: false, message: '' },
    tracked: req.profile.role !== 'ADMIN' && !require('../lib/requestContext').readOnly() && Boolean(await prisma.trainingAssignmentRecipient.findFirst({ where: { profileId: req.profile.id, assignment: { courseId: course.id } }, select: { id: true } })),
    saved: { percent: progress ? Math.round(progress.percentComplete) : 0, done: Boolean(progress && progress.completedAt) },
  });
});
router.get('/training-course/:id', requireSession, async (req, res) => {
  const course = await allowedCourse(req.profile, req.params.id);
  if (!course) return res.status(404).send('Not found');
  if (!require('../lib/requestContext').readOnly()) await autoFinishForProfile(req.profile.id, { assignment: { courseId: course.id } }).catch((err) => console.error('auto-finish failed', err.message)); // already done = finished
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'training.content_read', targetTable: 'TrainingCourse', targetId: course.id });
  // Each learner sees the version they were assigned; the Admin sees the version that is in Training.
  const mine = req.profile.role === 'ADMIN' ? [] : await prisma.trainingAssignment.findMany({ where: { courseId: course.id, recipients: { some: { profileId: req.profile.id } } }, select: { courseVersion: true, assessmentId: true } });
  const versions = mine.length ? mine.map((m) => m.courseVersion) : [Math.max(1, course.publishedVersion || 0)];
  const assessments = await prisma.assessment.findMany({ where: { courseId: course.id, status: 'APPROVED', OR: [{ version: { in: versions } }, { configJson: { contains: 'targetedRetake' } }] }, orderBy: { createdAt: 'asc' } });
  const gate = await mediaGate(req.profile.id, course.id, versions[0]);
  const shownModules = require('../lib/courseVersions').modulesFor(course.modules, versions[0]);
  // Text notes are read on this very page: opening the page starts their clock.
  if (req.profile.role !== 'ADMIN') for (const m of shownModules) if (m.contentType === 'NOTE') await noteOpened(req.profile, m);
  const isLearner = Boolean(await prisma.trainingAssignmentRecipient.findFirst({ where: { profileId: req.profile.id, assignment: { courseId: course.id } }, select: { id: true } }));
  const progressRows = isLearner ? await prisma.mediaProgress.findMany({ where: { profileId: req.profile.id, trainingModuleId: { in: shownModules.map((m) => m.id) } } }) : [];
  const doneIds = new Set(progressRows.filter((p) => p.completedAt).map((p) => p.trainingModuleId));
  const requiredIds = new Set(gate.modules.map((m) => m.id));
  // Training without practice is finished from the training page itself (the list only ever says Start).
  const mineRecipient = req.profile.role === 'ADMIN' ? null : await prisma.trainingAssignmentRecipient.findFirst({ where: { profileId: req.profile.id, assignment: { courseId: course.id } }, orderBy: { createdAt: 'desc' }, include: { assignment: true, attempts: true } });
  // Where the learner stands on submitting this training: every practice/quiz passed -> "Submit training".
  const completion = mineRecipient ? await completionState(mineRecipient) : null;
  const canFinish = Boolean(gate.unlocked && completion && !completion.submitted && completion.total === 0);
  const canSubmit = Boolean(gate.unlocked && completion && !completion.submitted && completion.total > 0 && completion.passedAll);
  const passedIds = new Set(completion ? completion.rows.filter((r) => r.passed).map((r) => r.assessment.id) : []);
  res.render('training-content', { nounFor: require('../lib/fileTypes').nounFor, readerKind: viewer.readerKind, title: course.title, canFinish, canSubmit, completion, passedIds, finishId: mineRecipient ? mineRecipient.id : null, isLearner, doneIds, requiredIds, DOC_TYPES, minReadSeconds: Math.round(MIN_READ_MS / 1000), material: typeof req.query.material === 'string' ? req.query.material : '', course: { ...course, modules: shownModules }, gate, assessments: assessments.filter((a) => {
    if (safeParse(a.configJson, {})?.targetedRetake === true) return a.createdById === req.profile.id;
    // Only practice the learner can really open: the same rule the practice page applies (an assignment of this version, for
    // the whole training or for exactly this practice) - otherwise \"Start\" would lead to a page that is not found.
    return !isLearner || mine.some((m) => m.courseVersion === a.version && (!m.assessmentId || m.assessmentId === a.id));
  }) });
});

// Training sources belong to AI Practice, which is Admin-only.
router.post('/admin/training/:id/modules/:moduleId/file', requireRole('ADMIN'), withCleanup(upload.single('file')), async (req, res) => {
  const course = await allowedCourse(req.profile, req.params.id);
  if (!course) return res.status(404).send('Not found');
  if (course.publishedVersion) return res.status(409).send('This training was sent to Training. Change its material by creating a new version in AI Practice.');
  const module = course.modules.find(m => m.id === req.params.moduleId);
  if (!module) return res.status(404).send('Not found');
  // a file of one of the newer kinds (spreadsheet, e-book, font, CAD, text ...) is checked from its real content and keeps its extension
  const kind = req.file ? classify(req.file) : { error: 'Choose a file.' };
  if (kind.error && !kind.extra && !EXT_KNOWN(req.file)) return res.status(400).send(kind.error);
  const error = kind.extra
    ? (kind.contentType !== module.contentType ? `This item is a ${module.contentType.toLowerCase()} item: upload a file of the same kind.` : require('../lib/fileTypes').validateContent(kind.extra, req.file, sampleOf(req.file)))
    : validateUpload(module.contentType, req.file);
  if (error) return res.status(400).send(error);
  const saved = await saveUpload(req.file, 'training', kind.extra ? { ext: kind.extra.ext } : {});
  let durationSeconds;
  if (MEDIA_TYPES.includes(module.contentType)) {
    try { durationSeconds = await probeMedia(saved.storagePath); } catch { return res.status(400).send('Cannot read media duration. Please upload a valid recording.'); }
  }
  await prisma.$transaction(async tx => {
    await tx.trainingModule.update({ where: { id: module.id }, data: { storagePath: saved.storagePath, externalUrl: null, ...(durationSeconds ? { sourceRefJson: JSON.stringify({ durationSeconds }) } : {}) } });
    await tx.mediaProgress.deleteMany({ where: { trainingModuleId: module.id } });
  });
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'training.file_uploaded', targetTable: 'TrainingModule', targetId: module.id });
  res.redirect(`/admin/training/${course.id}`);
});

router.get('/training-file/:id', requireSession, async (req, res) => {
  const module = await prisma.trainingModule.findUnique({ where: { id: req.params.id } });
  if (!module?.storagePath || !await allowedCourse(req.profile, module.courseId)) return res.status(404).send('Not found');
  if (req.query.download === '1' && req.profile.role !== 'ADMIN') return res.status(403).send('Forbidden');
  // View only: a non-Admin cannot open the raw file as a page of its own (that is where save / download buttons live);
  // the video / audio / PDF viewer inside the training page is what they use.
  if (viewer.refusesPageNavigation(req)) return res.status(403).send(viewer.VIEW_ONLY_PAGE);
  await noteOpened(req.profile, module); // reading a document starts its clock
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'training.file_read', targetTable: 'TrainingModule', targetId: module.id });
  res.setHeader('Content-Disposition', req.query.download === '1' ? 'attachment' : 'inline');
  res.setHeader('Cache-Control', 'private, no-store');
  // SVG and HTML files could run code if opened as a page: nothing in them may execute, load or submit anything.
  // The reading page frames an HTML file so it looks as it was written; the frame may be measured by the page around it
  // (allow-same-origin) but still runs no script, submits no form and loads nothing from outside.
  if (/\.html?$/i.test(module.storagePath) && req.query.frame === '1') res.setHeader('Content-Security-Policy', "sandbox allow-same-origin; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; frame-ancestors 'self'");
  else if (/\.(svg|html?)$/i.test(module.storagePath)) res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'");
  res.sendFile(resolveStoragePath(module.storagePath));
});
router.post('/training-media/:id/progress', requireSession, async (req, res) => {
  const module = await prisma.trainingModule.findUnique({ where: { id: req.params.id } });
  if (!module || !MEDIA_TYPES.includes(module.contentType) || !await allowedCourse(req.profile, module.courseId)) return res.status(404).json({ error: 'Not found' });
  let duration = durationOf(module);
  if (!duration && module.storagePath) {
    try { duration = await probeMedia(module.storagePath); await prisma.trainingModule.update({ where: { id: module.id }, data: { sourceRefJson: JSON.stringify({ durationSeconds: duration }) } }); }
    catch { return res.status(422).json({ error: 'This recording cannot be read. Ask the training creator to replace it.' }); }
  }
  if (!duration) return res.status(422).json({ error: 'Upload a valid recording first.' });
  const row = await prisma.mediaProgress.upsert({ where: { profileId_trainingModuleId: { profileId: req.profile.id, trainingModuleId: module.id } }, create: { profileId: req.profile.id, trainingModuleId: module.id, durationSeconds: Math.ceil(duration) }, update: {} });
  try {
    const update = advanceProgress(row, { position: Number(req.body.position), speed: Number(req.body.speed), action: req.body.action }, duration);
    const saved = await prisma.mediaProgress.updateMany({ where: { id: row.id, lastActivityAt: row.lastActivityAt }, data: update });
    if (!saved.count) return res.status(409).json({ error: 'Progress changed in another tab. Refresh to continue.' });
    if (update.completedAt) await autoFinishForProfile(req.profile.id, { assignment: { courseId: module.courseId } }).catch((err) => console.error('auto-finish failed', err.message)); // it may have been the last thing left
    res.json({ ...update, duration, unlocked: (await mediaGate(req.profile.id, module.courseId)).unlocked });
  } catch (err) { res.status(400).json({ error: err.message, position: row.lastPositionSeconds }); }
});
router.post('/admin/training/:id/modules/:moduleId/required', requireRole('ADMIN'), async (req, res) => {
  const course = await allowedCourse(req.profile, req.params.id);
  if (!course || (req.profile.role !== 'ADMIN' && course.createdById !== req.profile.id) || !course.modules.some(m => m.id === req.params.moduleId)) return res.status(404).send('Not found');
  if (course.publishedVersion) return res.status(409).send('This training was sent to Training. Change its material by creating a new version in AI Practice.');
  await prisma.trainingModule.update({ where: { id: req.params.moduleId }, data: { required: req.body.required === 'true' } });
  res.redirect(`/admin/training/${course.id}`);
});
module.exports = router;
