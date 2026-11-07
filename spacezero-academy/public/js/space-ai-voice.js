/* English dictation and turn-by-turn voice chat. Audio is handled by the browser's speech service;
 * Space AI receives the resulting text through its normal authenticated chat endpoint. */
(function (factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else window.SpaceAIVoice = { create: factory };
})(function createVoice(root, hooks, env) {
  'use strict';
  env = env || window;
  var doc = env.document;
  var Recognition = env.SpeechRecognition || env.webkitSpeechRecognition;
  var synth = env.speechSynthesis;
  var canListen = Boolean(Recognition) && env.isSecureContext !== false;
  var canSpeak = Boolean(synth && env.SpeechSynthesisUtterance);
  var controls = root.querySelector('[data-ai-voice]');
  var mic = root.querySelector('[data-ai-mic]');
  var micLabel = root.querySelector('[data-ai-mic-label]');
  var toggle = root.querySelector('[data-ai-voice-toggle]');
  var toggleLabel = root.querySelector('[data-ai-voice-label]');
  var stopSpeaking = root.querySelector('[data-ai-stop-speaking]');
  var status = root.querySelector('[data-ai-voice-status]');
  var box = root.querySelector('textarea');
  var voice = false, busy = false, recognition = null, speaking = false;
  var speechToken = 0, resumeTimer = null, speechTimer = null, activeUtterance = null;
  var readOnlyBefore = false;
  var READY = '';   // idle: no status line (what each button does is in its tooltip)
  var UNSUPPORTED = env.isSecureContext === false ? 'Microphone access requires HTTPS or localhost. You can still type.' : 'Voice input is not supported in this browser. Try a browser with speech recognition, or type your message.';
  var ERRORS = {
    'not-allowed': 'Microphone access was denied. Allow microphone access in your browser settings, then try again.',
    'service-not-allowed': 'Your browser has blocked speech recognition. Check its microphone and speech settings.',
    'audio-capture': 'No microphone is available. Connect a microphone and try again.',
    'network': 'The speech service could not connect. Check your connection or type your message.',
    'no-speech': 'No speech was detected. Tap the microphone or Voice chat to try again.',
    'language-not-supported': 'English speech recognition is unavailable in this browser. You can still type.',
    'aborted': 'Microphone stopped. You can continue typing.'
  };

  function paint(text) {
    if (typeof text === 'string') status.textContent = text;
    mic.disabled = !canListen || busy || speaking;
    mic.setAttribute('aria-pressed', String(Boolean(recognition)));
    mic.setAttribute('aria-label', recognition ? 'Stop microphone' : 'Start microphone');
    micLabel.textContent = recognition ? 'Stop microphone' : 'Microphone';
    toggle.disabled = !canListen || !canSpeak || (busy && !voice) || (Boolean(recognition) && !voice);
    toggle.setAttribute('aria-pressed', String(voice));
    toggleLabel.textContent = voice ? 'End voice chat' : 'Voice chat';
    stopSpeaking.hidden = !speaking;
    root.classList.toggle('is-listening', Boolean(recognition));
    root.classList.toggle('is-speaking', speaking);
  }
  function cancelSpeech() {
    speechToken++;
    env.clearTimeout(resumeTimer); resumeTimer = null;
    env.clearTimeout(speechTimer); speechTimer = null;
    var wasSpeaking = speaking;
    speaking = false; activeUtterance = null;
    if (canSpeak && wasSpeaking) synth.cancel();
  }
  function cancelRecognition() {
    var current = recognition;
    recognition = null;
    if (current) { box.readOnly = readOnlyBefore; try { current.abort(); } catch (_) { /* Already ended. */ } }
  }
  function stop(text) {
    voice = false;
    cancelSpeech(); cancelRecognition();
    paint(text || (canListen ? READY : UNSUPPORTED));
  }
  function listen() {
    if (!canListen || busy || doc.hidden || recognition) return;
    if (voice && box.value.trim()) { stop('Voice chat paused while you edit your draft. Send or clear it to continue.'); return; }
    cancelSpeech();
    var current;
    try { current = new Recognition(); } catch (_) { stop('Speech recognition could not start. You can still type.'); return; }
    recognition = current;
    current.lang = 'en-US'; current.continuous = false; current.interimResults = true; current.maxAlternatives = 1;
    var base = box.value.trim(), finalText = '', interimText = '';
    readOnlyBefore = box.readOnly; box.readOnly = true;
    paint('Starting microphone… Allow access if your browser asks.');
    current.onstart = function () { if (recognition === current) paint(voice ? 'Listening in English… Pause when finished; your question will be sent.' : 'Listening in English… Your words will appear in the message box.'); };
    current.onresult = function (event) {
      if (recognition !== current) return;
      var finalParts = [], interimParts = [];
      for (var i = 0; i < event.results.length; i++) {
        var result = event.results[i];
        (result.isFinal ? finalParts : interimParts).push(result[0].transcript);
      }
      finalText = finalParts.join(' ').trim(); interimText = interimParts.join(' ').trim();
      box.value = [base, finalText, interimText].filter(Boolean).join(' ').slice(0, 500);
      hooks.changed();
    };
    current.onerror = function (event) {
      if (recognition === current) stop(ERRORS[event.error] || 'Speech recognition failed. Please try again or type your message.');
    };
    current.onend = function () {
      if (recognition !== current) return;
      recognition = null; box.readOnly = readOnlyBefore;
      box.value = [base, finalText || interimText].filter(Boolean).join(' ').slice(0, 500);
      hooks.changed();
      if (voice && finalText && box.value.trim()) {
        paint('Sending your question…'); hooks.submit();
      } else {
        voice = false;
        paint(box.value.trim() ? 'Your draft is ready. Review it, then press Send.' : ERRORS['no-speech']);
      }
    };
    try { current.start(); } catch (_) { stop('Microphone could not start. Check access and try again.'); }
  }
  function speak(text, continueChat) {
    if (!canSpeak) { stop('Spoken replies are unavailable in this browser. Read the reply in the chat.'); return; }
    cancelRecognition(); cancelSpeech();
    // Short chunks avoid long-utterance cutoffs and keep cancellation responsive.
    var chunks = String(text || '').match(/.{1,220}(?:\s|$)|\S{1,220}/g) || [];
    var token = speechToken;
    function next() {
      if (token !== speechToken || doc.hidden) return;
      env.clearTimeout(speechTimer);
      if (!chunks.length) {
        speaking = false; activeUtterance = null;
        paint('Reply finished.');
        if (continueChat && voice && !busy) resumeTimer = env.setTimeout(listen, 350);
        return;
      }
      var utterance = new env.SpeechSynthesisUtterance(chunks.shift());
      activeUtterance = utterance; speaking = true;
      utterance.lang = 'en-US'; utterance.rate = 1; utterance.pitch = 1;
      var english = synth.getVoices().filter(function (v) { return /^en(?:-|_)/i.test(v.lang); });
      var preferred = english.find(function (v) { return v.lang === 'en-US' && v.localService; }) || english.find(function (v) { return v.lang === 'en-US'; }) || english[0];
      if (preferred) { utterance.voice = preferred; utterance.lang = preferred.lang; }
      utterance.onend = next;
      utterance.onerror = function () { if (token === speechToken) stop('Audio playback stopped. You can read the reply or try Read aloud.'); };
      paint('Space AI is speaking in English…');
      speechTimer = env.setTimeout(function () { if (token === speechToken) stop('Audio playback did not finish. Tap Read aloud to try again.'); }, 45000);
      try { synth.speak(activeUtterance); } catch (_) { stop('Audio playback is unavailable. You can read the reply in the chat.'); }
    }
    next();
  }
  function refresh() {
    root.querySelectorAll('[data-ai-speak]').forEach(function (button) { button.hidden = !canSpeak; });
  }
  mic.addEventListener('click', function () {
    if (recognition) {
      voice = false; paint('Finishing your draft…');
      try { recognition.stop(); } catch (_) { stop(); }
    } else if (!busy) { voice = false; listen(); }
  });
  toggle.addEventListener('click', function () {
    if (voice) { stop('Voice chat ended. You can continue typing.'); return; }
    if (!canListen || !canSpeak || busy) return;
    if (box.value.trim()) { paint('Send or clear your draft before starting voice chat.'); return; }
    voice = true; listen();
  });
  stopSpeaking.addEventListener('click', function () { stop('Speech stopped. Tap Voice chat to start again.'); });
  root.addEventListener('click', function (event) {
    var button = event.target.closest('[data-ai-speak]');
    if (!button || !root.contains(button) || busy) return;
    stop(); speak(button.closest('.ai-msg__bubble').querySelector('.ai-msg__text').textContent, false);
  });
  doc.addEventListener('visibilitychange', function () { if (doc.hidden) stop('Voice paused because you left this tab. Tap Voice chat to restart.'); });
  env.addEventListener('pagehide', function () { stop(); });
  var panel = root.closest('details');
  if (panel) panel.addEventListener('toggle', function () { if (!panel.open) stop(); });
  controls.hidden = false;
  refresh(); paint(canListen ? (canSpeak ? READY : 'English microphone input is available. Spoken replies are not supported in this browser.') : UNSUPPORTED);
  return {
    stop: stop,
    refresh: refresh,
    setBusy: function (value) {
      busy = value;
      if (value) { cancelRecognition(); cancelSpeech(); }
      paint(value ? 'Space AI is thinking…' : (canListen ? (voice ? 'Preparing spoken reply…' : READY) : UNSUPPORTED));
    },
    reply: function (message) {
      if (!voice) return;
      var continueChat = message && message.kind === 'answer';
      if (!continueChat) voice = false;
      if (message) speak(message.content, continueChat); else stop('Voice chat paused. Please try again.');
    }
  };
});
