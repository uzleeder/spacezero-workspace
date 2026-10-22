'use strict';
// Training video and audio only play while the learner is actually in this window: switching to another tab, another
// program or minimising the browser pauses it, and it stays paused until the learner comes back and presses play
// (it never resumes by itself). Learning has to be watched, not left running in the background. Progress saving,
// the no-skipping rule and the finished check are unchanged - paused time simply does not move the position. A video
// already watched to the end (data-done) is review: it keeps playing.
(function () {
  var media = document.querySelectorAll('video[data-learning-media], audio[data-learning-media]');
  if (!media.length) return;

  function noteFor(el) {
    var note = el.__focusNote;
    if (note) return note;
    note = document.createElement('p');
    note.className = 'form-alert info mt-8';
    note.setAttribute('role', 'status');
    note.setAttribute('data-focus-note', '');
    note.hidden = true;
    note.textContent = 'Paused because you left this window. Come back and press play to continue watching.';
    var anchor = el.closest ? (el.closest('.sz-player') || el) : el;
    anchor.insertAdjacentElement('afterend', note);
    el.__focusNote = note;
    return note;
  }
  function leave(el) {
    if (el.paused || el.ended || el.dataset.done === 'true') return;
    el.pause();
    noteFor(el).hidden = false;
  }
  function pauseAll() { Array.prototype.forEach.call(media, leave); }

  window.addEventListener('blur', pauseAll);
  document.addEventListener('visibilitychange', function () { if (document.hidden) pauseAll(); });
  window.addEventListener('pagehide', pauseAll);

  Array.prototype.forEach.call(media, function (el) {
    // pressing play while the window is not the active one (or the tab is hidden) does not start it
    el.addEventListener('play', function () {
      if (el.dataset.done === 'true') return;
      if (document.hidden || (document.hasFocus && !document.hasFocus())) { el.pause(); noteFor(el).hidden = false; return; }
      if (el.__focusNote) el.__focusNote.hidden = true;
    });
  });
})();
