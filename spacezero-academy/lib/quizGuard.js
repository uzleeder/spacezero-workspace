'use strict';

// Quiz protection helpers (see views/partials/quiz-guard.ejs and public/js/protect-quiz.js).
//
// 1. WHO is guarded: everyone except Admins (who review and preview). To see the learner's view, use Login as a learner.
// 2. The question TEXT is not delivered as page text to guarded readers: it is painted by the stylesheet from an
//    attribute (.gt::before { content: attr(data-t) }). Painted text cannot be selected, copied, found, dragged or read
//    out of "Save page as", the reader view or the page with styles switched off. Screen readers still read it.
// 3. Attempts to copy, paste, print, capture or open developer tools are recorded (audit log), so they are visible.
const ALLOWED_EVENTS = new Set(['copy', 'cut', 'paste', 'print', 'capture', 'devtools', 'focus-lost', 'context-menu']);

const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function isGuarded(req) {
  const person = req.profile;
  if (!person) return false;
  return person.role !== 'ADMIN';
}

/** The view helper: gt(text) is plain escaped text for an unguarded reader, painted text for a guarded one. */
function textHelper(guarded) {
  return (text) => (guarded ? `<span class="gt" data-t="${escapeHtml(text)}"></span>` : escapeHtml(text));
}

module.exports = { ALLOWED_EVENTS, escapeHtml, isGuarded, textHelper };
