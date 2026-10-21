'use strict';
// Quiz protection (see views/partials/quiz-guard.ejs and lib/quizGuard.js): protection for honest use and a trace for the
// rest. It cannot stop a phone camera or the operating system, and nothing here touches the answers, the timer or the scoring.
(function () {
  var cover = document.querySelector('[data-quiz-cover]');
  if (!cover) return;
  document.body.classList.add('quiz-guarded');
  var meta = document.querySelector('meta[name="quiz-guard-url"]');
  var reportUrl = meta ? meta.getAttribute('content') : '';

  function typing(target) { return target && target.closest && target.closest('input, textarea, [contenteditable="true"]'); }

  // ---- attempts are reported (audit log): once per kind every 20 seconds, at most 25 per page ----
  var sentAt = {}; var sentTotal = 0;
  function report(kind) {
    if (!reportUrl || !window.fetch || sentTotal >= 25) return;
    var now = Date.now();
    if (sentAt[kind] && now - sentAt[kind] < 20000) return;
    sentAt[kind] = now; sentTotal += 1;
    try {
      fetch(reportUrl, { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'event=' + encodeURIComponent(kind) }).catch(function () {});
    } catch (e) { /* reporting is best effort */ }
  }

  // ---- no copying, cutting, pasting, dragging, selecting (the page) or context menu ----
  var kindOf = { copy: 'copy', cut: 'cut', paste: 'paste', contextmenu: 'context-menu' };
  ['copy', 'cut', 'paste', 'dragstart', 'dragover', 'drop', 'contextmenu'].forEach(function (name) {
    document.addEventListener(name, function (event) {
      event.preventDefault();
      if (kindOf[name]) report(kindOf[name]);
    }, true);
  });
  document.addEventListener('selectstart', function (event) { if (!typing(event.target)) event.preventDefault(); }, true);
  // typed answers must be typed: pasting by any route (menu, middle click, drag and drop) is refused
  document.addEventListener('beforeinput', function (event) {
    if (/^insertFrom(Paste|Drop|Yank)/.test(String(event.inputType || ''))) { event.preventDefault(); report('paste'); }
  }, true);

  // ---- hiding ----
  var reasons = {};
  function refresh() { cover.hidden = Object.keys(reasons).length === 0; }
  function hide(why, ms) {
    reasons[why] = true; refresh();
    if (ms) setTimeout(function () { delete reasons[why]; refresh(); }, ms);
  }
  function show(why) { delete reasons[why]; refresh(); }
  // The quiz is hidden when the window LOSES focus (a screenshot or snipping tool, another program, another tab) - never
  // just because it was opened while another window had focus, and never on a developer's own machine (localhost), where
  // the window is almost always beside an editor; add ?strict=1 to the address there to test the hiding.
  var development = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) && !/[?&]strict=1/.test(location.search);
  window.addEventListener('blur', function () { report('focus-lost'); if (!development) hide('blur'); });
  window.addEventListener('focus', function () { show('blur'); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) { if (!development) hide('hidden'); } else show('hidden'); });
  // any click, tap or key press means the learner is in this window: never leave the quiz covered
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (name) { document.addEventListener(name, function () { show('blur'); show('hidden'); }, true); });
  cover.addEventListener('click', function () { reasons = {}; refresh(); window.focus(); });

  // ---- keyboard: copy / paste / save / print / view-source / developer tools / capture shortcuts ----
  function clearClipboard() {
    try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(' ').catch(function () {}); } catch (e) { /* not allowed here */ }
  }
  document.addEventListener('keydown', function (event) {
    var key = String(event.key || '').toLowerCase();
    var mod = event.ctrlKey || event.metaKey;
    var block = false; var kind = '';
    if (mod && ['c', 'x'].indexOf(key) !== -1) { block = true; kind = key === 'c' ? 'copy' : 'cut'; }
    if (mod && key === 'v') { block = true; kind = 'paste'; }
    if (mod && ['s', 'u'].indexOf(key) !== -1) block = true;
    if (mod && key === 'p') { block = true; kind = 'print'; }
    if (mod && !typing(event.target) && key === 'a') block = true;
    if (event.shiftKey && key === 'insert') { block = true; kind = 'paste'; }   // Shift+Insert paste
    if (event.ctrlKey && key === 'insert') { block = true; kind = 'copy'; }     // Ctrl+Insert copy
    if (key === 'f12' || (mod && event.shiftKey && ['i', 'j', 'c'].indexOf(key) !== -1)) { block = true; kind = 'devtools'; }
    if (event.metaKey && event.shiftKey && ['3', '4', '5', 's'].indexOf(key) !== -1) { block = true; kind = 'capture'; hide('capture', 2500); clearClipboard(); } // Windows Snip / macOS capture
    if (block) { event.preventDefault(); event.stopPropagation(); if (kind) report(kind); }
  }, true);
  document.addEventListener('keyup', function (event) {
    if (event.key === 'PrintScreen' || event.key === 'Print') { clearClipboard(); hide('capture', 2500); report('capture'); }
  }, true);
  window.addEventListener('beforeprint', function () { hide('print'); report('print'); });
  window.addEventListener('afterprint', function () { show('print'); });

})();
