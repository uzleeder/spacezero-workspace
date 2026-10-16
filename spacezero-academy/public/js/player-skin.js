'use strict';
// SpaceZero video / audio player skin. The browser's default controls (a white hairline on a grey bar) are replaced by
// a control bar in the site's own style: gold progress line, rounded thumb, large readable time, a play button over
// the picture. It only drives the same <video> / <audio> element, so everything that listens to it (the "required
// material" progress saving, the no-skipping rule, view-only settings) keeps working exactly as before. If anything
// fails the native controls stay, so a video can always be played.
(function () {
  var media = document.querySelectorAll('video[data-skin], audio[data-skin]');
  if (!media.length) return;

  function clock(seconds) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    var s = Math.floor(seconds), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (r < 10 ? '0' : '') + r;
  }
  function icon(name) {
    var paths = {
      play: '<path d="M8 5v14l11-7z"/>',
      pause: '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>',
      volume: '<path d="M3 10v4h4l5 4V6L7 10zM16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M3 10v4h4l5 4V6L7 10z"/>',
      muted: '<path d="M3 10v4h4l5 4V6L7 10z"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>',
      full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'
    };
    return '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' + paths[name] + '</svg>';
  }
  function button(label, name) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'sz-btn'; b.setAttribute('aria-label', label); b.title = label; b.innerHTML = icon(name);
    return b;
  }

  Array.prototype.forEach.call(media, function (el) {
    try {
      if (el.closest('.sz-player')) return;
      var isVideo = el.tagName === 'VIDEO';
      var wrap = document.createElement('div');
      wrap.className = 'sz-player' + (isVideo ? '' : ' sz-player--audio');
      el.parentNode.insertBefore(wrap, el);
      wrap.appendChild(el);
      el.removeAttribute('controls');
      el.classList.add('sz-media');

      var big = null;
      if (isVideo) {
        big = document.createElement('button');
        big.type = 'button'; big.className = 'sz-big'; big.setAttribute('aria-label', 'Play'); big.innerHTML = icon('play');
        wrap.appendChild(big);
      }

      var bar = document.createElement('div'); bar.className = 'sz-bar';
      var play = button('Play', 'play');
      var time = document.createElement('span'); time.className = 'sz-time'; time.textContent = '0:00 / 0:00';
      var seek = document.createElement('input'); seek.type = 'range'; seek.className = 'sz-seek'; seek.min = '0'; seek.max = '1000'; seek.step = '1'; seek.value = '0'; seek.setAttribute('aria-label', 'Seek');
      var mute = button('Mute', 'volume');
      var vol = document.createElement('input'); vol.type = 'range'; vol.className = 'sz-vol'; vol.min = '0'; vol.max = '1'; vol.step = '0.05'; vol.value = '1'; vol.setAttribute('aria-label', 'Volume');
      var full = isVideo ? button('Full screen', 'full') : null;
      bar.appendChild(play); bar.appendChild(time); bar.appendChild(seek); bar.appendChild(mute); bar.appendChild(vol);
      if (full) bar.appendChild(full);
      wrap.appendChild(bar);

      var scrubbing = false, hideTimer = null;
      function paint() {
        var d = el.duration, t = el.currentTime;
        var played = d > 0 ? Math.min(100, (t / d) * 100) : 0;
        var buffered = 0;
        if (d > 0 && el.buffered && el.buffered.length) buffered = Math.min(100, (el.buffered.end(el.buffered.length - 1) / d) * 100);
        seek.style.setProperty('--sz-played', played + '%');
        seek.style.setProperty('--sz-buffered', buffered + '%');
        if (!scrubbing) seek.value = d > 0 ? String(Math.round((t / d) * 1000)) : '0';
        time.textContent = clock(t) + ' / ' + clock(d);
      }
      function state() {
        var playing = !el.paused && !el.ended;
        play.innerHTML = icon(playing ? 'pause' : 'play'); play.setAttribute('aria-label', playing ? 'Pause' : 'Play'); play.title = playing ? 'Pause' : 'Play';
        wrap.classList.toggle('sz-playing', playing);
        if (big) big.hidden = playing;
        mute.innerHTML = icon(el.muted || el.volume === 0 ? 'muted' : 'volume');
        mute.setAttribute('aria-label', el.muted ? 'Unmute' : 'Mute');
      }
      function toggle() { if (el.paused || el.ended) { var p = el.play(); if (p && p.catch) p.catch(function () {}); } else el.pause(); }
      function reveal() {
        wrap.classList.add('sz-show');
        if (hideTimer) clearTimeout(hideTimer);
        if (isVideo && !el.paused) hideTimer = setTimeout(function () { if (!bar.contains(document.activeElement)) wrap.classList.remove('sz-show'); }, 2600);
      }

      play.addEventListener('click', toggle);
      if (big) big.addEventListener('click', toggle);
      if (isVideo) el.addEventListener('click', toggle);
      mute.addEventListener('click', function () { el.muted = !el.muted; state(); });
      vol.addEventListener('input', function () { el.volume = Number(vol.value); el.muted = el.volume === 0; state(); });
      el.addEventListener('volumechange', function () { vol.value = String(el.muted ? 0 : el.volume); state(); });
      seek.addEventListener('input', function () { scrubbing = true; if (el.duration > 0) { el.currentTime = (Number(seek.value) / 1000) * el.duration; } paint(); });
      seek.addEventListener('change', function () { scrubbing = false; paint(); });
      if (full) full.addEventListener('click', function () {
        var doc = document;
        if (doc.fullscreenElement || doc.webkitFullscreenElement) { (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc); return; }
        var target = wrap.requestFullscreen ? wrap : (wrap.webkitRequestFullscreen ? wrap : null);
        if (target) (target.requestFullscreen || target.webkitRequestFullscreen).call(target);
        else if (el.webkitEnterFullscreen) el.webkitEnterFullscreen();
      });
      wrap.addEventListener('keydown', function (e) {
        if (e.target === seek || e.target === vol) return;
        if (e.key === ' ' || e.key === 'k') { if (e.target === play || e.target === mute || e.target === full || e.target === big) return; e.preventDefault(); toggle(); }
        else if (e.key === 'ArrowRight') { el.currentTime = Math.min((el.duration || 0), el.currentTime + 5); }
        else if (e.key === 'ArrowLeft') { el.currentTime = Math.max(0, el.currentTime - 5); }
        else if (e.key === 'm') { el.muted = !el.muted; }
        reveal();
      });
      ['timeupdate', 'progress', 'loadedmetadata', 'durationchange', 'seeked', 'emptied'].forEach(function (name) { el.addEventListener(name, paint); });
      ['play', 'pause', 'ended', 'playing'].forEach(function (name) { el.addEventListener(name, function () { state(); reveal(); }); });
      wrap.addEventListener('mousemove', reveal); wrap.addEventListener('touchstart', reveal, { passive: true }); wrap.addEventListener('focusin', reveal);
      // a file the browser cannot play: give the native controls back so the browser's own message shows
      el.addEventListener('error', function () { el.setAttribute('controls', ''); wrap.classList.add('sz-failed'); });
      wrap.classList.add('sz-show'); state(); paint();
    } catch (e) { el.setAttribute('controls', ''); }
  });
})();
