'use strict';

// Space AI (formerly SpaceZero AI): read-only Q&A over information already inside SpaceZero, as a chat with a history.
// See lib/spacezeroAI.js for the authorization-first data flow and lib/aiChats.js for the chats. This route handles the
// page, the answers (JSON for the page and the corner panel, a full page without JavaScript) and rate limiting.
const router = require('express').Router();
const { requireSession } = require('../lib/authMiddleware');
const { takeAiSlot } = require('../lib/rateLimit');
const { quickLinksFor } = require('../lib/spacezeroAI');
const { listChats, getChat, ask, deleteChat, changeChat, sharingOptions, shareChat, sharedChat, revokeShare, imageFor } = require('../lib/aiChats');
const multer = require('multer');
const { validateUpload, resolveStoragePath } = require('../lib/storage');
const { supportContacts } = require('../lib/supportContacts');

const SUGGESTIONS = {
  ADMIN: ["Who isn't fully set up?", 'Who has overdue training?', 'Who needs a retake?', "Which employees haven't acknowledged required standards?"],
  SUPERVISOR: ["Who on my team isn't fully set up?", 'Who on my team has overdue training?', 'Who needs a retake?', 'What requires my attention today?'],
  DEFAULT: ['What requires my attention today?', 'What training do I still have to finish?', 'Is my setup complete?', 'Do I need a retake?'],
};

// While an Admin views a real employee's account, the employee's private chats stay closed and nothing is saved.
const privateMode = (req) => Boolean(req.impersonation && req.impersonation.readOnly);
const wantsJson = (req) => /application\/json/.test(req.get('accept') || '');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 3, fieldSize: 4096 } }).single('image');
function imageUpload(req, res, next) {
  upload(req, res, err => {
    if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Choose an image smaller than 5 MB.' : 'Upload one PNG, JPEG or WebP image.' });
    try {
      if (req.file) {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(req.file.mimetype)) throw new Error('Unsupported image.');
        if (validateUpload('IMAGE', req.file)) throw new Error('Invalid image.');
      }
    } catch { return res.status(400).json({ error: 'Choose a valid PNG, JPEG or WebP image.' }); }
    next();
  });
}

async function renderPage(req, res, { chat = null, error = null, question = '' } = {}, status = 200) {
  const actor = req.profile;
  const hidden = privateMode(req);
  const historyPage = /^\d{1,4}$/.test(String(req.query.historyPage || '')) ? Math.max(1, Number(req.query.historyPage)) : 1;
  const archived = req.query.archived === '1' || Boolean(chat?.isArchived);
  const history = hidden ? [] : await listChats(actor, 41, (historyPage - 1) * 40, archived);
  res.status(status).render('assistant', {
    title: 'Space AI',
    chats: history.slice(0, 40), historyPage, hasMoreChats: history.length > 40,
    chat, error, question, hidden, archived,
    suggestions: SUGGESTIONS[actor.role] || SUGGESTIONS.DEFAULT,
    quickLinks: quickLinksFor(actor.role),
    contacts: supportContacts(),
  });
}

router.get('/assistant', requireSession, async (req, res) => {
  if (req.query.chat && !privateMode(req)) {
    const chat = await getChat(req.profile, req.query.chat);
    if (!chat) return res.redirect('/assistant');                 // not theirs, or deleted: start a new chat
    return renderPage(req, res, { chat });
  }
  return renderPage(req, res);
});

