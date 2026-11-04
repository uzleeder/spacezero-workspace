'use strict';

// Call Practice for the trainee (lib/callPractice.js): the overview, the page where a call is heard and typed, the
// result once it is submitted, and the recording itself. Plus the read-only result an Admin, the employee's supervisor
// or the employee opens from the employee's Training tab. The answer key never reaches a trainee before they submit.
const router = require('express').Router();
const { prisma } = require('../lib/prisma');
const { requireSession } = require('../lib/authMiddleware');
const { resolveStoragePath } = require('../lib/storage');
const { advanceProgress } = require('../lib/mediaProgress');
const { signMedia, verifyMedia } = require('../lib/signedUrl');
const { logAudit } = require('../lib/audit');
const { redactText } = require('../lib/redact');
const { loadEmployeeFor } = require('../lib/employeeAccess');
const viewer = require('../lib/materialViewer');
const cp = require('../lib/callPractice');
const { scoreTranscript, markedAnswerKey, wordsOf } = require('../lib/callPracticeScore');

const PLAY_TTL_SECONDS = 4 * 3600; // a recording link works for the person it was made for, for one long sitting
const notFound = (res) => res.status(404).render('not-found', { layout: false });
const audioUrl = (callId, profileId) => `/call-practice/${callId}/audio?${signMedia('practice-call', callId, profileId, PLAY_TTL_SECONDS)}`;
const keyOf = (profileId, callId, attempt = 1) => ({ profileId_callId_attempt: { profileId, callId, attempt } });
/** The row being worked on: the call's first attempt, or - heard again (lib/callPractice.js planOf) - the next one. */
const rowFor = (profile, item) => {
  const attempt = item.again ? item.again.attempt : 1;
  return prisma.practiceCallTranscript.upsert({ where: keyOf(profile.id, item.call.id, attempt), create: { profileId: profile.id, callId: item.call.id, attempt }, update: {} });
};

/** The trainee's item for a call and what they may do with it: 'work' (hear and type it now), 'done' (see the result) or null. */
async function itemFor(profile, callId) {
  const state = await cp.stateFor(profile);
  const item = state.plan.items.find((i) => i.call.id === callId) || null;
  const working = Boolean(item && state.eligible && state.plan.open && state.plan.next === item);
  const mode = !item ? null : working && (!item.done || item.again) ? 'work' : item.done ? 'done' : null;
  return { state, item, mode };
}

/** Typing time the browser reports since its last save, never more than the time that really passed. */
function typingDelta(row, typingMs, now) {
  const seconds = Number(typingMs) / 1000;
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  const since = (now - new Date(row.draftSavedAt || row.startedAt)) / 1000;
  return Math.min(seconds, Math.max(0, since) + 2);
}

router.get('/call-practice', requireSession, async (req, res) => {
  if (req.profile.role === 'ADMIN') return res.redirect('/admin/call-practice');
  res.render('call-practice/index', { title: 'Call Practice', ...(await cp.stateFor(req.profile)), clock: cp.clock });
});

router.get('/call-practice/:id', requireSession, async (req, res) => {
  const found = await itemFor(req.profile, req.params.id);
  const { state, item } = found;
  if (!item) return notFound(res);
  const mode = req.query.result === '1' && item.done ? 'done' : found.mode; // just submitted: its result, even when it comes round again
  if (!mode) return res.redirect('/call-practice'); // not open yet (tomorrow, or an earlier call comes first)
  const call = await prisma.practiceCall.findUnique({ where: { id: item.call.id } });
  res.set('Cache-Control', 'private, no-store');
  if (mode === 'done') return renderResult(res, { call, item, plan: state.plan, playUrl: audioUrl(call.id, req.profile.id) });
  const row = item.again ? (item.again.callId ? item.again : null) : item.transcript; // heard again: a fresh page
  res.render('call-practice/workspace', {
    title: `Call ${item.number} · ${call.title}`, call, item, plan: state.plan, clock: cp.clock, minWords: cp.MIN_WORDS,
    playUrl: audioUrl(call.id, req.profile.id),
    saved: { text: row ? row.draftText : '', frontier: row ? JSON.parse(row.watchedRangesJson || '[]')[0]?.[1] || 0 : 0, position: row ? row.lastPositionSeconds : 0, listened: Boolean(row && row.listenedAt) },
    notice: typeof req.query.notice === 'string' ? req.query.notice : '',
  });
});

function renderResult(res, { call, item, plan, playUrl = null, review = null }) {
  const t = item.transcript;
  const counts = scoreTranscript(call.referenceText, t.submittedText, t.typingSeconds);
  res.render('call-practice/result', { title: `Call ${item.number} · ${call.title}`, call, item, plan, transcript: t, counts, lines: markedAnswerKey(call.referenceText, t.submittedText), clock: cp.clock, playUrl, review });
}

// The recording: only through a link made for this person and this call (see audioUrl), played inside the page.
router.get('/call-practice/:id/audio', requireSession, async (req, res) => {
  const call = await prisma.practiceCall.findFirst({ where: { id: req.params.id, organizationId: req.profile.organizationId } });
  if (!call) return notFound(res);
  if (!verifyMedia('practice-call', call.id, req.profile.id, req.query)) return res.status(403).send('This playback link has expired. Reload the page to get a new one.');
  if (viewer.refusesPageNavigation(req)) return res.status(403).send(viewer.VIEW_ONLY_PAGE);
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cache-Control', 'private, no-store');
  res.type(call.mimeType).sendFile(resolveStoragePath(call.storagePath)); // Range requests: rewinding and resuming
});

