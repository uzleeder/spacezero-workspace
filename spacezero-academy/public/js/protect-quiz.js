'use strict';
// Quiz protection (see views/partials/quiz-guard.ejs): a deterrent for honest use and a trace for the rest. It cannot
// stop a phone camera or the operating system, and nothing here touches the answers, the timer or the scoring.
(function () {
  var cover = document.querySelector('[data-quiz-cover]');
  var mark = document.querySelector('[data-quiz-watermark]');
  if (!cover || !mark) return;
  document.body.classList.add('quiz-guarded');

  function typing(target) { return target && target.closest && target.closest('input, textarea, [contenteditable="true"]'); }

  // ---- no copying, cutting, pasting, dragging, selecting (the page) or context menu ----
  ['copy', 'cut', 'paste', 'dragstart', 'dragover', 'drop', 'contextmenu'].forEach(function (name) {
    document.addEventListener(name, function (event) { event.preventDefault(); }, true);
  });
  document.addEventListener('selectstart', function (event) { if (!typing(event.target)) event.preventDefault(); }, true);
  // typed answers must be typed: pasting by any route (menu, middle click, drag and drop) is refused
  document.addEventListener('beforeinput', function (event) {
    if (/^insertFrom(Paste|Drop|Yank)/.test(String(event.inputType || ''))) event.preventDefault();
  }, true);

  // ---- hiding ----
  var reasons = {};
  function refresh() { cover.hidden = Object.keys(reasons).length === 0; }
  function hide(why, ms) {
    reasons[why] = true; refresh();
    if (ms) setTimeout(function () { delete reasons[why]; refresh(); }, ms);
  }
  function show(why) { delete reasons[why]; refresh(); }
  window.addEventListener('blur', function () { hide('blur'); });
  window.addEventListener('focus', function () { show('blur'); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) hide('hidden'); else show('hidden'); });
  cover.addEventListener('click', function () { reasons = {}; refresh(); window.focus(); });
  if (!document.hasFocus()) hide('blur');

  // ---- keyboard: copy / paste / save / print / view-source / developer tools / capture shortcuts ----
  function clearClipboard() {
    try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(' ').catch(function () {}); } catch (e) { /* not allowed here */ }
  }
  document.addEventListener('keydown', function (event) {
    var key = String(event.key || '').toLowerCase();
    var mod = event.ctrlKey || event.metaKey;
    var block = false;
    if (mod && ['c', 'x', 'v', 's', 'p', 'u'].indexOf(key) !== -1) block = true;
    if (mod && !typing(event.target) && key === 'a') block = true;
    if (event.shiftKey && key === 'insert') block = true;           // Shift+Insert paste
    if (event.ctrlKey && key === 'insert') block = true;            // Ctrl+Insert copy
    if (key === 'f12' || (mod && event.shiftKey && ['i', 'j', 'c'].indexOf(key) !== -1)) block = true; // developer tools
    if (event.metaKey && event.shiftKey && ['3', '4', '5', 's'].indexOf(key) !== -1) { block = true; hide('capture', 2500); clearClipboard(); } // Windows Snip / macOS capture
    if (block) { event.preventDefault(); event.stopPropagation(); }
  }, true);
  document.addEventListener('keyup', function (event) {
    if (event.key === 'PrintScreen' || event.key === 'Print') { clearClipboard(); hide('capture', 2500); }
  }, true);
  window.addEventListener('beforeprint', function () { hide('print'); });
  window.addEventListener('afterprint', function () { show('print'); });

  // ---- the watermark: the learner's own name, tiled across the whole page, put back if it is removed ----
  function paintMark() {
    var dark = document.documentElement.getAttribute('data-theme') !== 'light';
    var text = (mark.getAttribute('data-quiz-watermark') || '').replace(/[<>&"]/g, '');
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="200"><text x="20" y="110" transform="rotate(-24 180 100)" font-family="Arial,sans-serif" font-size="15" fill="' + (dark ? '#ffffff' : '#000000') + '">' + text + '</text></svg>';
    mark.style.backgroundImage = 'url("data:image/svg+xml;utf8,' + encodeURIComponent(svg) + '")';
  }
  paintMark();
  if (window.MutationObserver) {
    var parent = mark.parentNode;
    new MutationObserver(function () {
      if (!document.body.contains(mark)) parent.appendChild(mark);
      if (!mark.style.backgroundImage) paintMark();
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    new MutationObserver(paintMark).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
})();
