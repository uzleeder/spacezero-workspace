'use strict';
document.querySelectorAll('[data-learning-media]').forEach(media => {
  if (media.dataset.required !== 'true') return;
  const status = document.querySelector(`[data-media-status="${media.dataset.learningMedia}"]`);
  let frontier = Number(media.dataset.frontier), busy = false, active = false;
  media.addEventListener('loadedmetadata', () => { media.currentTime = Number(media.dataset.position); });
  media.addEventListener('ratechange', () => { if (media.playbackRate > 1.2) media.playbackRate = 1.2; });
  media.addEventListener('seeking', () => { if (media.currentTime > frontier + 1) media.currentTime = frontier; });
  async function save(action) {
    if (busy) return;
    busy = true;
    try {
      const response = await fetch(`/training-media/${media.dataset.learningMedia}/progress`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position: media.currentTime, speed: media.playbackRate, action }) });
      const data = await response.json();
      if (!response.ok) { media.pause(); active = false; status.textContent = data.error; if (Number.isFinite(data.position)) media.currentTime = data.position; return; }
      frontier = JSON.parse(data.watchedRangesJson)[0][1];
      status.textContent = data.completedAt ? 'Material completed. Refresh to unlock your assessment.' : `${Math.floor(data.percentComplete)}% completed · Progress saved`;
      active = action !== 'pause';
    } catch { media.pause(); active = false; status.textContent = 'Progress could not be saved. Check your connection and resume.'; }
    finally { busy = false; }
  }
  media.addEventListener('play', () => save('start'));
  media.addEventListener('pause', () => { if (active) save('pause'); });
  media.addEventListener('ended', () => save('pause'));
  setInterval(() => { if (!media.paused && active) save('tick'); }, 5000);
});