// Listening, saved while the call plays: in order, never skipped ahead (lib/mediaProgress.js advanceProgress, the same
// rule as training media); going back is free. Reaching the end is what opens Submit.
router.post('/call-practice/:id/progress', requireSession, async (req, res) => {
  const { item, mode } = await itemFor(req.profile, req.params.id);
  if (mode !== 'work') return res.status(404).json({ error: 'Not found' });
  const row = await rowFor(req.profile, item);
  try {
    const update = advanceProgress({ watchedRangesJson: row.watchedRangesJson, lastActivityAt: row.listenActivityAt, completedAt: row.listenedAt }, { position: Number(req.body.position), speed: Number(req.body.speed), action: req.body.action }, item.call.durationSeconds);
    const saved = await prisma.practiceCallTranscript.updateMany({
      where: { id: row.id, listenActivityAt: row.listenActivityAt },
      data: { watchedRangesJson: update.watchedRangesJson, lastPositionSeconds: update.lastPositionSeconds, playbackSpeed: update.playbackSpeed, listenActivityAt: update.lastActivityAt, listenedAt: update.completedAt },
    });
    if (!saved.count) return res.status(409).json({ error: 'This call is open in another tab. Reload to continue.' });
    res.json({ frontier: JSON.parse(update.watchedRangesJson)[0][1], percent: Math.floor(update.percentComplete), listened: Boolean(update.completedAt) });
  } catch (err) {
    res.status(400).json({ error: /last watched/.test(err.message) ? 'Continue from where you stopped listening.' : err.message, position: row.lastPositionSeconds });
  }
});

// The draft, saved every few seconds while the trainee types, with the typing time since the last save.
router.post('/call-practice/:id/draft', requireSession, async (req, res) => {
  const { item, mode } = await itemFor(req.profile, req.params.id);
  if (mode !== 'work') return res.status(404).json({ error: 'Not found' });
  if (typeof req.body.text !== 'string') return res.status(400).json({ error: 'Invalid draft' });
  const text = req.body.text.slice(0, cp.MAX_TEXT);
  const row = await rowFor(req.profile, item);
  const now = new Date();
  await prisma.practiceCallTranscript.update({ where: { id: row.id }, data: { draftText: redactText(text), typingSeconds: row.typingSeconds + typingDelta(row, req.body.typingMs, now), draftSavedAt: now } });
  res.json({ saved: true, words: wordsOf(text).length });
});

// Submitting: once the call was heard to the end and the transcript has a few words. Final - scored straight away.
router.post('/call-practice/:id/submit', requireSession, async (req, res) => {
  const { item, mode } = await itemFor(req.profile, req.params.id);
  const back = `/call-practice/${req.params.id}`;
  if (mode === 'done') return res.redirect(back); // a second tap changes nothing
  if (mode !== 'work') return res.redirect('/call-practice');
  const row = await rowFor(req.profile, item);
  const now = new Date();
  const text = redactText(String(req.body.text || '').slice(0, cp.MAX_TEXT));
  const typingSeconds = row.typingSeconds + typingDelta(row, req.body.typingMs, now);
  const keepDraft = () => prisma.practiceCallTranscript.update({ where: { id: row.id }, data: { draftText: text, typingSeconds, draftSavedAt: now } });
  if (!row.listenedAt) { await keepDraft(); return res.redirect(`${back}?notice=listen`); }
  if (wordsOf(text).length < cp.MIN_WORDS) { await keepDraft(); return res.redirect(`${back}?notice=short`); }
  const call = await prisma.practiceCall.findUnique({ where: { id: item.call.id }, select: { referenceText: true } });
  const s = scoreTranscript(call.referenceText, text, typingSeconds);
  const saved = await prisma.practiceCallTranscript.updateMany({
    where: { id: row.id, submittedAt: null },
    data: { draftText: text, submittedText: text, submittedAt: now, typingSeconds, wordCount: s.wordCount, accuracy: s.accuracy, wordsPerMinute: s.wordsPerMinute, draftSavedAt: now },
  });
  if (saved.count) await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'callPractice.submitted', targetTable: 'PracticeCall', targetId: item.call.id, metadata: { accuracy: s.accuracy, wordsPerMinute: s.wordsPerMinute, attempt: row.attempt } });
  res.redirect(row.attempt > 1 ? `${back}?result=1` : back); // heard again: its result, even when it comes round again
});

// One employee's result, read-only: for an Admin, their supervisor, or the employee (from the employee's Training tab).
router.get('/employees/:id/call-practice/:callId', requireSession, async (req, res) => {
  const ctx = await loadEmployeeFor(req.profile, req.params.id);
  if (!ctx) return notFound(res);
  const state = await cp.stateFor(ctx.employee);
  const item = state.plan.items.find((i) => i.call.id === req.params.callId && i.done);
  if (!item) return notFound(res);
  const call = await prisma.practiceCall.findUnique({ where: { id: item.call.id } });
  res.set('Cache-Control', 'private, no-store');
  renderResult(res, { call, item, plan: state.plan, review: { employee: ctx.employee, backHref: `/employees/${ctx.employee.id}/training` } });
});

module.exports = router;
