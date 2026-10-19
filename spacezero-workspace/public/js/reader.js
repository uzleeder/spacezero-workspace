'use strict';
// Reading experience: the "On this page" list is a collapsed "Contents" disclosure on small screens and a
// permanently open side panel on wide ones. Nothing else on the page depends on this script.
(function () {
  var toc = document.querySelector('[data-reader-toc]');
  if (!toc || !window.matchMedia) return;
  var wide = window.matchMedia('(min-width: 1100px)');
  function sync() { if (wide.matches) toc.open = true; }
  sync();
  if (wide.addEventListener) wide.addEventListener('change', sync); else if (wide.addListener) wide.addListener(sync);
}());
