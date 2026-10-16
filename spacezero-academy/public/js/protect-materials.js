'use strict';
// View-only material: on a page that carries [data-protect] (everyone except Admins) the material cannot be
// selected, copied, dragged out, saved or printed from the page. A deterrent for honest use - the server also
// never offers a download link or a raw-file page to these users.
(function () {
  var areas = document.querySelectorAll('[data-protect]');
  if (!areas.length) return;
  function inside(target) {
    for (var i = 0; i < areas.length; i += 1) if (areas[i].contains(target)) return true;
    return false;
  }
  function typing(target) { return target && target.closest && target.closest('input, textarea, select, [contenteditable="true"]'); }
  ['copy', 'cut', 'dragstart', 'selectstart', 'contextmenu'].forEach(function (name) {
    document.addEventListener(name, function (event) {
      if (typing(event.target)) return;
      if (inside(event.target) || (name === 'copy' && inside(window.getSelection && window.getSelection().anchorNode))) event.preventDefault();
    }, true);
  });
  // Save / print / view-source / select-all / copy shortcuts while a protected page is open.
  document.addEventListener('keydown', function (event) {
    if (typing(event.target)) return;
    var key = String(event.key || '').toLowerCase();
    if ((event.ctrlKey || event.metaKey) && ['s', 'p', 'u', 'a', 'c', 'x'].indexOf(key) !== -1) event.preventDefault();
  }, true);
  window.addEventListener('beforeprint', function () { document.body.classList.add('printing-blocked'); });
})();
