'use strict';
// Keeps the Admin dashboard up to date (views/dashboard/admin.ejs): the board is reloaded from /dashboard/live every
// minute, and when the tab is shown again, so a change anywhere in the academy appears without a page reload.
// A card whose text changed glows once. If the session ended (the request is redirected) or fails, the board stays as is.
(function () {
  var root = document.getElementById('dash-live');
  if (!root || !window.fetch) return;
  var url = root.getAttribute('data-live');
  var EVERY = 60000;
  var busy = false;
  var last = Date.now();

  function stamp() {
    var el = root.querySelector('[data-ago]');
    if (!el) return;
    var mins = Math.floor((Date.now() - last) / 60000);
    el.textContent = mins < 1 ? 'Updated just now' : 'Updated ' + mins + ' min ago';
  }
  function cards() {
    var out = {};
    root.querySelectorAll('.dash-card[data-key]').forEach(function (c) { out[c.getAttribute('data-key')] = c.textContent.replace(/\s+/g, ' '); });
    return out;
  }
  function refresh() {
    if (busy || document.hidden) return;
    busy = true;
    var before = cards();
    fetch(url, { credentials: 'same-origin', headers: { Accept: 'text/html' }, cache: 'no-store' })
      .then(function (r) { if (!r.ok || r.redirected) throw new Error('not refreshed'); return r.text(); })
      .then(function (html) {
        root.innerHTML = html;
        last = Date.now();
        root.querySelectorAll('.dash-card[data-key]').forEach(function (c) {
          var key = c.getAttribute('data-key');
          if (before[key] !== undefined && before[key] !== c.textContent.replace(/\s+/g, ' ')) c.classList.add('is-fresh');
        });
      })
      .catch(function () {})
      .then(function () { busy = false; stamp(); });
  }
  setInterval(refresh, EVERY);
  setInterval(stamp, 15000);
  function back() { if (!document.hidden && Date.now() - last > 10000) refresh(); }
  document.addEventListener('visibilitychange', back);
  window.addEventListener('focus', back);
})();
