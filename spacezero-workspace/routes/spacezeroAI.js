'use strict';

// SpaceZero AI — read-only Q&A over information already inside SpaceZero. See lib/spacezeroAI.js
// for the authorization-first data flow; this route only handles the form, rate limiting and
// audit-safe error display (never a stack trace, matching the app's own error page convention).
const router = require('express').Router();
const { requireSession } = require('../lib/authMiddleware');
const { isRateLimited, recordAttempt, AI_RATE_LIMIT } = require('../lib/rateLimit');
const { answerQuestion, quickLinksFor } = require('../lib/spacezeroAI');

function render(res, { question, result, error, role }, status = 200) {
  res.status(status).render('assistant', { title: 'SpaceZero AI', question, result, error, quickLinks: quickLinksFor(role) });
}

router.get('/assistant', requireSession, (req, res) => {
  render(res, { question: '', result: null, error: null, role: req.profile.role });
});

router.post('/assistant/ask', requireSession, async (req, res) => {
  const actor = req.profile;
  const question = String(req.body.question || '').trim().slice(0, 500);
  if (!question) return render(res, { question: '', result: null, error: 'Ask a question first.', role: actor.role }, 400);

  if (await isRateLimited(`ai:${actor.id}`, AI_RATE_LIMIT)) {
    return render(res, { question, result: null, error: 'Too many questions in a short time. Please wait a few minutes and try again.', role: actor.role }, 429);
  }
  await recordAttempt(`ai:${actor.id}`, true);

  const result = await answerQuestion(actor, question);
  render(res, { question, result, error: null, role: actor.role });
});

module.exports = router;
