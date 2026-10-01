'use strict';
const router = require('express').Router();
const multer = require('multer');
const fs = require('node:fs/promises');
const { prisma } = require('../lib/prisma');
const { requireRole } = require('../lib/authMiddleware');
const { canViewProfile } = require('../lib/authz');
const { excludeOtherAdminsTestProfiles } = require('../lib/loginAsScope');
const { resolveStoragePath } = require('../lib/storage');
const { storeCallFiles } = require('../lib/sourceFiles');
const { logAudit } = require('../lib/audit');
const { signMedia, verifyMedia } = require('../lib/signedUrl');
const { recordCallEvidence } = require('../lib/callEvidence');
const { reportSchema } = require('../lib/callIntelligence');
const { isRateLimited, AI_RATE_LIMIT } = require('../lib/rateLimit');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 150 * 1024 * 1024, files: 10, fields: 8 } });
const manage = requireRole('ADMIN'); // calls live inside AI Practice, which is Admin-only
async function loadBatch(actor, id) {
  const batch = await prisma.callBatch.findFirst({ where: { id, organizationId: actor.organizationId }, include: { recordings: true, targetAgent: true } });
  if (!batch || (actor.role !== 'ADMIN' && batch.uploadedById !== actor.id)) return null;
  if (batch.targetAgentId && !await canViewProfile(actor, batch.targetAgentId)) return null;
  return batch;
}
// Uploading calls is part of the single "Upload material" screen. This URL is kept for old bookmarks.
router.get('/ai-practice/calls', manage, (req, res) => res.redirect('/ai-practice/new?kind=call'));
// SAVE ONLY: the recordings are stored privately and nothing is analyzed until the Admin starts the analysis.
router.post('/ai-practice/calls', manage, upload.array('calls', 10), async (req, res) => {
  const actor = req.profile;
  if (!req.files?.length) return res.status(400).send('Upload at least one call.');
  const stored = await storeCallFiles(req.files);
  if (stored.error) return res.status(400).send(stored.error);
  const batch = await prisma.callBatch.create({ data: { organizationId: actor.organizationId, uploadedById: actor.id, mode: 'BEST_PRACTICE', title: String(req.body.title || '').trim().slice(0, 160) || null, recordings: { create: stored.recordings } } });
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'ai_practice.source_uploaded', targetTable: 'CallBatch', targetId: batch.id, metadata: { kind: 'call', files: stored.recordings.length } });
  return res.redirect(`/ai-practice?saved=${batch.id}&notice=saved`);
});
// Start analysis: the Admin chooses the purpose and confirms authorization (customer calls are sensitive).
router.get('/ai-practice/calls/:id/analyze', manage, async (req, res) => {
  const batch = await loadBatch(req.profile, req.params.id);
  if (!batch) return res.status(404).send('Not found');
  if (batch.analysisRequestedAt) return res.redirect(`/ai-practice/calls/${batch.id}`);
  const people = await prisma.profile.findMany({ where: { organizationId: req.profile.organizationId, status: 'ACTIVE', ...excludeOtherAdminsTestProfiles(req.profile) }, orderBy: { fullName: 'asc' }, select: { id: true, fullName: true } });
  res.render('calls/analyze', { title: 'Analyze calls', batch, people, error: typeof req.query.error === 'string' ? req.query.error.slice(0, 200) : null });
});
router.post('/ai-practice/calls/:id/analyze', manage, async (req, res) => {
  const actor = req.profile;
  const batch = await loadBatch(actor, req.params.id);
  if (!batch) return res.status(404).send('Not found');
  const fail = (m) => res.redirect(`/ai-practice/calls/${batch.id}/analyze?error=${encodeURIComponent(m)}`);
  if (req.body.authorized !== 'yes') return fail('Confirm that you are authorized to process these recordings.');
  const purpose = ['AUTO', 'INDIVIDUAL', 'BEST_PRACTICE'].includes(req.body.purpose) ? req.body.purpose : 'AUTO';
  const targetAgentId = req.body.targetAgentId || null;
  if (purpose === 'INDIVIDUAL' && !targetAgentId) return fail('Choose the employee these calls are about.');
  if (targetAgentId && !(await canViewProfile(actor, targetAgentId))) return res.status(403).send('Choose an employee you manage.');
  if (await isRateLimited(`ai:${actor.id}`, AI_RATE_LIMIT)) return fail('Too many AI requests in a short time. Please wait a few minutes and try again.');
  const mode = purpose === 'INDIVIDUAL' || (purpose === 'AUTO' && targetAgentId) ? 'INDIVIDUAL_AGENT' : 'BEST_PRACTICE';
  // Idempotent: only the first request moves a saved batch into processing.
  const started = await prisma.callBatch.updateMany({ where: { id: batch.id, status: 'UPLOADED', analysisRequestedAt: null }, data: { analysisRequestedAt: new Date(), mode, purpose, targetAgentId: mode === 'INDIVIDUAL_AGENT' ? targetAgentId : null } });
  if (started.count) await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'ai_practice.analysis_started', targetTable: 'CallBatch', targetId: batch.id, metadata: { purpose, mode } });
  res.redirect(`/ai-practice/calls/${batch.id}`);
});
router.post('/ai-practice/calls/:id/rename', manage, async (req, res) => {
  const batch = await loadBatch(req.profile, req.params.id);
  if (!batch) return res.status(404).send('Not found');
  const title = String(req.body.title || '').trim().slice(0, 160);
  if (title.length >= 2) await prisma.callBatch.update({ where: { id: batch.id }, data: { title } });
  res.redirect(`/ai-practice/calls/${batch.id}`);
});
router.post('/ai-practice/calls/:id/archive', manage, async (req, res) => {
  const batch = await loadBatch(req.profile, req.params.id);
  if (!batch) return res.status(404).send('Not found');
  await prisma.callBatch.update({ where: { id: batch.id }, data: { archivedAt: new Date() } });
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'ai_practice.source_archived', targetTable: 'CallBatch', targetId: batch.id });
  res.redirect('/ai-practice?notice=archived');
});
router.get('/ai-practice/calls/:id', manage, async (req, res) => {
  const batch = await loadBatch(req.profile, req.params.id);
  if (!batch) return res.status(404).send('Not found');
  // Customer calls are highly sensitive: every time a batch is opened it is recorded, and playback links are signed for this person for a few minutes.
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'calls.viewed', targetTable: 'CallBatch', targetId: batch.id });
  const playUrl = (r) => `/ai-practice/calls/${batch.id}/recordings/${r.id}?${signMedia('call-recording', r.id, req.profile.id)}`;
  res.set('Cache-Control', 'private, no-store');
  res.render('calls/detail', { title: 'Call analysis', batch, playUrl, report: batch.aggregatedAnalysisJson ? JSON.parse(batch.aggregatedAnalysisJson) : null });
});
router.get('/ai-practice/calls/:id/recordings/:recordingId', manage, async (req, res) => {
  const batch = await loadBatch(req.profile, req.params.id);
  const recording = batch?.recordings.find(r => r.id === req.params.recordingId);
  if (!recording) return res.status(404).send('Not found');
  if (!verifyMedia('call-recording', recording.id, req.profile.id, req.query)) return res.status(403).send('This playback link has expired. Reload the page to get a new one.');
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'calls.played', targetTable: 'CallRecording', targetId: recording.id });
  res.setHeader('Cache-Control', 'private, no-store');
  res.type(recording.mimeType).sendFile(resolveStoragePath(recording.storagePath));
});
router.post('/ai-practice/calls/:id/retry', manage, async (req, res) => {
  const batch = await loadBatch(req.profile, req.params.id);
  if (!batch) return res.status(404).send('Not found');
  const stalled = ['TRANSCRIBING', 'ANALYZING', 'AGGREGATING', 'GENERATING_PRACTICE'].includes(batch.status) && Date.now() - batch.updatedAt.getTime() > 15 * 60 * 1000;
  if (batch.status !== 'FAILED' && !stalled) return res.status(409).send('Only failed or stalled processing can be retried.');
  if (await isRateLimited(`ai:${req.profile.id}`, AI_RATE_LIMIT)) return res.status(429).send('Too many AI requests in a short time. Please wait a few minutes and try again.');
  // Transcripts that already exist are kept: the pipeline skips recordings that are TRANSCRIBED and continues from there.
  await prisma.callBatch.update({ where: { id: batch.id }, data: { status: 'UPLOADED', errorMessage: null, analysisRequestedAt: batch.analysisRequestedAt || new Date() } });
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'ai_practice.analysis_retried', targetTable: 'CallBatch', targetId: batch.id });
  res.redirect(`/ai-practice/calls/${batch.id}`);
});
router.post('/ai-practice/calls/:id/approve', manage, async (req, res) => {
  const batch = await loadBatch(req.profile, req.params.id);
  if (!batch) return res.status(404).send('Not found');
  if (batch.status !== 'READY_FOR_REVIEW' || batch.generatedCourseId) return res.status(409).send('This analysis is not awaiting approval.');
  const report = reportSchema.parse(JSON.parse(batch.aggregatedAnalysisJson));
  const chosen = (Array.isArray(req.body.methods) ? req.body.methods : [req.body.methods]).filter(m => ['QUIZ','ROLEPLAY','VOICE','TECHNICAL','PROCESS_SIM','PRODUCT_KNOWLEDGE'].includes(m));
  const methods = chosen.length ? chosen : report.practices; // the AI recommendation is the default
  if (!methods.length) return res.status(400).send('Select at least one practice method.');
  const course = await prisma.$transaction(async tx => {
    const claimed = await tx.callBatch.updateMany({ where: { id: batch.id, status: 'READY_FOR_REVIEW', generatedCourseId: null }, data: { status: 'APPROVED', approvedById: req.profile.id, approvedAt: new Date() } });
    if (!claimed.count) throw new Error('Already approved.');
    const created = await tx.trainingCourse.create({ data: { organizationId: req.profile.organizationId, createdById: req.profile.id, origin: 'AI_PRACTICE', purpose: batch.purpose || null, title: String(req.body.title || report.title).slice(0, 200), description: String(req.body.summary || report.summary).slice(0, 15000), modules: { create: { title: 'Reviewed call lessons', contentType: 'NOTE', description: [String(req.body.summary || report.summary), ...report.strengths, ...report.weaknesses, ...report.moments.map(m => `${m.recordingId} @ ${m.seconds}s: ${m.observation}`)].join('\n') } }, analysis: { create: { status: 'APPROVED', approvedById: req.profile.id, approvedAt: new Date(), objectivesJson: JSON.stringify(report.objectives), extractedSkillsJson: JSON.stringify(report.skills.map(s => s.name)), criticalKnowledgeJson: JSON.stringify(report.strengths), practicalBehaviorsJson: JSON.stringify(report.objectives), commonMistakesJson: JSON.stringify(report.weaknesses), recommendedMethodsJson: JSON.stringify(methods), recommendedIntensityJson: '3', sourceReferencesJson: JSON.stringify(report.moments) } } } });
    await tx.callBatch.update({ where: { id: batch.id }, data: { generatedCourseId: created.id, generatedPracticePlanJson: JSON.stringify(methods) } });
    return created;
  });
  const evidence = await recordCallEvidence({ batch, report, approver: req.profile });
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'calls.approved', targetTable: 'CallBatch', targetId: batch.id, metadata: { evidenceWritten: evidence.written } });
  res.redirect(`/ai-practice/${course.id}?step=practice`);
});
router.post('/ai-practice/calls/:id/delete', manage, async (req, res) => {
  const batch = await loadBatch(req.profile, req.params.id);
  if (!batch) return res.status(404).send('Not found');
  const stalled = ['UPLOADED', 'TRANSCRIBING', 'ANALYZING', 'AGGREGATING', 'GENERATING_PRACTICE'].includes(batch.status) && batch.analysisRequestedAt && Date.now() - batch.updatedAt.getTime() > 15 * 60 * 1000;
  if (!stalled && (!['UPLOADED', 'FAILED', 'READY_FOR_REVIEW', 'APPROVED'].includes(batch.status) || (batch.status === 'UPLOADED' && batch.analysisRequestedAt))) return res.status(409).send('Wait for processing to finish before deleting.');
  if (batch.generatedCourseId && await prisma.trainingCourse.findUnique({ where: { id: batch.generatedCourseId }, select: { id: true } })) return res.status(409).send('Training was created from this analysis, so the recordings are kept. Archive it instead.');
  for (const recording of batch.recordings) await fs.unlink(resolveStoragePath(recording.storagePath)).catch(err => { if (err.code !== 'ENOENT') throw err; });
  await prisma.callBatch.delete({ where: { id: batch.id } });
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'calls.deleted', targetTable: 'CallBatch', targetId: batch.id });
  res.redirect('/ai-practice/calls');
});
module.exports = router;
