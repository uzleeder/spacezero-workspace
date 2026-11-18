// The Library page (views/library/index.ejs): the search box narrows the cards while you type (Enter still searches the
// whole Library on the server), and the "Saved" count follows the stars you tap on this page.
(function () {
  'use strict';
  var input = document.querySelector('[data-lib-search]');
  var cards = Array.prototype.slice.call(document.querySelectorAll('[data-lib-card]'));
  var empty = document.querySelector('[data-lib-empty-client]');
  if (input && cards.length) {
    input.addEventListener('input', function () {
      var words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
      var shown = 0;
      cards.forEach(function (card) {
        var text = card.getAttribute('data-search') || '';
        var match = words.every(function (w) { return text.indexOf(w) !== -1; });
        card.hidden = !match;
        if (match) shown += 1;
      });
      if (empty) empty.hidden = shown > 0;
    });
  }

  // On the Saved view the site script already removes un-starred cards and recounts; elsewhere count here.
  var count = document.querySelector('[data-favorite-count]');
  if (count && !document.querySelector('[data-favorite-row]') && window.MutationObserver) {
    var watch = new MutationObserver(function (records) {
      records.forEach(function (r) {
        var now = r.target.getAttribute('aria-pressed');
        if (r.oldValue === now) return;
        var n = parseInt(count.textContent, 10) || 0;
        count.textContent = String(Math.max(0, n + (now === 'true' ? 1 : -1)));
      });
    });
    document.querySelectorAll('[data-favorite-toggle]').forEach(function (btn) {
      watch.observe(btn, { attributes: true, attributeFilter: ['aria-pressed'], attributeOldValue: true });
    });
  }
})();
