'use strict';
const start = document.getElementById('record-start'), stop = document.getElementById('record-stop'), status = document.getElementById('voice-status');
let recorder, stream, timer, previewUrl;
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
      const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'response.webm', { type: recorder.mimeType }));
      document.getElementById('recording').files = transfer.files;
      const preview = document.getElementById('voice-preview');
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(blob); preview.src = previewUrl; preview.hidden = false;
      start.disabled = false; stop.disabled = true; status.textContent = 'Recording ready. Listen before submitting.';
    };
    recorder.start(); start.disabled = true; stop.disabled = false; status.textContent = 'Recording…';
    timer = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 600000);
  } catch { stream?.getTracks().forEach(t => t.stop()); status.textContent = 'Microphone unavailable. You can upload an audio response instead.'; }
});
stop.addEventListener('click', () => { if (recorder?.state === 'recording') recorder.stop(); });
document.getElementById('voice-form').addEventListener('submit', e => {
  if (recorder?.state === 'recording') { e.preventDefault(); status.textContent = 'Stop recording before submitting.'; return; }
  document.getElementById('voice-submit').disabled = true; status.textContent = 'Analyzing your response…';
});
window.addEventListener('pagehide', () => { stream?.getTracks().forEach(t => t.stop()); clearTimeout(timer); });
