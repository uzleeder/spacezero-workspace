'use strict';
// The required-video player script (public/js/media-progress.js), run against a fake video element and a
// controllable network: reaching the end must always be saved - even while an earlier save is still on its
// way, and after a dropped connection - because that save is what finishes the item and opens the quiz.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/media-progress.js'), 'utf8');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Loads the script with one required video; every POST waits for `reply(body)` to settle it. */
function player(reply) {
  const media = new EventTarget();
  Object.assign(media, { dataset: { required: 'true', learningMedia: 'm1', frontier: '0', position: '0', done: 'false' }, currentTime: 0, playbackRate: 1, paused: false, pause() { this.paused = true; } });
  const status = { textContent: '', appendChild() {} };
  const sent = []; let tick = null;
  const document = {
    querySelectorAll: (selector) => (selector === '[data-learning-media]' ? [media] : []),
    querySelector: (selector) => (selector === '[data-media-status="m1"]' ? status : null),
    createElement: () => ({}),
  };
  const fetch = (url, options = {}) => {
    if (!options.method) return Promise.resolve({ ok: false }); // the page refresh after completion: not needed here
    const body = JSON.parse(options.body);
    sent.push(body);
    return reply(body);
  };
  vm.runInNewContext(source, { document, window: { location: { pathname: '/training-course/c1' } }, fetch, Event, setInterval: (fn) => { tick = fn; }, setTimeout, Promise, JSON, Number, Math, CSS: { escape: String }, DOMParser: class {} });
  return { media, status, sent, tick: () => tick() };
}
const ok = (position, duration = 60) => ({ ok: true, status: 200, json: async () => ({ watchedRangesJson: JSON.stringify([[0, position]]), percentComplete: position / duration * 100, completedAt: position >= duration - 1 ? new Date().toISOString() : null, unlocked: position >= duration - 1 }) });

test('the end of the video is saved even while an earlier save is still on its way', async () => {
  let releaseTick;
  const p = player((body) => (body.action === 'tick' ? new Promise((resolve) => { releaseTick = () => resolve(ok(body.position)); }) : Promise.resolve(ok(body.position))));
  p.media.dispatchEvent(new Event('play'));
  await pause(5);
  p.media.currentTime = 55; p.tick();                    // a periodic save that the server is slow to answer...
  await pause(5);
  p.media.currentTime = 60; p.media.paused = true;       // ...when the video reaches its end
  p.media.dispatchEvent(new Event('pause'));
  p.media.dispatchEvent(new Event('ended'));
  await pause(1300);                                     // longer than the old single 600 ms retry
  releaseTick();
  await pause(30);
  const final = p.sent.filter((b) => b.position === 60);
  assert.ok(final.length >= 1, 'the final position was sent');
  assert.equal(p.media.dataset.done, 'true', 'the item was announced as finished');
  assert.match(p.status.textContent, /Fully watched|Material completed/);
});

test('a dropped connection on the final save is retried until it is recorded', async () => {
  let failures = 1;
  const p = player((body) => (body.position === 60 && failures-- > 0 ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(ok(body.position))));
  p.media.dispatchEvent(new Event('play'));
  await pause(5);
  p.media.currentTime = 60; p.media.paused = true;
  p.media.dispatchEvent(new Event('ended'));
  await pause(800);
  assert.equal(p.sent.filter((b) => b.position === 60).length, 2, 'tried once more after the failure');
  assert.equal(p.media.dataset.done, 'true', 'the item was announced as finished');
  assert.match(p.status.textContent, /Fully watched/);
});

test('periodic saves never pile up: a tick is skipped while another save is on its way', async () => {
  let release;
  const p = player((body) => (body.action === 'start' ? new Promise((resolve) => { release = () => resolve(ok(0)); }) : Promise.resolve(ok(body.position))));
  p.media.dispatchEvent(new Event('play'));
  await pause(5);
  p.tick(); p.tick(); p.tick();
  release();
  await pause(10);
  assert.deepEqual(p.sent.map((b) => b.action), ['start']);
});
