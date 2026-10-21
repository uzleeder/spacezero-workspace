'use strict';
// Voice practice page. A recording (or an uploaded file) is saved on the server the moment it exists, so
// closing the page, refreshing it, or a failed analysis never costs the learner their recording: the
// page shows the saved one again and Submit uses it. A saved recording is submitted without re-uploading.
const form = document.getElementById('voice-form');
const start = document.getElementById('record-start'), stop = document.getElementById('record-stop'), status = document.getElementById('voice-status');
const fileInput = document.getElementById('recording');
const baseUrl = form.getAttribute('action');
let recorder, stream, timer, previewUrl;

function showPreview(blob) {
  const preview = document.getElementById('voice-preview');
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(blob); preview.src = previewUrl; preview.hidden = false;
}

// Saves the file as the practice's draft on the server; on success a file is no longer required to submit.
function saveDraft(file) {
  const data = new FormData();
  data.append('recording', file, file.name || 'response.webm');
  status.textContent = 'Saving your recording…';
  return fetch(baseUrl + '/draft', { method: 'POST', body: data })
    .then((res) => res.json().catch(() => ({})).then((body) => ({ ok: res.ok, body })))
    .then((r) => {
      if (!r.ok) { status.textContent = (r.body && r.body.error) || 'Could not save the recording automatically. You can still submit it now.'; return false; }
      form.dataset.hasDraft = '1'; fileInput.required = false;
      status.textContent = 'Recording saved. You can close this page and carry on later — it will be here.';
      return true;
    })
    .catch(() => { status.textContent = 'Could not save the recording automatically (are you offline?). You can still submit it now.'; return false; });
}

start.addEventListener('click', async () => {
  if (!document.querySelector('[name="authorized"]').checked) { status.textContent = 'Confirm recording permission first.'; return; }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      clearTimeout(timer); stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(chunks, { type: recorder.mimeType });
      // iPhone / Safari record MP4 audio, Chrome / Firefox WebM or Ogg: the name follows what was recorded.
      const extension = /mp4|m4a|aac/.test(recorder.mimeType) ? 'm4a' : /ogg/.test(recorder.mimeType) ? 'ogg' : 'webm';
      const file = new File([blob], `response.${extension}`, { type: recorder.mimeType });
      const transfer = new DataTransfer(); transfer.items.add(file);
      fileInput.files = transfer.files;
      showPreview(blob);
      start.disabled = false; stop.disabled = true; status.textContent = 'Recording ready. Listen before submitting.';
      saveDraft(file);
    };
    recorder.start(); start.disabled = true; stop.disabled = false; status.textContent = 'Recording…';
    timer = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 600000);
  } catch { stream?.getTracks().forEach(t => t.stop()); status.textContent = 'Microphone unavailable. You can upload an audio response instead.'; }
});
stop.addEventListener('click', () => { if (recorder?.state === 'recording') recorder.stop(); });

// An uploaded file is saved the same way, so it is not lost either.
fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  showPreview(file);
  saveDraft(file);
});

form.addEventListener('submit', e => {
  if (recorder?.state === 'recording') { e.preventDefault(); status.textContent = 'Stop recording before submitting.'; return; }
  if (!fileInput.files.length && form.dataset.hasDraft !== '1') { e.preventDefault(); status.textContent = 'Record or upload your response first.'; return; }
  document.getElementById('voice-submit').disabled = true; status.textContent = 'Analyzing your response…';
});
// Coming back to the page through the browser's Back button must not leave "Analyzing…" stuck on screen.
window.addEventListener('pageshow', (e) => { if (e.persisted) window.location.reload(); });
window.addEventListener('pagehide', () => { stream?.getTracks().forEach(t => t.stop()); clearTimeout(timer); });
