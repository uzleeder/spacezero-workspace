'use strict';
// A step of the training page (views/training-content.ejs): its Next button opens the moment the step is done -
// the video/audio reached the end ('sz-unlock', public/js/media-progress.js), the document was read to the end
// ('sz-step-done', public/js/doc-reader.js), or a note has had its moment (a countdown). The server checks each again.
(function () {
  var next = document.querySelector('[data-step-next][data-unlock-on]');
  if (!next) return;
  var hint = document.querySelector('[data-step-hint]');
  var opened = false;
  function open() {
    if (opened) return;
    opened = true;
    if (next.tagName === 'A') { next.setAttribute('href', next.getAttribute('data-href')); next.removeAttribute('role'); } else next.disabled = false;
    next.removeAttribute('aria-disabled');
    next.classList.remove('is-waiting');
    if (hint) hint.hidden = true;
  }
  var on = next.getAttribute('data-unlock-on');
  if (on === 'media') document.querySelectorAll('[data-learning-media]').forEach(function (m) { m.addEventListener('sz-unlock', open); });
  if (on === 'document') document.addEventListener('sz-step-done', open);
  if (on === 'wait') {
    var left = Number(next.getAttribute('data-wait')) || 0;
    var seconds = hint && hint.querySelector('[data-step-seconds]');
    if (left <= 0) return open();
    var timer = setInterval(function () {
      left -= 1;
      if (seconds) seconds.textContent = String(Math.max(0, left));
      if (left <= 0) { clearInterval(timer); open(); }
    }, 1000);
  }
})();
