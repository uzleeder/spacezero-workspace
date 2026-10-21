'use strict';
// The reading page for training documents (views/training-read.ejs). A PDF is drawn page by page exactly as it is in
// the file (PDF.js, served from /static/vendor/pdfjs); Word, slides and pictures arrive already laid out. A line at the
// bottom fills as the learner scrolls down through the document; at the end it is full and the item is finished.
// Progress only goes up, is saved as it changes, and the server decides when the item is finished (it also wants a fair
// amount of time with the document, so reaching the bottom in a second is not enough).
(function () {
  var root = document.querySelector('[data-doc-reader]');
  var bar = document.querySelector('[data-doc-progress]');
  if (!root || !bar) return;
  var body = root.querySelector('[data-reader-body]');
  var fill = bar.querySelector('[data-progress-fill]');
  var percentEl = bar.querySelector('[data-progress-percent]');
  var label = bar.querySelector('[data-progress-label]');
  var note = bar.querySelector('[data-progress-note]');
  var track = bar.querySelector('[data-progress-track]');
  var back = bar.querySelector('[data-progress-back]');
  var kind = root.getAttribute('data-kind');
  var tracked = root.getAttribute('data-tracked') === 'true';
  var url = root.getAttribute('data-progress-url');
  var pages = Number(root.getAttribute('data-pages')) || 1;
  var reached = Number(root.getAttribute('data-saved')) || 0;   // the furthest point so far (never goes down)
  var done = root.getAttribute('data-done') === 'true';
  var lastSent = reached, sending = false, retryTimer = null, saveTimer = null;

  function paint() {
    var shown = done ? 100 : Math.min(100, Math.round(reached));
    fill.style.width = shown + '%';
    percentEl.textContent = shown + '%';
    track.setAttribute('aria-valuenow', String(shown));
  }
  function finish(next) {
    done = true; reached = 100; paint();
    label.textContent = '✓ Finished';
    if (note) { note.firstChild.nodeValue = 'You read it to the end - this item is finished. ' + ((next && next.message) || '') + ' '; }
    if (back) {
      if (next && next.url) { back.setAttribute('href', next.url); back.textContent = next.label; }
      back.hidden = false;
    }
  }

  // ---- how far down the document the learner has seen: the bottom of the viewport against the document's own box ----
  function seenPercent() {
    if (!body) return 0;
    var rect = body.getBoundingClientRect();
    if (rect.height <= 0) return 0;
    var seen = window.innerHeight - rect.top;                  // how much of the document has come into view
    return Math.max(0, Math.min(100, (seen / rect.height) * 100));
  }

  function send(force) {
    if (!tracked || done || sending) return;
    if (!force && reached - lastSent < 2) return;
    sending = true;
    fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ percent: reached, pages: pages }) })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        sending = false;
        if (!data) return;
        lastSent = reached;
        if (data.completed) { finish(data.next); return; }
        if (data.waitMs > 0) {
          // at the end but too soon: say so and try again when the minimum time has passed
          var seconds = Math.ceil(data.waitMs / 1000);
          if (note) note.firstChild.nodeValue = 'You reached the end. Stay with it a little longer - this item finishes in about ' + seconds + ' seconds. ';
          clearTimeout(retryTimer);
          retryTimer = setTimeout(function () { send(true); }, data.waitMs + 400);
        }
      })
      .catch(function () { sending = false; });
  }
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () { saveTimer = null; send(false); }, 2000);
  }

  var ready = kind !== 'html';   // a framed page counts only once the frame has been made as tall as the page
  function update() {
    if (done || !ready) return;
    var now = seenPercent();
    if (now > reached) {
      reached = Math.min(100, now);
      paint();
      if (reached >= 99.5) { reached = 100; paint(); send(true); } else scheduleSave();
    }
  }
  var ticking = false;
  function onScroll() { if (!ticking) { ticking = true; requestAnimationFrame(function () { ticking = false; update(); }); } }
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll);
  // leaving the page keeps what was read
  window.addEventListener('pagehide', function () {
    if (!tracked || done || reached - lastSent < 1 || !navigator.sendBeacon) return;
    navigator.sendBeacon(url, new Blob([JSON.stringify({ percent: reached, pages: pages })], { type: 'application/json' }));
  });

  // ---- PDF: draw every page as it is in the file ----
  function startPdf() {
    var loading = root.querySelector('[data-reader-loading]');
    function failed() {
      if (loading) loading.textContent = 'This document could not be opened here. Ask an administrator to upload it again.';
      label.textContent = 'Could not open the document';
    }
    if (!window.pdfjsLib) return failed();
    var lib = window.pdfjsLib;
    lib.GlobalWorkerOptions.workerSrc = '/static/vendor/pdfjs/pdf.worker.min.js';
    lib.getDocument({ url: root.getAttribute('data-file-url'), withCredentials: true, isEvalSupported: false, disableFontFace: false }).promise.then(function (pdf) {
      pages = pdf.numPages; root.setAttribute('data-pages', String(pages));
      var width = Math.min(body.clientWidth || 900, 960);
      var holders = [];
      var queue = [];
      for (var n = 1; n <= pdf.numPages; n += 1) queue.push(n);
      // every page gets its final size first, so the document has its full height before anything is drawn
      return queue.reduce(function (chain, number) {
        return chain.then(function () {
          return pdf.getPage(number).then(function (page) {
            var base = page.getViewport({ scale: 1 });
            var scale = width / base.width;
            var viewport = page.getViewport({ scale: scale });
            var holder = document.createElement('div');
            holder.className = 'doc-reader__page';
            holder.style.width = Math.floor(viewport.width) + 'px';
            holder.style.height = Math.floor(viewport.height) + 'px';
            holder.setAttribute('data-page', String(number));
            body.appendChild(holder);
            holders.push({ holder: holder, page: page, viewport: viewport, drawn: false });
          });
        });
      }, Promise.resolve()).then(function () {
        if (loading) loading.remove();
        function draw(item) {
          if (item.drawn) return; item.drawn = true;
          var ratio = Math.min(window.devicePixelRatio || 1, 2);
          var canvas = document.createElement('canvas');
          canvas.width = Math.floor(item.viewport.width * ratio); canvas.height = Math.floor(item.viewport.height * ratio);
          canvas.style.width = '100%'; canvas.style.height = '100%';
          item.holder.appendChild(canvas);
          item.page.render({ canvasContext: canvas.getContext('2d'), viewport: item.viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] });
        }
        if ('IntersectionObserver' in window) {
          var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (e) { if (e.isIntersecting) { var item = holders[Number(e.target.getAttribute('data-page')) - 1]; if (item) draw(item); } });
          }, { rootMargin: '900px 0px' });
          holders.forEach(function (item) { io.observe(item.holder); });
        } else { holders.forEach(draw); }
        update();
      });
    }).catch(failed);
  }

  // ---- HTML: the page in a frame, made as tall as the page itself so the whole window scrolls through it ----
  function startFrame() {
    var guard = document.querySelector('[data-protect]');
    function fit() {
      var doc;
      try { doc = body.contentDocument; } catch (e) { return; }
      if (!doc || !doc.body || doc.readyState !== 'complete' || doc.location.href === 'about:blank') return;
      if (guard && doc.head && !doc.getElementById('sz-protect')) {
        var style = doc.createElement('style'); style.id = 'sz-protect';
        style.textContent = '*{-webkit-user-select:none;user-select:none}';
        doc.head.appendChild(style);
        doc.addEventListener('contextmenu', function (e) { e.preventDefault(); });
        doc.addEventListener('copy', function (e) { e.preventDefault(); });
      }
      body.style.height = Math.max(doc.documentElement.scrollHeight, doc.body ? doc.body.scrollHeight : 0, 320) + 'px';
      pages = Math.max(1, Math.round(body.offsetHeight / 900)); root.setAttribute('data-pages', String(pages));
      ready = true;
      update();
    }
    body.addEventListener('load', function () { fit(); setTimeout(fit, 300); });
    window.addEventListener('resize', fit);
    fit();
  }

  paint();
  if (kind === 'pdf') startPdf();
  else if (kind === 'html') startFrame();
  else if (kind !== 'slides' && kind !== 'image') { pages = Math.max(1, Math.round((body ? body.scrollHeight : 900) / 900)); root.setAttribute('data-pages', String(pages)); } // text, sheets, e-books, fonts, drawings: about one page per screenful
  // a short document or picture that fits on one screen is already fully in view: it still waits for the minimum time
  window.addEventListener('load', function () { update(); setTimeout(update, 600); });
})();
