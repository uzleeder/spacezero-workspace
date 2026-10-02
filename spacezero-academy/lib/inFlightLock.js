'use strict';
// A single Node process (no clustering — see Dockerfile's single `node server.js`) serves every
// request, so an in-memory claim set is enough to stop a double-click or retried request from
// running the same expensive, non-idempotent AI edit (regenerate/make harder/adjust a component or
// question) twice concurrently — one request claims the key, the other is told to wait instead of
// silently racing it (both reading the same `level` before either writes, generating two paid
// Gemini calls for one click, etc.). Always release in a `finally`, including on throw.
const active = new Set();

function claim(key) {
  if (active.has(key)) return false;
  active.add(key);
  return true;
}

function release(key) {
  active.delete(key);
}

module.exports = { claim, release };
