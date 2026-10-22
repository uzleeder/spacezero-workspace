'use strict';
// Required video / audio: progress is saved while it plays. The server marks the item finished once
// 100% has been played through in order; the moment it reports that, the step's Next button opens
// (the 'sz-unlock' event, public/js/training-steps.js) - no reload. Once finished it is review: free seeking, any speed,
// it starts from the beginning, and nothing more is saved.
document.querySelectorAll('[data-learning-media]').forEach(media => {
  if (media.dataset.required !== 'true') return;
  const finished = () => media.dataset.done === 'true';
  const status = document.querySelector(`[data-media-status="${media.dataset.learningMedia}"]`);
  let frontier = Number(media.dataset.frontier), pending = 0, active = false, announced = media.dataset.done === 'true';
  media.addEventListener('loadedmetadata', () => { if (!finished()) media.currentTime = Number(media.dataset.position); });
  media.addEventListener('ratechange', () => { if (!finished() && media.playbackRate > 1.2) media.playbackRate = 1.2; });
  media.addEventListener('seeking', () => { if (!finished() && media.currentTime > frontier + 1) media.currentTime = frontier; });

  async function onCompleted() {
    announced = true;
    media.dataset.done = 'true'; media.dispatchEvent(new Event('sz-unlock')); // the progress line becomes seekable again; Next opens
    status.textContent = '✓ Fully watched. Press Next to continue.';
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
      else status.textContent = 'Material completed. Press Next to continue.';
      return { data };
    } catch { media.pause(); active = false; status.textContent = 'Progress could not be saved. Check your connection and resume.'; return { retry: true }; }
  }

  // One save at a time, in order. A periodic tick is skipped while another save is still on its way; every other
  // save (start, pause, the end) waits its turn instead of being dropped, so the final position always arrives.
  let queue = Promise.resolve();
  function save(action) {
    if (finished() && announced) return Promise.resolve({ skipped: true }); // review: nothing left to record
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
