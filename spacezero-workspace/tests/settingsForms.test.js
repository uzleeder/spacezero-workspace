'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/js/settings-forms.js'), 'utf8');

function setup(response, networkFailure = false) {
  const events = {}, windowEvents = {}, fieldEvents = {};
  let feedback, destination;
  const form = { dataset: {}, action: 'http://localhost/admin/skills', addEventListener: (name, handler) => { fieldEvents[name] = handler; }, querySelector: () => feedback, prepend: (value) => { feedback = value; } };
  const button = { name: 'action', value: 'save', textContent: 'Save', disabled: false };
  const context = {
    document: { querySelectorAll: () => [form], addEventListener: (name, handler) => { events[name] = handler; }, createElement: () => ({ dataset: {}, setAttribute() {} }) },
    window: { addEventListener: (name, handler) => { windowEvents[name] = handler; }, location: { assign: (url) => { destination = url; } } },
    FormData: class { *[Symbol.iterator]() { yield ['name', 'Keep my typed name']; } },
    URLSearchParams, URL,
    DOMParser: class { parseFromString() { return { querySelector: () => response.error ? { textContent: response.error } : null }; } },
    fetch: async () => { button.disabled = true; button.textContent = 'Please wait…'; if (networkFailure) throw new Error('offline'); return { ok: response.ok, url: response.url, text: async () => '' }; },
  };
  vm.runInNewContext(source, context);
  return { form, button, events, windowEvents, fieldEvents, feedback: () => feedback, destination: () => destination };
}

test('configuration validation failure keeps form, reports the error and permits retry', async () => {
  const h = setup({ ok: true, url: 'http://localhost/admin/skills?error=Duplicate', error: 'Duplicate skill name' });
  h.fieldEvents.input();
  await h.events.submit({ target: h.form, submitter: h.button, preventDefault() {} });
  assert.equal(h.destination(), undefined);
  assert.equal(h.feedback().textContent, 'Duplicate skill name');
  assert.equal(h.button.disabled, false);
  assert.equal(h.button.textContent, 'Save');
  let warned = false;
  h.windowEvents.beforeunload({ preventDefault() { warned = true; } });
  assert.equal(warned, true);
});

test('network failure never claims success or navigates away from entered changes', async () => {
  const h = setup({}, true);
  await h.events.submit({ target: h.form, submitter: h.button, preventDefault() {} });
  assert.match(h.feedback().textContent, /could not be confirmed/);
  assert.equal(h.destination(), undefined);
  assert.equal(h.button.disabled, false);
});

test('confirmed configuration save follows the server destination', async () => {
  const h = setup({ ok: true, url: 'http://localhost/admin/skills?saved=1' });
  h.fieldEvents.input();
  await h.events.submit({ target: h.form, submitter: h.button, preventDefault() {} });
  assert.equal(h.destination(), 'http://localhost/admin/skills?saved=1');
  let warned = false;
  h.windowEvents.beforeunload({ preventDefault() { warned = true; } });
  assert.equal(warned, false);
});
