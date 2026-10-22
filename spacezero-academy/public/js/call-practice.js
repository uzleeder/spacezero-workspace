'use strict';
// Call Practice: one call, heard and typed (views/call-practice/workspace.ejs). Keyboard first, so the hands stay on the
// typing box: Esc plays / pauses (resuming steps back 2 seconds to catch the words again), Tab steps back 5 seconds
// (Shift+Tab still leaves the box), Alt+1 / Alt+2 start an "Agent:" / "Client:" line. Listening is saved while the call
// plays and cannot skip ahead - the server checks, the rule training media follows; going back is free. The text saves
// itself a moment after typing stops, with the time spent typing; pasting is switched off. Submit opens once the whole
// call has been heard and the transcript has a few words.
(function () {
  var root = document.querySelector('[data-cp-work]');
  if (!root) return;
  var id = root.dataset.call;
  var audio = root.querySelector('audio');
  var box = root.querySelector('[data-cp-text]');
  var form = root.querySelector('[data-cp-form]');
  var submit = root.querySelector('[data-cp-submit]');
  var hint = root.querySelector('[data-cp-hint]');
  var savedNote = root.querySelector('[data-cp-saved]');
  var listenNote = root.querySelector('[data-cp-listen]');
  var pasteNote = root.querySelector('[data-cp-paste]');
  var typingField = root.querySelector('[data-cp-typing]');
  var minWords = Number(root.dataset.minWords) || 10;
  var listened = root.dataset.listened === 'true';
  var frontier = Number(root.dataset.frontier) || 0;

  function words(text) { var m = text.replace(/\[[^\]]*\]/g, ' ').match(/[\p{L}\p{N}']+/gu); return m ? m.length : 0; }
  function wordsLine(n) { return n + ' word' + (n === 1 ? '' : 's'); }

  // ---- Submit: open once the call was heard to the end and there are enough words ----
  function refresh() {
    var n = words(box.value);
    var ready = listened && n >= minWords;
    submit.disabled = !ready;
    submit.classList.toggle('is-waiting', !ready);
    hint.textContent = !listened ? 'Submit opens when you have heard the whole call.' : n < minWords ? 'Type at least ' + minWords + ' words to submit.' : 'Once submitted it is scored and cannot be changed.';
  }

  // ---- Listening: saved in order, one save at a time (the same rules as public/js/media-progress.js) ----
  var pending = 0, active = false, queue = Promise.resolve();
  audio.addEventListener('loadedmetadata', function () { if (!listened) audio.currentTime = Math.min(Number(root.dataset.position) || 0, frontier); });
  audio.addEventListener('ratechange', function () { if (audio.playbackRate > 1.2) audio.playbackRate = 1.2; else if (audio.playbackRate < 0.5) audio.playbackRate = 0.5; });
  audio.addEventListener('seeking', function () { if (!listened && audio.currentTime > frontier + 1) audio.currentTime = frontier; });

  function heardAll() {
    listened = true;
    audio.dataset.done = 'true';
    audio.dispatchEvent(new Event('sz-unlock')); // the progress line becomes seekable (public/js/player-skin.js)
    listenNote.textContent = '✓ You heard the whole call. Go back and check anything you missed.';
    refresh();
  }
  function send(action) {
    return fetch('/call-practice/' + id + '/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position: audio.currentTime, speed: audio.playbackRate, action: action }) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (data) { return { ok: r.ok, status: r.status, data: data }; }); })
      .then(function (res) {
        if (!res.ok) {
          audio.pause(); active = false;
          listenNote.textContent = res.data.error || 'Your listening could not be saved.';
          if (isFinite(res.data.position)) audio.currentTime = res.data.position;
          return { retry: res.status === 409 || res.status >= 500 };
        }
        frontier = Math.max(frontier, Number(res.data.frontier) || 0);
        active = action !== 'pause';
        if (res.data.listened) { if (!listened) heardAll(); }
        else listenNote.textContent = res.data.percent + '% heard · saved';
        return { data: res.data };
      })
      .catch(function () { audio.pause(); active = false; listenNote.textContent = 'Your listening could not be saved. Check your connection and press play again.'; return { retry: true }; });
  }
  function save(action) {
    if (listened) return Promise.resolve({ skipped: true }); // heard to the end: nothing more to record
    if (action === 'tick' && pending) return Promise.resolve({ skipped: true });
    pending += 1;
    var run = queue.then(function () { return send(action); }).finally(function () { pending -= 1; });
    queue = run.catch(function () {});
    return run;
  }
  audio.addEventListener('play', function () { save('start'); });
  audio.addEventListener('pause', function () { if (active) save('pause'); });
  // reaching the end is what opens Submit, so that save is tried again after a dropped connection or a busy server
  audio.addEventListener('ended', function () {
    var wait = 600;
    (function again() {
      save('pause').then(function (r) {
        if (r.data || r.skipped || !r.retry || wait > 9600) return;
        listenNote.textContent = 'Saving…';
        setTimeout(again, wait); wait *= 2;
      });
    })();
  });
  setInterval(function () { if (!audio.paused && active) save('tick'); }, 5000);

  // ---- Speed ----
  root.querySelectorAll('[data-speed]').forEach(function (b) {
    b.addEventListener('click', function () {
      audio.playbackRate = Number(b.dataset.speed);
      root.querySelectorAll('[data-speed]').forEach(function (o) { var on = o === b; o.classList.toggle('is-on', on); o.setAttribute('aria-pressed', String(on)); });
      box.focus();
    });
  });

  // ---- Keyboard ----
  function toggle() {
    if (audio.paused || audio.ended) {
      audio.currentTime = Math.max(0, audio.currentTime - 2);
      var p = audio.play(); if (p && p.catch) p.catch(function () {});
    } else audio.pause();
  }
  function startLine(who) {
    var before = box.value.slice(0, box.selectionStart);
    var text = (!before || /\n$/.test(before) ? '' : '\n') + who + ': ';
    box.focus();
    // insertText keeps the browser's undo; the fallback does not
    if (!(document.execCommand && document.execCommand('insertText', false, text))) {
      box.setRangeText(text, box.selectionStart, box.selectionEnd, 'end');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  root.querySelectorAll('[data-label]').forEach(function (b) { b.addEventListener('click', function () { startLine(b.dataset.label); }); });
  document.addEventListener('keydown', function (e) {
    var plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    if (e.key === 'Escape' && plain && (root.contains(e.target) || e.target === document.body)) { e.preventDefault(); toggle(); return; }
    if (e.target !== box) return;
    if (e.key === 'Tab' && plain && !e.shiftKey) { e.preventDefault(); audio.currentTime = Math.max(0, audio.currentTime - 5); return; }
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.code === 'Digit1' || e.code === 'Digit2')) { e.preventDefault(); startLine(e.code === 'Digit1' ? 'Agent' : 'Client'); }
  });

  // ---- No pasting: what is heard is typed ----
  var pasteTimer = null;
  function refusePaste(e) {
    e.preventDefault();
    pasteNote.hidden = false;
    clearTimeout(pasteTimer); pasteTimer = setTimeout(function () { pasteNote.hidden = true; }, 4000);
  }
  box.addEventListener('paste', refusePaste);
  box.addEventListener('drop', refusePaste);
  box.addEventListener('beforeinput', function (e) { if (/^insertFrom(Paste|Drop)/.test(e.inputType || '')) refusePaste(e); });

  // ---- Typing time and the draft, saved a moment after typing stops (and at least every 15 seconds) ----
  var typedMs = 0, lastKey = 0, dirty = false, saving = false, submitting = false, timer = null;
  function status(text) { savedNote.textContent = text; }
  function schedule() { clearTimeout(timer); timer = setTimeout(saveDraft, 2500); }
  function saveDraft(keepalive) {
    if (!dirty || saving || submitting) return; // the submit carries the text itself
    var text = box.value, sent = Math.round(typedMs);
    saving = true; dirty = false;
    fetch('/call-practice/' + id + '/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text, typingMs: sent }), keepalive: keepalive === true })
      .then(function (r) { if (!r.ok) throw new Error('not saved'); typedMs = Math.max(0, typedMs - sent); status(wordsLine(words(text)) + ' · Saved'); })
      .catch(function () { dirty = true; status(wordsLine(words(box.value)) + ' · Not saved yet. Check your connection.'); })
      .finally(function () { saving = false; if (dirty) schedule(); });
  }
  box.addEventListener('input', function () {
    var now = Date.now(), gap = now - lastKey;
    typedMs += lastKey && gap < 3000 ? gap : 300; // a pause to listen is not typing time
    lastKey = now; dirty = true;
    status(wordsLine(words(box.value)));
    schedule(); refresh();
  });
  setInterval(function () { if (dirty) saveDraft(); }, 15000);
  window.addEventListener('pagehide', function () { saveDraft(true); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) saveDraft(true); });
  form.addEventListener('submit', function () { submitting = true; clearTimeout(timer); typingField.value = String(Math.round(typedMs)); });

  status(box.value ? wordsLine(words(box.value)) + ' · Saved' : '');
  refresh();
})();
