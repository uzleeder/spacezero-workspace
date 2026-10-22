'use strict';

// Manage Training -> Call Practice (Admin): the real client calls new agents listen to and type out (lib/callPractice.js).
// Upload several at once - each becomes the next call in the list - put them in order, correct an answer key, remove a
// call, and set how many calls a day a trainee may do. The AI makes each upload's answer key in the background; a call
// is offered to trainees once its answer key is ready. Removing a call someone already did only hides it from new
// trainees: their results stay.
const router = require('express').Router();
const fsp = require('node:fs/promises');
const path = require('node:path');
const { prisma } = require('../../lib/prisma');
const { requireRole } = require('../../lib/authMiddleware');
const { unlimitedUpload, withCleanup } = require('../../lib/uploads');
const { validateUpload, saveUpload, resolveStoragePath } = require('../../lib/storage');
const mediaProbe = require('../../lib/mediaProbe');
const { getSetting, setSetting, isValidSetting } = require('../../lib/orgSettings');
const { signMedia } = require('../../lib/signedUrl');
const { logAudit } = require('../../lib/audit');
const cp = require('../../lib/callPractice');
const { wordsOf } = require('../../lib/callPracticeScore');

const adminOnly = requireRole('ADMIN');
const upload = unlimitedUpload(); // any size: streamed to disk (lib/uploads.js)
const notFound = (res) => res.status(404).render('not-found', { layout: false });
const ORDER = [{ displayOrder: 'asc' }, { createdAt: 'asc' }];
const titleFrom = (filename) => (path.parse(String(filename || '')).name.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim() || 'Call').slice(0, 120);
const findCall = (actor, id) => prisma.practiceCall.findFirst({ where: { id, organizationId: actor.organizationId, archivedAt: null } });
const audit = (req, action, targetId, metadata) => logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action, targetTable: 'PracticeCall', targetId, metadata });

/** How many people are in Call Practice right now. */
async function traineeCount(organizationId, window) {
  const people = await prisma.profile.findMany({ where: { organizationId, role: { in: cp.ROLES }, status: 'ACTIVE', archivedAt: null, testOwnerAdminId: null }, select: { role: true, status: true, employmentStartDate: true } });
  return people.filter((p) => cp.isEligible(p, window)).length;
}

router.get('/call-practice', adminOnly, async (req, res) => {
  const org = req.profile.organizationId;
  const [calls, perDay, window] = await Promise.all([
    prisma.practiceCall.findMany({ where: { organizationId: org, archivedAt: null }, orderBy: ORDER, include: { _count: { select: { transcripts: { where: { submittedAt: { not: null } } } } } } }),
    getSetting(org, 'callPractice.callsPerDay'),
    cp.windowFor(org),
  ]);
  const num = (v) => (Number.isInteger(Number(v)) ? Number(v) : 0);
  res.render('admin/call-practice/index', {
    title: 'Call Practice', calls, perDay, window, trainees: await traineeCount(org, window), clock: cp.clock,
    notice: { added: num(req.query.added), skipped: num(req.query.skipped), none: req.query.none === '1', saved: req.query.saved === '1', removed: req.query.removed || '' },
  });
});

router.post('/call-practice/settings', adminOnly, async (req, res) => {
  const perDay = Number(req.body.callsPerDay);
  if (!isValidSetting('callPractice.callsPerDay', perDay)) return res.status(400).send('Choose between 1 and 5 calls a day.');
  await setSetting(req.profile.organizationId, 'callPractice.callsPerDay', perDay, req.profile.id);
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'callPractice.settings_changed', targetTable: 'OrgSetting', metadata: { callsPerDay: perDay } });
  res.redirect('/admin/call-practice?saved=1');
});

// Several recordings at once; each becomes the next call in the list, titled after its file (the title can be changed).
router.post('/call-practice/upload', adminOnly, withCleanup(upload.array('files')), async (req, res) => {
  const org = req.profile.organizationId;
  const files = req.files || [];
  if (!files.length) return res.redirect('/admin/call-practice?none=1');
  let order = (await prisma.practiceCall.aggregate({ where: { organizationId: org, archivedAt: null }, _max: { displayOrder: true } }))._max.displayOrder || 0;
  let added = 0; let skipped = 0;
  for (const file of files) {
    if (validateUpload('CALL_RECORDING', file)) { skipped += 1; continue; }
    const saved = await saveUpload(file, 'call-practice');
    let durationSeconds;
    try { durationSeconds = await mediaProbe.probeMedia(saved.storagePath); } catch {
      await fsp.unlink(resolveStoragePath(saved.storagePath)).catch(() => undefined);
      skipped += 1; continue;
    }
    order += 1;
    const call = await prisma.practiceCall.create({ data: { organizationId: org, title: titleFrom(file.originalname), storagePath: saved.storagePath, mimeType: saved.mimeType, durationSeconds, displayOrder: order, createdById: req.profile.id } });
    await audit(req, 'callPractice.uploaded', call.id, { durationSeconds: Math.round(durationSeconds) });
    added += 1;
  }
  res.redirect(`/admin/call-practice?added=${added}&skipped=${skipped}`);
});

