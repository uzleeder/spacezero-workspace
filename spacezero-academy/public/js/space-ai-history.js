/* Private chat controls. Native page dialogs; never browser confirm/prompt. */
(function () {
  'use strict';
  var root = document.querySelector('.ai-app'), selected = null, focusBack = null;
  if (!root) return;
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function button(text, fn, cls) { var b = el('button', cls || '', text); b.type = 'button'; b.addEventListener('click', fn); return b; }
  var menu = el('div', 'ai-chat-menu'); menu.hidden = true; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Chat options'); root.appendChild(menu);
  var dialog = el('dialog', 'ai-chat-dialog'); dialog.setAttribute('aria-labelledby', 'ai-dialog-title'); root.appendChild(dialog);
  var error;
  async function api(path, data) {
    var response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    if (response.redirected) throw new Error('Your session ended. Sign in again.');
    var out = await response.json();
    if (!response.ok) throw new Error(out.error || 'This action could not be completed.');
    return out;
  }
  function closeMenu(restore) { menu.hidden = true; if (restore && focusBack) focusBack.focus(); }
  function closeDialog() { dialog.close(); }
  dialog.addEventListener('close', function () { if (focusBack && focusBack.isConnected) focusBack.focus(); });
  function openDialog(title, description) {
    closeMenu(false); root.dispatchEvent(new Event('ai:pause'));
    dialog.replaceChildren();
    var heading = el('h2', '', title); heading.id = 'ai-dialog-title';
    dialog.appendChild(heading); dialog.appendChild(el('p', '', description));
    error = el('p', 'ai-dialog-error'); error.setAttribute('role', 'alert'); dialog.appendChild(error);
    dialog.showModal();
  }
  function actions() { var row = el('div', 'ai-dialog-actions'); row.appendChild(button('Cancel', closeDialog)); dialog.appendChild(row); return row; }
  async function run(fn) {
    error.textContent = '';
    var controls = Array.from(dialog.querySelectorAll('button,input'));
    controls.forEach(function (n) { n.disabled = true; });
    dialog.dataset.busy = 'true';
    try { await fn(); } catch (e) { error.textContent = e.message || 'Please try again.'; }
    finally { controls.forEach(function (n) { n.disabled = false; }); dialog.dataset.busy = 'false'; }
  }
  dialog.addEventListener('cancel', function (e) { if (dialog.dataset.busy === 'true') e.preventDefault(); });
  function base() { return '/assistant/chats/' + encodeURIComponent(selected.dataset.chatId); }
  function refresh(chat) { window.location.assign(chat ? '/assistant?chat=' + encodeURIComponent(chat.id) : '/assistant'); }
  function rename() {
    var path = base();
    openDialog('Rename chat', 'Choose a name that is easy to find in your history.');
    var label = el('label', '', 'Chat name'), input = el('input'); input.type = 'text'; input.maxLength = 100; input.value = selected.querySelector('.ai-history__title').textContent;
    label.appendChild(input); dialog.appendChild(label);
    var form = el('form'); form.appendChild(label); dialog.appendChild(form);
    var row = actions(), save = button('Save name', function () { form.requestSubmit(); }, 'ai-dialog-primary'); row.appendChild(save);
    form.addEventListener('submit', function (e) { e.preventDefault(); run(async function () { var data = await api(path + '/rename', { title: input.value }); refresh(data.chat); }); });
    input.focus(); input.select();
  }
  function remove() {
    var path = base(), id = selected.dataset.chatId;
    openDialog('Delete chat?', '“' + selected.querySelector('.ai-history__title').textContent + '” and its images will be permanently deleted. Shared links will stop working. This cannot be undone.');
    actions().appendChild(button('Delete chat', function () { run(async function () {
      await api(path + '/delete', {});
      var current = new URL(window.location.href).searchParams.get('chat');
      if (current === id) refresh(); else window.location.reload();
    }); }, 'ai-dialog-danger'));
    dialog.querySelector('button').focus();
  }
  function toggle(action) {
    var path = base(), restore = action === 'archive' && selected.dataset.archived === 'true';
    openDialog(action === 'pin' ? 'Update pinned chat' : restore ? 'Restore chat' : 'Archive chat', 'Updating your chat…');
    run(async function () { var data = await api(path + '/' + action, {}); refresh(data.chat); });
  }
  async function share() {
    var path = base();
    openDialog('Share chat', 'Create a read-only snapshot of the current messages and images for selected coworkers. Later messages stay private. Only these signed-in coworkers can open the link.');
    var people = el('fieldset', 'ai-share-people'); people.appendChild(el('legend', '', 'Choose coworkers (up to 20)')); dialog.appendChild(people);
    var links = el('div', 'ai-share-links'); dialog.appendChild(links);
    var row = actions(), create = button('Create share link', function () { run(async function () {
      var ids = Array.from(people.querySelectorAll('input:checked')).map(function (i) { return i.value; });
      var created = await api(path + '/share', { recipientIds: ids }); addLink(created);
    }); }, 'ai-dialog-primary'); row.appendChild(create); create.disabled = true;
    function addLink(s) {
      var item = el('div', 'ai-share-link'), label = el('label', '', 'Shared snapshot link'), input = el('input');
      input.type = 'text'; input.readOnly = true; input.value = window.location.origin + s.path; label.appendChild(input); item.appendChild(label);
      item.appendChild(button('Copy link', async function (e) {
        var copyButton = e.currentTarget;
        try { await navigator.clipboard.writeText(input.value); copyButton.textContent = 'Copied'; }
        catch { input.focus(); input.select(); error.textContent = 'Copy the selected link with Ctrl+C (or Command+C).'; }
      }));
      item.appendChild(button('Revoke link', function () { run(async function () { await api(path + '/shares/' + encodeURIComponent(s.id) + '/revoke', {}); item.remove(); }); }));
      links.prepend(item);
    }
    try {
      var data = await api(path + '/sharing');
      if (!dialog.open) return;
      data.people.forEach(function (p) {
        var label = el('label'), input = el('input'); input.type = 'checkbox'; input.value = p.id;
        label.appendChild(input); label.appendChild(document.createTextNode(p.fullName + ' · ' + p.role.replace(/_/g, ' ').toLowerCase())); people.appendChild(label);
      });
      if (!data.people.length) people.appendChild(el('p', '', 'There are no other active coworkers to share with.'));
      create.disabled = !data.people.length; data.shares.forEach(addLink);
    } catch (e) { error.textContent = e.message || 'Could not load coworkers.'; }
  }
  function openMenu(row, x, y) {
    if (root.dataset.aiBusy === 'true') return;
    selected = row; focusBack = row.querySelector('[data-ai-options]'); menu.replaceChildren();
    [['Rename', rename], [row.dataset.pinned === 'true' ? 'Unpin' : 'Pin', function () { toggle('pin'); }], [row.dataset.archived === 'true' ? 'Restore' : 'Archive', function () { toggle('archive'); }], ['Share', share], ['Delete', remove]].forEach(function (item) {
      var b = button(item[0], item[1]); b.setAttribute('role', 'menuitem'); menu.appendChild(b);
    });
    menu.hidden = false;
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8)) + 'px';
    menu.firstChild.focus();
  }
  root.addEventListener('contextmenu', function (e) { var row = e.target.closest('[data-chat-id]'); if (row) { e.preventDefault(); openMenu(row, e.clientX, e.clientY); } });
  root.addEventListener('click', function (e) { var b = e.target.closest('[data-ai-options]'); if (b) { var rect = b.getBoundingClientRect(); openMenu(b.closest('[data-chat-id]'), rect.left, rect.bottom); } });
  root.addEventListener('keydown', function (e) {
    var row = e.target.closest('[data-chat-id]');
    if (row && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) { e.preventDefault(); var rect = row.getBoundingClientRect(); openMenu(row, rect.left, rect.bottom); }
  });
  menu.addEventListener('keydown', function (e) {
    var items = Array.from(menu.children), index = items.indexOf(document.activeElement);
    if (e.key === 'Escape' || e.key === 'Tab') { closeMenu(true); if (e.key === 'Escape') e.preventDefault(); }
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) { e.preventDefault(); items[e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
  });
  document.addEventListener('pointerdown', function (e) { if (!menu.contains(e.target) && !e.target.closest('[data-ai-options]')) closeMenu(false); });
  window.addEventListener('resize', function () { closeMenu(false); });
})();

