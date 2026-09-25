'use strict';
const router = require('express').Router();
const multer = require('multer');
const { prisma } = require('../lib/prisma');
const { requireSession, requireRole } = require('../lib/authMiddleware');
const { validateUpload, saveUpload, resolveStoragePath } = require('../lib/storage');
const { safeParse } = require('../lib/practiceEngine');
const { logAudit } = require('../lib/audit');
const { mediaGate, MEDIA_TYPES, DOC_TYPES, MIN_READ_MS, durationOf, advanceProgress } = require('../lib/mediaProgress');
const { probeMedia } = require('../lib/mediaProbe');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 300 * 1024 * 1024, files: 1, fields: 10 } });

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
  if (profile.role === 'ADMIN' || !DOC_TYPES.includes(module.contentType)) return;
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
  res.redirect(back);
});

router.get('/training-course/:id', requireSession, async (req, res) => {
  const course = await allowedCourse(req.profile, req.params.id);
  if (!course) return res.status(404).send('Not found');
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'training.content_read', targetTable: 'TrainingCourse', targetId: course.id });
  // Each learner sees the version they were assigned; the Admin sees the version that is in Training.
  const mine = req.profile.role === 'ADMIN' ? [] : await prisma.trainingAssignment.findMany({ where: { courseId: course.id, recipients: { some: { profileId: req.profile.id } } }, select: { courseVersion: true } });
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
  const mineRecipient = req.profile.role === 'ADMIN' ? null : await prisma.trainingAssignmentRecipient.findFirst({ where: { profileId: req.profile.id, assignment: { courseId: course.id } }, orderBy: { createdAt: 'desc' }, include: { attempts: { orderBy: { attemptNumber: 'desc' }, take: 1 } } });
  const canFinish = Boolean(gate.unlocked && mineRecipient && mineRecipient.attempts[0] && mineRecipient.attempts[0].status === 'IN_PROGRESS' && !assessments.filter((a) => safeParse(a.configJson, {})?.targetedRetake !== true).length);
  res.render('training-content', { title: course.title, canFinish, finishId: mineRecipient ? mineRecipient.id : null, isLearner, doneIds, requiredIds, DOC_TYPES, minReadSeconds: Math.round(MIN_READ_MS / 1000), material: typeof req.query.material === 'string' ? req.query.material : '', course: { ...course, modules: shownModules }, gate, assessments: assessments.filter(a => safeParse(a.configJson, {})?.targetedRetake !== true || a.createdById === req.profile.id) });
});

// Training sources belong to AI Practice, which is Admin-only.
router.post('/admin/training/:id/modules/:moduleId/file', requireRole('ADMIN'), upload.single('file'), async (req, res) => {
  const course = await allowedCourse(req.profile, req.params.id);
  if (!course) return res.status(404).send('Not found');
  if (course.publishedVersion) return res.status(409).send('This training was sent to Training. Change its material by creating a new version in AI Practice.');
  const module = course.modules.find(m => m.id === req.params.moduleId);
  if (!module) return res.status(404).send('Not found');
  const error = validateUpload(module.contentType, req.file);
  if (error) return res.status(400).send(error);
  const saved = await saveUpload(req.file, 'training');
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
  await noteOpened(req.profile, module); // reading a document starts its clock
  if (req.query.download === '1' && req.profile.role !== 'ADMIN') return res.status(403).send('Forbidden');
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'training.file_read', targetTable: 'TrainingModule', targetId: module.id });
  res.setHeader('Content-Disposition', req.query.download === '1' ? 'attachment' : 'inline');
  res.setHeader('Cache-Control', 'private, no-store');
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