router.get('/call-practice/:id', adminOnly, async (req, res) => {
  const call = await findCall(req.profile, req.params.id);
  if (!call) return notFound(res);
  const done = await prisma.practiceCallTranscript.findMany({ where: { callId: call.id, submittedAt: { not: null } }, select: { accuracy: true } });
  const scored = done.filter((d) => d.accuracy != null);
  res.set('Cache-Control', 'private, no-store');
  res.render('admin/call-practice/detail', {
    title: call.title, call, clock: cp.clock, minWords: cp.MIN_WORDS,
    stats: { done: done.length, averageAccuracy: scored.length ? Math.round(scored.reduce((s, d) => s + d.accuracy, 0) / scored.length) : null },
    playUrl: `/call-practice/${call.id}/audio?${signMedia('practice-call', call.id, req.profile.id, 4 * 3600)}`,
    saved: req.query.saved === '1', error: typeof req.query.error === 'string' ? req.query.error : '',
  });
});

// Title, note and the answer key. A changed answer key scores everyone who already did the call again.
router.post('/call-practice/:id', adminOnly, async (req, res) => {
  const call = await findCall(req.profile, req.params.id);
  if (!call) return notFound(res);
  const back = `/admin/call-practice/${call.id}`;
  const title = String(req.body.title || '').trim().slice(0, 120);
  if (!title) return res.redirect(`${back}?error=title`);
  const data = { title, note: String(req.body.note || '').trim().slice(0, 300) || null };
  let keyChanged = false;
  if (typeof req.body.referenceText === 'string') {
    const key = req.body.referenceText.replace(/\r\n/g, '\n').trim().slice(0, cp.MAX_TEXT);
    if (key !== (call.referenceText || '').trim()) {
      if (wordsOf(key).length < cp.MIN_WORDS) return res.redirect(`${back}?error=key`);
      Object.assign(data, { referenceText: key, referenceStatus: 'READY', referenceError: null });
      keyChanged = true;
    }
  }
  await prisma.practiceCall.update({ where: { id: call.id }, data });
  const rescored = keyChanged ? await cp.rescore(call.id) : 0;
  await audit(req, keyChanged ? 'callPractice.answer_key_changed' : 'callPractice.updated', call.id, keyChanged ? { rescored } : undefined);
  res.redirect(`${back}?saved=1`);
});

// Ask the AI for the answer key again after it failed. (A ready one is corrected by hand: asking again would take the
// call away from trainees until the new one is written.)
router.post('/call-practice/:id/answer-key', adminOnly, async (req, res) => {
  const call = await findCall(req.profile, req.params.id);
  if (!call) return notFound(res);
  await prisma.practiceCall.updateMany({ where: { id: call.id, referenceStatus: 'FAILED' }, data: { referenceStatus: 'PENDING', referenceError: null } });
  await audit(req, 'callPractice.answer_key_requested', call.id);
  res.redirect(`/admin/call-practice/${call.id}`);
});

// One place up or down in the list everyone follows.
router.post('/call-practice/:id/move', adminOnly, async (req, res) => {
  const calls = await prisma.practiceCall.findMany({ where: { organizationId: req.profile.organizationId, archivedAt: null }, orderBy: ORDER, select: { id: true } });
  const i = calls.findIndex((c) => c.id === req.params.id);
  if (i < 0) return notFound(res);
  const j = req.body.direction === 'up' ? i - 1 : i + 1;
  if (j >= 0 && j < calls.length) {
    [calls[i], calls[j]] = [calls[j], calls[i]];
    await prisma.$transaction(calls.map((c, k) => prisma.practiceCall.update({ where: { id: c.id }, data: { displayOrder: k + 1 } })));
  }
  res.redirect(`/admin/call-practice#call-${req.params.id}`);
});

// A call nobody did yet is deleted with its recording; one somebody did is only taken out of the list (results stay).
router.post('/call-practice/:id/remove', adminOnly, async (req, res) => {
  const call = await findCall(req.profile, req.params.id);
  if (!call) return notFound(res);
  const done = await prisma.practiceCallTranscript.count({ where: { callId: call.id, submittedAt: { not: null } } });
  if (done) {
    await prisma.practiceCall.update({ where: { id: call.id }, data: { archivedAt: new Date() } });
  } else {
    await prisma.practiceCall.delete({ where: { id: call.id } });
    await fsp.unlink(resolveStoragePath(call.storagePath)).catch((err) => { if (err.code !== 'ENOENT') console.error('[callPractice] could not delete recording', err.message); });
  }
  await audit(req, done ? 'callPractice.archived' : 'callPractice.deleted', call.id, { title: call.title });
  res.redirect(`/admin/call-practice?removed=${done ? 'archived' : 'deleted'}`);
});

module.exports = router;
