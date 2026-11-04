'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const createVoice = require('../public/js/space-ai-voice');

// Browser speech services are substituted here so tests never record a microphone or send audio.
function harness({ recognition = true, synthesis = true, secure = true } = {}) {
  function node() {
    return { hidden: true, disabled: false, value: '', readOnly: false, textContent: '', attributes: {}, events: {},
      setAttribute(k, v) { this.attributes[k] = v; },
      addEventListener(k, fn) { this.events[k] = fn; },
      click() { if (!this.disabled) this.events.click?.({ target: this }); },
    };
  }
  const names = ['voice', 'mic', 'mic-label', 'voice-toggle', 'voice-label', 'stop-speaking', 'voice-status'];
  const elements = Object.fromEntries(names.map(n => [`[data-ai-${n}]`, node()]));
  const box = elements.textarea = node();
  const read = node(), panel = node(); panel.open = true;
  const root = node();
  root.querySelector = s => elements[s]; root.querySelectorAll = () => [read];
  root.closest = () => panel; root.contains = () => true; root.classList = { toggle() {} };
  const doc = node(); doc.hidden = false;
  const instances = [], spoken = [], submitted = [], timers = new Map();
  let id = 0, cancelled = 0;
  class Recognition {
    constructor() { instances.push(this); }
    start() { this.onstart?.(); }
    stop() { this.onend?.(); }
    abort() { this.aborted = true; this.onend?.(); }
    result(text, final = true) { this.onresult?.({ results: [Object.assign([{ transcript: text }], { isFinal: final })] }); }
    end() { this.onend?.(); }
  }
  const env = Object.assign(node(), {
    document: doc, isSecureContext: secure,
    SpeechRecognition: recognition ? Recognition : undefined,
    SpeechSynthesisUtterance: synthesis ? class { constructor(text) { this.text = text; } } : undefined,
    speechSynthesis: synthesis ? {
      getVoices: () => [{ lang: 'ru-RU', localService: true }, { lang: 'en-US', localService: true }],
      speak(u) { spoken.push(u); }, cancel() { cancelled++; }
    } : undefined,
    setTimeout(fn, delay) { timers.set(++id, { fn, delay }); return id; }, clearTimeout(key) { timers.delete(key); },
  });
  const controller = createVoice(root, {
    changed() {},
    submit() { submitted.push(box.value); box.value = ''; controller.setBusy(true); }
  }, env);
  return { box, controller, instances, spoken, submitted, doc, env, root, read, panel, timers,
    at: name => elements[`[data-ai-${name}]`], cancelled: () => cancelled,
    resume() { for (const [key, timer] of timers) if (timer.delay === 350) { timers.delete(key); timer.fn(); break; } },
  };
}

test('voice never starts automatically, and unsupported or insecure browsers keep typing available', () => {
  const normal = harness(); assert.equal(normal.instances.length, 0); assert.equal(normal.spoken.length, 0);
  assert.equal(normal.at('voice').hidden, false);
  for (const opts of [{ recognition: false }, { secure: false }]) {
    const h = harness(opts);
    assert.equal(h.at('mic').disabled, true); assert.equal(h.at('voice-toggle').disabled, true);
    assert.equal(h.box.readOnly, false); assert.equal(h.instances.length, 0);
  }
  const dictationOnly = harness({ synthesis: false });
  assert.equal(dictationOnly.at('mic').disabled, false);
  assert.equal(dictationOnly.at('voice-toggle').disabled, true); assert.equal(dictationOnly.read.hidden, true);
});

test('microphone preserves a draft, replaces interim text, and never sends without review', () => {
  const h = harness(); h.box.value = 'Please check'; h.at('mic').click();
  const r = h.instances[0]; assert.equal(r.lang, 'en-US'); assert.equal(r.continuous, false);
  r.result('my train', false); r.result('my training', false); r.result('my training.', true); r.end();
  assert.equal(h.box.value, 'Please check my training.');
  assert.equal(h.submitted.length, 0); assert.equal(h.box.readOnly, false);
  assert.match(h.at('voice-status').textContent, /Review it/);
  h.box.value = ''; h.at('mic').click(); h.instances[1].result('x'.repeat(600)); h.instances[1].end();
  assert.equal(h.box.value.length, 500);
});

