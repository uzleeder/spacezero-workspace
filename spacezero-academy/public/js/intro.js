(function () {
  'use strict';
  var intro = document.getElementById('workspace-intro');
  if (!intro) return;
  var key = 'spacezero-intro-seen-v1';
  // Admin actions (resend invite, disable, reset password, ...) reload the page via
  // window.location.reload() on success (public/js/app.js) — that must not replay this.
  try { if (sessionStorage.getItem(key)) return; } catch (_) { /* Storage is optional. */ }
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var duration = reduced ? 250 : 2400;
  var bar = intro.querySelector('[role="progressbar"]');
  var fill = intro.querySelector('.workspace-intro__fill');
  var label = intro.querySelector('[data-intro-percent]');
  var previousFocus = document.activeElement;
  var locked = [];
  var finished = false;
  function release() {
    if (finished) return;
    finished = true;
    intro.hidden = true;
    document.documentElement.classList.remove('intro-active');
    locked.forEach(function (el) { el.inert = false; });
    if (previousFocus && previousFocus !== document.body) previousFocus.focus();
    try { sessionStorage.setItem(key, '1'); } catch (_) { /* Storage is optional. */ }
  }
  function start() {
    if (finished) return;
    Array.prototype.forEach.call(document.body.children, function (el) {
      if (el !== intro && el.tagName !== 'SCRIPT' && !el.inert) { el.inert = true; locked.push(el); }
    });
    intro.tabIndex = -1;
    intro.focus({ preventScroll: true });
    var startTime;
    function frame(now) {
      if (finished) return;
      if (startTime === undefined) startTime = now;
      var fraction = Math.min((now - startTime) / duration, 1);
      var percent = Math.floor(fraction * 100);
      label.textContent = percent + '%';
      bar.setAttribute('aria-valuenow', String(percent));
      fill.style.transform = 'scaleX(' + fraction + ')';
      if (fraction < 1) requestAnimationFrame(frame);
      else setTimeout(function () {
        intro.classList.add('workspace-intro--done');
        setTimeout(release, reduced ? 0 : 450);
      }, reduced ? 0 : 300);
    }
    requestAnimationFrame(frame);
  }
  intro.hidden = false;
  document.documentElement.classList.add('intro-active');
  // Always release the page, even if animation frames are paused in a background tab.
  setTimeout(release, 6500);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}());
