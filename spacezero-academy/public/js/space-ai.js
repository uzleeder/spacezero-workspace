/* Space AI chat, in the corner panel (every page) and on the Space AI page.
 * Sends the question without leaving the page, shows a typing indicator, then the answer in the same thread.
 * When Space AI cannot help, the answer lists who to contact on Telegram (the same markup as
 * views/partials/ai-message.ejs). The page keeps its history list and address up to date; the corner panel
 * remembers its chat for this browser tab, so it continues on the next page.
 */
(function () {
  'use strict';
  var contactsEl = document.getElementById('space-ai-contacts');
  var CONTACTS = null;
  try { CONTACTS = contactsEl ? JSON.parse(contactsEl.textContent) : null; } catch (e) { CONTACTS = null; }
  var avatarTpl = document.getElementById('space-ai-avatar');
  var TECHNICAL = "Space AI couldn't answer just now because of a technical problem.";

  function storage(fn) { try { return fn(window.sessionStorage); } catch (e) { return null; } }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function tgLink(c, label) {
    var a = el('a', 'ai-tg' + (label ? ' ai-tg--engineer' : ''));
    a.href = c.url; a.target = '_blank'; a.rel = 'noopener';
    a.appendChild(document.createTextNode((label || c.name) + ' '));
    a.appendChild(el('span', '', c.handle));
    return a;
  }
  function helpBlock(kind) {
    if (!CONTACTS) return null;
    var box = el('div', 'ai-help');
    var admins = el('div', 'ai-help__links');
    CONTACTS.admins.forEach(function (a) { admins.appendChild(tgLink(a)); });
    var eng = el('div', 'ai-help__links');
    eng.appendChild(tgLink(CONTACTS.engineer, CONTACTS.engineer.title + ' ' + CONTACTS.engineer.name));
    if (kind === 'technical') {
      box.appendChild(el('p', 'ai-help__lead', 'Please contact the engineer on Telegram:')); box.appendChild(eng);
      box.appendChild(el('p', 'ai-help__lead', 'For questions about your work, contact an Admin:')); box.appendChild(admins);
    } else {
      box.appendChild(el('p', 'ai-help__lead', 'Please contact an Admin on Telegram:')); box.appendChild(admins);
      box.appendChild(el('p', 'ai-help__lead', 'Is it a technical issue? Contact the engineer:')); box.appendChild(eng);
    }
    return box;
  }
  function message(m) {
    var mine = m.role === 'user';
    var row = el('div', 'ai-msg ai-msg--' + (mine ? 'user' : 'ai') + (!mine && m.kind && m.kind !== 'answer' ? ' ai-msg--' + m.kind : ''));
    if (!mine) {
      var av = el('span', 'ai-msg__avatar'); av.setAttribute('aria-hidden', 'true');
      if (avatarTpl) av.appendChild(avatarTpl.content.cloneNode(true));
      row.appendChild(av);
    }
    var bubble = el('div', 'ai-msg__bubble');
    if (m.image) {
      var img = el('img', 'ai-msg__image'); img.src = m.image.url; img.alt = m.image.name || 'Attached image';
      var link = el('a'); link.href = m.image.url; link.target = '_blank'; link.rel = 'noopener'; link.appendChild(img); bubble.appendChild(link);
    }
    bubble.appendChild(el('p', 'ai-msg__text', m.content));
    if (m.sources && m.sources.length) {
      var sources = el('nav', 'ai-sources'); sources.setAttribute('aria-label', 'Related sources'); sources.appendChild(el('span', '', 'Related sources'));
      m.sources.forEach(function (s) { if (/^\/(?!\/)/.test(s.href)) { var a = el('a', '', s.title); a.href = s.href; sources.appendChild(a); } }); bubble.appendChild(sources);
    }
    if (!mine) { var read = el('button', 'ai-read-aloud', 'Read aloud'); read.type = 'button'; read.hidden = true; read.setAttribute('data-ai-speak', ''); bubble.appendChild(read); }
    if (!mine && (m.kind === 'unknown' || m.kind === 'technical')) { var h = helpBlock(m.kind); if (h) bubble.appendChild(h); }
    row.appendChild(bubble);
    return row;
  }
  function typing() {
    var row = el('div', 'ai-msg ai-msg--ai ai-msg--typing');
    var av = el('span', 'ai-msg__avatar'); av.setAttribute('aria-hidden', 'true');
    if (avatarTpl) av.appendChild(avatarTpl.content.cloneNode(true));
    var b = el('div', 'ai-msg__bubble'); b.setAttribute('aria-label', 'Space AI is writing');
    var dots = el('span', 'ai-dots'); dots.innerHTML = '<i></i><i></i><i></i>'; b.appendChild(dots);
    row.appendChild(av); row.appendChild(b);
    return row;
  }

  function setup(root) {
    var panel = root.hasAttribute('data-ai-panel');
    var panelKey = 'spaceAiPanelChat:' + root.getAttribute('data-ai-owner');
    var form = root.querySelector('[data-ai-form]');
    if (!form) return;
    var box = form.querySelector('textarea');
    var send = form.querySelector('.ai-send');
    var chatInput = form.querySelector('[data-ai-chat-id]');
    var thread = root.querySelector('[data-ai-thread]');
    var welcome = root.querySelector('[data-ai-welcome]');
    var history = root.querySelector('[data-ai-history]');
    var openLink = root.querySelector('[data-ai-open]');
    var busy = false;
    var voice = null;
    var fileInput = form.querySelector('[data-ai-image]');
    var preview = form.querySelector('[data-ai-preview]');
    var imageError = form.querySelector('[data-ai-image-error]');
    var imageData = null;
    var imageVersion = 0;
    function clearImage() {
      imageVersion++; imageData = null;
      if (fileInput) fileInput.value = '';
      if (preview) { preview.hidden = true; preview.querySelector('img').removeAttribute('src'); }
      if (imageError) imageError.textContent = '';
      var note = form.querySelector('[data-ai-image-note]'); if (note) note.hidden = true;
      box.required = true;
    }
    if (fileInput) {
      fileInput.addEventListener('change', function () {
        var file = fileInput.files[0]; imageData = null;
        if (!file) { clearImage(); return; }
        if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 5 * 1024 * 1024 || !file.size) {
          clearImage(); imageError.textContent = 'Choose a PNG, JPEG or WebP image up to 5 MB.'; return;
        }
        imageError.textContent = ''; box.required = false;
        preview.hidden = false; form.querySelector('[data-ai-filename]').textContent = file.name;
        form.querySelector('[data-ai-image-note]').hidden = false;
        var version = ++imageVersion, reader = new FileReader();
        reader.onload = function () { if (version !== imageVersion) return; imageData = reader.result; preview.querySelector('img').src = imageData; };
        reader.onerror = function () { if (version === imageVersion) { clearImage(); imageError.textContent = 'This image could not be read. Choose it again.'; } };
        reader.readAsDataURL(file);
      });
      form.querySelector('[data-ai-remove-image]').addEventListener('click', clearImage);
    }

    function scrollDown() { thread.scrollTop = welcome && !welcome.hidden ? 0 : thread.scrollHeight; }
    function grow() { box.style.height = 'auto'; box.style.height = Math.min(box.scrollHeight, 180) + 'px'; }
    function setChat(id) {
      chatInput.value = id || '';
      if (openLink) openLink.href = id ? '/assistant?chat=' + encodeURIComponent(id) : '/assistant';
      if (panel) storage(function (s) { if (id) s.setItem(panelKey, id); else s.removeItem(panelKey); });
      else if (window.history && window.history.replaceState) window.history.replaceState(null, '', id ? '/assistant?chat=' + encodeURIComponent(id) : '/assistant');
    }
    function add(m) { if (welcome) welcome.hidden = true; var row = message(m); thread.appendChild(row); if (voice) voice.refresh(); scrollDown(); return row; }
    function remember(chat) {                      // the page: the chat moves to the top of the history
      if (!history || !chat) return;
      var empty = root.querySelector('[data-ai-empty-history]'); if (empty) empty.remove();
      var existing = history.querySelector('[data-chat-id="' + chat.id + '"]');
      if (existing) { history.insertBefore(existing, existing.dataset.pinned === 'true' ? history.firstChild : history.querySelector('[data-pinned="false"]')); }
      else {
        var row = el('div', 'ai-history__row'); row.setAttribute('data-chat-id', chat.id); row.dataset.pinned = String(!!chat.isPinned); row.dataset.archived = String(!!chat.isArchived);
        var a = el('a', 'ai-history__link'); a.href = '/assistant?chat=' + encodeURIComponent(chat.id);
        a.appendChild(el('span', 'ai-history__title', chat.title)); a.appendChild(el('span', 'ai-history__when', 'Today'));
        row.appendChild(a);
        var button = el('button', 'ai-chat-options', '⋯'); button.type = 'button'; button.setAttribute('aria-label', 'Chat options for ' + chat.title); button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('data-ai-options', ''); row.appendChild(button);
        history.insertBefore(row, history.querySelector('[data-pinned="false"]'));
      }
      Array.prototype.forEach.call(history.children, function (r) { r.classList.toggle('is-active', r.getAttribute('data-chat-id') === chat.id); });
    }
    function setBusy(value) {
      busy = value; send.disabled = value; send.classList.toggle('is-sending', value); thread.setAttribute('aria-busy', String(value));
      root.dataset.aiBusy = String(value);
      if (fileInput) fileInput.disabled = value;
      var removeImage = form.querySelector('[data-ai-remove-image]'); if (removeImage) removeImage.disabled = value;
      if (voice) voice.setBusy(value);
      if (value) form.dataset.sending = '1'; else delete form.dataset.sending;
      Array.prototype.forEach.call(root.querySelectorAll('[data-ai-new-chat], [data-ai-suggest]'), function (n) { n.disabled = value; });
    }
    function done() { setBusy(false); }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var q = box.value.trim();
      var file = fileInput && fileInput.files[0];
      if ((!q && !file) || busy) { if (!busy) done(); return; }
      if (!q) q = 'Please explain this image.';
      var body = file ? new FormData(form) : new URLSearchParams();
      body.set('question', q); body.set('chatId', chatInput.value);
      setBusy(true);
      var userRow = add({ role: 'user', content: q, image: imageData ? { url: imageData, name: file.name } : null });
      box.value = ''; grow();
      var wait = typing(); thread.appendChild(wait); scrollDown();
      var controller = new AbortController();
      var received = null;
      var timeout = setTimeout(function () { controller.abort(); }, 90000);
      fetch(form.action, { method: 'POST', credentials: 'same-origin', headers: file ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: body, signal: controller.signal })
        .then(function (r) {
          if (r.redirected || r.status === 401) return { error: 'Your session ended. Sign in again to continue.', kind: 'session' };
          return r.json().catch(function () { return null; });
        })
        .then(function (data) {
          wait.remove();
          var reply = data && data.messages && data.messages[1];
          received = reply || { role: 'assistant', kind: (data && data.kind) || 'technical', content: (data && data.error) || TECHNICAL };
          add(received);
          if (!reply && !box.value) box.value = q;
          if (data && data.chat && data.messages[0]) { userRow.replaceWith(message(data.messages[0])); clearImage(); }
          else if (reply && reply.kind === 'limit' && !box.value) box.value = q;
          if (data && data.chat) { setChat(data.chat.id); remember(data.chat); }
        })
        .catch(function () { wait.remove(); received = { role: 'assistant', kind: 'technical', content: TECHNICAL }; add(received); if (!box.value) box.value = q; })
        .then(function () { clearTimeout(timeout); done(); grow(); if (voice) voice.reply(received); });
    });
    box.addEventListener('input', grow);

    Array.prototype.forEach.call(root.querySelectorAll('[data-ai-suggest]'), function (chip) {
      chip.addEventListener('click', function () { box.value = chip.textContent; if (form.requestSubmit) form.requestSubmit(); else form.dispatchEvent(new Event('submit', { cancelable: true })); });
    });
    root.addEventListener('ai:pause', function () { if (voice) voice.stop(); });
    var pageNew = root.querySelector('[data-ai-new]');
    if (pageNew) pageNew.addEventListener('click', function (e) { if (busy) e.preventDefault(); else if (voice) voice.stop(); });
    var toggle = root.querySelector('[data-ai-side-toggle]');
    if (toggle) toggle.addEventListener('click', function () { toggle.setAttribute('aria-expanded', String(root.classList.toggle('side-open'))); });

    var newChat = root.querySelector('[data-ai-new-chat]');
    if (newChat) newChat.addEventListener('click', function () {
      if (busy) return;
      if (voice) voice.stop();
      Array.prototype.forEach.call(thread.querySelectorAll('.ai-msg'), function (n) { n.remove(); });
      if (welcome) welcome.hidden = false;
      setChat(''); clearImage(); box.value = ''; grow(); box.focus();
    });

    if (window.SpaceAIVoice) voice = window.SpaceAIVoice.create(root, {
      changed: grow,
      submit: function () { if (form.requestSubmit) form.requestSubmit(); else form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); }
    });

    if (panel) {                                    // pick up this tab's panel chat again
      var saved = storage(function (s) { return s.getItem(panelKey); });
      if (saved) {
        setBusy(true);
        fetch('/assistant/chats/' + encodeURIComponent(saved) + '/messages', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) {
            if (!data || data.chat.isArchived) { setChat(''); return; }
            setChat(data.chat.id);
            data.messages.slice(-12).forEach(add);
          })
          .catch(function () { setChat(''); })
          .then(done);
      }
    } else {
      scrollDown();
    }
    grow();
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-ai-app]'), setup);
})();