router.post('/assistant/ask', requireSession, imageUpload, async (req, res) => {
  const actor = req.profile;
  const question = String(req.body.question || '').trim().slice(0, 500) || (req.file ? 'Please explain this image.' : '');
  if (!question) {
    if (wantsJson(req)) return res.status(400).json({ error: 'Ask a question first.' });
    return renderPage(req, res, { error: 'Ask a question first.' }, 400);
  }
  const allowed = await takeAiSlot(actor, { learner: actor.role !== 'ADMIN' });
  const out = await ask(actor, { chatId: req.body.chatId, question, allowed, save: !privateMode(req), imageFile: req.file });
  if (out.error) {
    if (wantsJson(req)) return res.status(out.status).json({ error: out.error });
    return renderPage(req, res, { error: out.error, question }, out.status);
  }
  if (wantsJson(req)) return res.status(out.status).json({ chat: out.chat, messages: out.messages });
  const chat = out.chat ? await getChat(actor, out.chat.id) : { id: '', title: question, messages: out.messages };
  return renderPage(req, res, { chat }, out.status);
});

// The corner panel picks its conversation up again on the next page (JSON; the owner only).
router.get('/assistant/chats/:id/messages', requireSession, async (req, res) => {
  const chat = privateMode(req) ? null : await getChat(req.profile, req.params.id);
  if (!chat) return res.status(404).json({ error: 'Not found' });
  res.json({ chat: { id: chat.id, title: chat.title, isPinned: chat.isPinned, isArchived: chat.isArchived }, messages: chat.messages });
});

router.post('/assistant/chats/:id/delete', requireSession, async (req, res) => {
  if (privateMode(req) || !await deleteChat(req.profile, req.params.id)) return res.status(404).json({ error: 'Chat not found.' });
  if (wantsJson(req)) return res.json({ ok: true });
  return res.redirect('/assistant');
});

router.post(['/assistant/chats/:id/rename', '/assistant/chats/:id/pin', '/assistant/chats/:id/archive'], requireSession, async (req, res) => {
  if (privateMode(req)) return res.status(404).json({ error: 'Chat not found.' });
  try {
    const chat = await changeChat(req.profile, req.params.id, req.path.split('/').pop(), req.body.title);
    return chat ? res.json({ chat }) : res.status(404).json({ error: 'Chat not found.' });
  } catch (err) { if (err.status === 400) return res.status(400).json({ error: err.message }); throw err; }
});
router.get('/assistant/chats/:id/sharing', requireSession, async (req, res) => {
  const out = privateMode(req) ? null : await sharingOptions(req.profile, req.params.id);
  return out ? res.json(out) : res.status(404).json({ error: 'Chat not found.' });
});
router.post('/assistant/chats/:id/share', requireSession, async (req, res) => {
  if (privateMode(req)) return res.status(404).json({ error: 'Chat not found.' });
  try {
    const out = await shareChat(req.profile, req.params.id, req.body.recipientIds);
    return out ? res.json(out) : res.status(404).json({ error: 'Chat not found.' });
  } catch (err) { if (err.status === 400) return res.status(400).json({ error: err.message }); throw err; }
});
router.post('/assistant/chats/:id/shares/:shareId/revoke', requireSession, async (req, res) => {
  const out = privateMode(req) ? null : await revokeShare(req.profile, req.params.id, req.params.shareId);
  return out?.count ? res.json({ ok: true }) : res.status(404).json({ error: 'Share not found.' });
});
router.get('/assistant/shared/:token', requireSession, async (req, res) => {
  const chat = privateMode(req) ? null : await sharedChat(req.profile, req.params.token);
  if (!chat) return require('../lib/errorPages').renderErrorPage(req, res, 404, '');
  return res.render('assistant-shared', { title: 'Shared Space AI chat', chat, contacts: supportContacts() });
});
async function serveImage(req, res) {
  const item = privateMode(req) ? null : await imageFor(req.profile, req.params.id, req.params.token);
  if (!item) return res.status(404).end();
  res.type(item.imageMime).set('Cache-Control', 'private, no-store');
  res.sendFile(resolveStoragePath(item.imagePath), err => { if (err && !res.headersSent) res.status(404).end(); });
}
router.get('/assistant/images/:id', requireSession, serveImage);
router.get('/assistant/shared/:token/images/:id', requireSession, serveImage);
module.exports = router;
