'use strict';

// Best-effort redaction of likely-sensitive information from transcripts/notes before they
// are sent to Gemini. This is NOT a compliance-grade PII scrubber — it reduces obvious
// exposure (emails, card-like digit runs, phone-like digit runs, passport-like alphanumeric
// IDs) but does not guarantee complete removal of sensitive information. Order matters:
// narrower/more-specific patterns run first so a later broad digit pattern doesn't re-match
// text a specific one already replaced.
const PATTERNS = [
  { name: 'email', re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[REDACTED-EMAIL]' },
  { name: 'card', re: /\b(?:\d[ -]?){13,19}\b/g, replacement: '[REDACTED-CARD]' },
  { name: 'phone', re: /\+?\d[\d\s().-]{7,}\d/g, replacement: '[REDACTED-PHONE]' },
  { name: 'passport', re: /\b[A-Z]{1,2}\d{6,9}\b/g, replacement: '[REDACTED-ID]' },
];

function redactText(text) {
  if (!text) return text;
  let result = text;
  for (const { re, replacement } of PATTERNS) result = result.replace(re, replacement);
  return result;
}

module.exports = { redactText };
