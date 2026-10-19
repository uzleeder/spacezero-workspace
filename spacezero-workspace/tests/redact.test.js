'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { redactText } = require('../lib/redact');

test('redacts email addresses', () => {
  const result = redactText('Contact me at john.doe@example.com for details.');
  assert.ok(!result.includes('john.doe@example.com'));
  assert.match(result, /\[REDACTED-EMAIL\]/);
});

test('redacts card-like digit sequences', () => {
  const result = redactText('My card number is 4111 1111 1111 1111, please charge it.');
  assert.ok(!result.includes('4111 1111 1111 1111'));
  assert.match(result, /\[REDACTED-CARD\]/);
});

test('redacts phone numbers', () => {
  const result = redactText('Call me back at +998 90 123 45 67 tomorrow.');
  assert.ok(!result.includes('90 123 45 67'));
  assert.match(result, /\[REDACTED-PHONE\]|\[REDACTED-CARD\]/);
});

test('redacts passport-like IDs', () => {
  const result = redactText('My passport number is AB1234567.');
  assert.ok(!result.includes('AB1234567'));
  assert.match(result, /\[REDACTED-ID\]/);
});

test('leaves ordinary transcript text untouched', () => {
  const text = 'The agent discovered the customer wanted a window seat and confirmed the itinerary.';
  assert.equal(redactText(text), text);
});

test('handles null/empty input safely', () => {
  assert.equal(redactText(null), null);
  assert.equal(redactText(''), '');
  assert.equal(redactText(undefined), undefined);
});
