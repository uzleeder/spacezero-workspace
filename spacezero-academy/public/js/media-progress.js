'use strict';
// Required video / audio: progress is saved while it plays. The server marks the item finished once
// 100% has been played through in order; the moment it reports that, this page opens the practice and
// quizzes right here (no manual reload).

// Swap the server-rendered, gate-dependent parts of the page (progress card, per-item badges, the
// Practice/quiz section) for fresh ones, leaving the playing video untouched. Returns false on failure.
async function refreshGate() {
  try {
    const response = await fetch(window.location.pathname, { credentials: 'same-origin', headers: { Accept: 'text/html' } });
    if (!response.ok) return false;
    const fresh = new DOMParser().parseFromString(await response.text(), 'text/html');
    ['[data-next-card]', '[data-gate-region]'].forEach((selector) => {
      const current = document.querySelector(selector), next = fresh.querySelector(selector);
      if (current && next) current.replaceWith(next);
    });
    document.querySelectorAll('[data-module-badge]').forEach((badge) => {
      const section = badge.closest('section[id]');
      const next = section && fresh.querySelector(`#${CSS.escape(section.id)} [data-module-badge]`);
      if (next) badge.replaceWith(next);
    });
    return true;
  } catch { return false; }
}

document.querySelectorAll('[data-learning-media]').forEach(media => {
  if (media.dataset.required !== 'true') return;
  const status = document.querySelector(`[data-media-status="${media.dataset.learningMedia}"]`);
  let frontier = Number(media.dataset.frontier), pending = 0, active = false, announced = media.dataset.done === 'true';
  media.addEventListener('loadedmetadata', () => { media.currentTime = Number(media.dataset.position); });
  media.addEventListener('ratechange', () => { if (media.playbackRate > 1.2) media.playbackRate = 1.2; });
  media.addEventListener('seeking', () => { if (media.currentTime > frontier + 1) media.currentTime = frontier; });

  async function onCompleted(data) {
    announced = true;
    media.dataset.done = 'true'; media.dispatchEvent(new Event('sz-unlock')); // the progress line becomes seekable again
    status.textContent = data.unlocked ? '✓ Fully watched — this item is finished. Your quiz is now open below.' : '✓ Fully watched — this item is finished. Finish the other required items to open the quiz.';
    const refreshed = await refreshGate();
    if (!refreshed && data.unlocked) {
      status.textContent = '✓ Fully watched — your quiz is open. ';
      const link = document.createElement('a');
      link.href = window.location.pathname; link.textContent = 'Show it now'; link.className = 'link-gold';
      status.appendChild(link);
    } else if (refreshed && data.unlocked) {
      const target = document.querySelector('[data-gate-region]');
      if (target) { target.setAttribute('tabindex', '-1'); }
    }
  }

  // Sends one save; { data } when it was saved, else { retry } - true for a dropped connection or a busy
  // server, false when the server refused the position itself (a skip ahead), which trying again cannot fix.
  async function send(action) {
    try {
      const response = await fetch(`/training-media/${media.dataset.learningMedia}/progress`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position: media.currentTime, speed: media.playbackRate, action }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        media.pause(); active = false; status.textContent = data.error || 'Progress could not be saved.';
        if (Number.isFinite(data.position)) media.currentTime = data.position;
        return { retry: response.status === 409 || response.status >= 500 };
      }
      frontier = JSON.parse(data.watchedRangesJson)[0][1];
      active = action !== 'pause';
      if (data.completedAt && !announced) await onCompleted(data).catch(() => undefined); // saved either way; a page-update hiccup is not a failed save
      else if (!data.completedAt) status.textContent = `${Math.floor(data.percentComplete)}% completed · Progress saved`;
      else status.textContent = data.unlocked ? 'Material completed — your quiz is open below.' : 'Material completed.';
      return { data };
    } catch { media.pause(); active = false; status.textContent = 'Progress could not be saved. Check your connection and resume.'; return { retry: true }; }
  }

  // One save at a time, in order. A periodic tick is skipped while another save is still on its way; every other
  // save (start, pause, the end) waits its turn instead of being dropped, so the final position always arrives.
  let queue = Promise.resolve();
  function save(action) {
    if (action === 'tick' && pending) return Promise.resolve({ skipped: true });
    pending += 1;
    const run = queue.then(() => send(action)).finally(() => { pending -= 1; });
    queue = run.catch(() => undefined);
    return run;
  }
  media.addEventListener('play', () => save('start'));
  media.addEventListener('pause', () => { if (active) save('pause'); });
  // Reaching the end must be recorded - it is what finishes the item and opens the quiz - so the final save is
  // tried again (with growing pauses) after a dropped connection or a busy server.
  media.addEventListener('ended', async () => {
    for (let wait = 600; ; wait *= 2) {
      const result = await save('pause');
      if (result.data || !result.retry || wait > 9600) return;
      status.textContent = 'Saving your progress…';
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  });
  setInterval(() => { if (!media.paused && active) save('tick'); }, 5000);
});
