'use strict';
// After a failed practice the learner waits a few minutes before the next try (lib/retakePolicy.js). The page shows
// "You can try again in X minutes" with Review the material, counts down live, and the moment the wait is over swaps
// in Try again - no reload. The server checks the wait again, so a wrong clock here cannot open a try early.
(function () {
  document.querySelectorAll('[data-retake-scope]').forEach(function (scope) {
    var until = Date.parse(scope.getAttribute('data-retake-until') || '');
    if (!until) return;
    var left = scope.querySelector('[data-retake-left]');
    function show(ready) {
      scope.querySelectorAll('[data-retake-review], [data-retake-wait]').forEach(function (el) { el.hidden = ready; });
      scope.querySelectorAll('[data-retake-try], [data-retake-ready]').forEach(function (el) { el.hidden = !ready; });
    }
    function words(ms) {
      var seconds = Math.ceil(ms / 1000);
      if (seconds >= 60) { var minutes = Math.ceil(seconds / 60); return minutes + ' minute' + (minutes === 1 ? '' : 's'); }
      return seconds + ' second' + (seconds === 1 ? '' : 's');
    }
    var timer = null;
    function tick() {
      var ms = until - Date.now();
      if (ms <= 0) { show(true); if (timer) clearInterval(timer); return; }
      if (left) left.textContent = words(ms);
    }
    timer = setInterval(tick, 1000);
    tick();
  });
})();