test('voice chat sends final speech once, reads English replies, then listens again without recording its own voice', () => {
  const h = harness(); h.at('voice-toggle').click();
  const r = h.instances[0]; r.result('What training is left?'); r.end(); r.end();
  assert.deepEqual(h.submitted, ['What training is left?']); assert.equal(h.instances.length, 1);
  h.controller.setBusy(false); h.controller.reply({ kind: 'answer', content: 'Your training is complete.' });
  assert.equal(h.spoken.length, 1); assert.equal(h.spoken[0].lang, 'en-US'); assert.equal(h.spoken[0].voice.lang, 'en-US');
  assert.equal(h.at('mic').disabled, true);
  h.spoken[0].onend(); h.resume(); assert.equal(h.instances.length, 2);
  h.at('voice-toggle').click();
  assert.equal(h.instances[1].aborted, true); h.instances[1].result('late speech'); h.instances[1].end(); h.resume();
  assert.equal(h.submitted.length, 1); assert.equal(h.instances.length, 2);
});

test('ending voice chat while an answer is loading prevents delayed playback or microphone restart', () => {
  const h = harness(); h.at('voice-toggle').click(); h.instances[0].result('My setup?'); h.instances[0].end();
  assert.equal(h.at('voice-toggle').disabled, false);
  h.at('voice-toggle').click(); h.controller.setBusy(false); h.controller.reply({ kind: 'answer', content: 'Done.' }); h.resume();
  assert.equal(h.spoken.length, 0); assert.equal(h.instances.length, 1);
});

test('permission, device and connection failures stop listening safely without retry loops', () => {
  for (const code of ['not-allowed', 'audio-capture', 'network', 'no-speech']) {
    const h = harness(); h.at('voice-toggle').click(); const r = h.instances[0];
    r.onerror({ error: code }); r.end(); h.resume();
    assert.equal(h.at('voice-toggle').attributes['aria-pressed'], 'false');
    assert.equal(h.box.readOnly, false); assert.equal(h.submitted.length, 0); assert.equal(h.instances.length, 1);
    assert.ok(h.at('voice-status').textContent.length > 20);
  }
});

test('hiding the tab or closing the panel stops capture and ignores late speech results', () => {
  for (const close of [h => { h.doc.hidden = true; h.doc.events.visibilitychange(); }, h => { h.panel.open = false; h.panel.events.toggle(); }, h => h.env.events.pagehide()]) {
    const h = harness(); h.at('voice-toggle').click(); const r = h.instances[0]; close(h);
    r.result('This must not be sent'); r.end(); h.resume();
    assert.equal(r.aborted, true); assert.equal(h.submitted.length, 0); assert.equal(h.box.readOnly, false);
  }
});

test('Stop speaking cancels audio and prevents auto-resume; unsuccessful replies end voice mode', () => {
  const h = harness(); h.at('voice-toggle').click(); h.instances[0].result('Help'); h.instances[0].end();
  h.controller.setBusy(false); h.controller.reply({ kind: 'answer', content: 'A long answer. '.repeat(45) });
  h.at('stop-speaking').click(); h.spoken[0].onend(); h.resume();
  assert.equal(h.cancelled(), 1); assert.equal(h.spoken.length, 1); assert.equal(h.instances.length, 1);
  h.at('voice-toggle').click(); h.instances[1].result('Help again'); h.instances[1].end();
  h.controller.setBusy(false); h.controller.reply({ kind: 'limit', content: 'Please try again later.' });
  h.spoken[1].onend(); h.resume();
  assert.equal(h.instances.length, 2); assert.equal(h.at('voice-toggle').attributes['aria-pressed'], 'false');
});

test('voice chat does not send an existing draft or restart over a newly typed draft', () => {
  const h = harness(); h.box.value = 'My unfinished draft'; h.at('voice-toggle').click();
  assert.equal(h.instances.length, 0); assert.equal(h.box.value, 'My unfinished draft');
  h.box.value = ''; h.at('voice-toggle').click(); h.instances[0].result('First question'); h.instances[0].end();
  h.controller.setBusy(false); h.controller.reply({ kind: 'answer', content: 'First answer.' });
  h.box.value = 'Next typed draft'; h.spoken[0].onend(); h.resume();
  assert.equal(h.instances.length, 1); assert.equal(h.box.value, 'Next typed draft');
  assert.equal(h.at('voice-toggle').attributes['aria-pressed'], 'false');
});
