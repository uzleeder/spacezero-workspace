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
  let frontier = Number(media.dataset.frontier), busy = false, active = false, announced = media.dataset.done === 'true';
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

  async function save(action) {
    if (busy) return null;
    busy = true;
    try {
      const response = await fetch(`/training-media/${media.dataset.learningMedia}/progress`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position: media.currentTime, speed: media.playbackRate, action }) });
      const data = await response.json();
      if (!response.ok) { media.pause(); active = false; status.textContent = data.error; if (Number.isFinite(data.position)) media.currentTime = data.position; return null; }
      frontier = JSON.parse(data.watchedRangesJson)[0][1];
      active = action !== 'pause';
      if (data.completedAt && !announced) await onCompleted(data);
      else if (!data.completedAt) status.textContent = `${Math.floor(data.percentComplete)}% completed · Progress saved`;
      else status.textContent = data.unlocked ? 'Material completed — your quiz is open below.' : 'Material completed.';
      return data;
    } catch { media.pause(); active = false; status.textContent = 'Progress could not be saved. Check your connection and resume.'; return null; }
    finally { busy = false; }
  }
  media.addEventListener('play', () => save('start'));
  media.addEventListener('pause', () => { if (active) save('pause'); });
  // Reaching the end saves one last time (a pending tick may still be in flight, so retry once).
  media.addEventListener('ended', async () => {
    let data = await save('pause');
    if (!data) { await new Promise((resolve) => setTimeout(resolve, 600)); data = await save('pause'); }
  });
  setInterval(() => { if (!media.paused && active) save('tick'); }, 5000);
});
