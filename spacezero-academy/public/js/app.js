(function () {
  'use strict';

  // ---- Loading state: disable submit buttons while a form is in flight ----
  // (This is a server-rendered app — the browser's own navigation loading
  // indicator covers full page loads; this just stops double-submits on
  // slower actions like file uploads.)
  document.querySelectorAll('form').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      // The button that was actually clicked (not just the first one). Disabling it must wait
      // until the browser has built the form data: a disabled submit button's name/value is
      // dropped, which used to turn "Approve"/"Reject" into an empty action.
      var btn = event.submitter || form.querySelector('button[type="submit"]');
      if (btn && !btn.disabled) {
        setTimeout(function () {
          if (event.defaultPrevented) return;
          btn.disabled = true;
          btn.dataset.originalText = btn.textContent;
          btn.textContent = 'Please wait…';
        }, 0);
      }
    });
  });

  // ---- Mobile sidebar toggle ----
  var menuBtn = document.querySelector('[data-menu-toggle]');
  var sidebar = document.querySelector('.sidebar');
  var backdrop = document.querySelector('.backdrop');
  function closeMenu() {
    if (sidebar) sidebar.classList.remove('open');
    if (backdrop) backdrop.classList.remove('open');
    if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false');
  }
  if (menuBtn && sidebar && backdrop) {
    menuBtn.addEventListener('click', function () {
      sidebar.classList.add('open');
      backdrop.classList.add('open');
      menuBtn.setAttribute('aria-expanded', 'true');
      sidebar.querySelector('a').focus();
    });
    backdrop.addEventListener('click', closeMenu);
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && sidebar.classList.contains('open')) {
        closeMenu(); menuBtn.focus();
      }
    });
  }

  // ---- Desktop sidebar collapse (remembered per browser) ----
  var collapseBtn = document.querySelector('[data-sidebar-collapse]');
  if (collapseBtn && sidebar) {
    var KEY = 'sz-sidebar-collapsed';
    function applyCollapsed(collapsed) {
      sidebar.classList.toggle('collapsed', collapsed);
      collapseBtn.setAttribute('aria-expanded', String(!collapsed));
      collapseBtn.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
      collapseBtn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    }
    try { applyCollapsed(window.localStorage.getItem(KEY) === '1'); } catch (e) { applyCollapsed(false); }
    collapseBtn.addEventListener('click', function () {
      var next = !sidebar.classList.contains('collapsed');
      applyCollapsed(next);
      try { window.localStorage.setItem(KEY, next ? '1' : '0'); } catch (e) { /* remembering is optional */ }
    });
  }
  // ---- Flash toast: a brief confirmation that survives the reload a "fire and reload" action does,
  // so an action like Resend invitation can actually show "Sent" instead of just silently refreshing.
  var FLASH_KEY = 'sz-flash-message';
  function showFlash(message) {
    var toast = document.createElement('div');
    toast.className = 'flash-toast form-alert success';
    toast.setAttribute('role', 'status');
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(function () { toast.classList.add('flash-toast--in'); });
    var remove = function () { toast.remove(); };
    setTimeout(remove, 4000);
    toast.addEventListener('click', remove);
  }
  try {
    var pendingFlash = sessionStorage.getItem(FLASH_KEY);
    if (pendingFlash) { sessionStorage.removeItem(FLASH_KEY); showFlash(pendingFlash); }
  } catch (e) { /* storage is optional */ }

  // ---- Generic "fire and reload" action buttons ----
  // <button data-action="/employees/123/disable" data-confirm="Are you sure?" data-success-message="Sent">
  document.querySelectorAll('[data-action]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var msg = btn.getAttribute('data-confirm');
      if (msg && !window.confirm(msg)) return;
      btn.disabled = true;
      fetch(btn.getAttribute('data-action'), { method: 'POST', headers: { 'Content-Type': 'application/json' } })
        .then(function (res) {
          if (!res.ok) throw new Error('Request failed');
          return res.json().catch(function () { return {}; });
        })
        .then(function (data) {
          if (data && data.link) {
            var box = document.createElement('div');
            box.className = 'form-alert info mt-16';
            box.innerHTML =
              '<p><strong>Local mode:</strong> copy this link and share it with the employee.</p>' +
              '<a href="' + data.link + '" target="_blank">' + window.location.origin + data.link + '</a>';
            (btn.closest('.card-body, .row-between, li, td') || btn.parentElement).appendChild(box);
            btn.disabled = false;
          } else {
            var successMessage = btn.getAttribute('data-success-message');
            if (successMessage) { try { sessionStorage.setItem(FLASH_KEY, successMessage); } catch (e) { /* optional */ } }
            window.location.reload();
          }
        })
        .catch(function () {
          btn.disabled = false;
          window.alert('Something went wrong. Please try again.');
        });
    });
  });

  // ---- Generic dropzone (drag-and-drop file upload) ----
  document.querySelectorAll('[data-dropzone]').forEach(function (dz) {
    var input = dz.querySelector('input[type=file]');
    var filenameEl = dz.querySelector('[data-dz-filename]');
    if (!input) return;
    function updateFilename() {
      if (filenameEl) filenameEl.textContent = input.files && input.files.length > 0 ? input.files[0].name : '';
    }
    input.addEventListener('change', updateFilename);
    ['dragenter', 'dragover'].forEach(function (evt) {
      dz.addEventListener(evt, function (e) { e.preventDefault(); dz.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      dz.addEventListener(evt, function (e) { e.preventDefault(); dz.classList.remove('dragover'); });
    });
    dz.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        input.files = e.dataTransfer.files;
        updateFilename();
      }
    });
  });

  // ---- Auto-submit on change (e.g. hover-to-upload avatar) ----
  document.querySelectorAll('[data-auto-submit]').forEach(function (input) {
    input.addEventListener('change', function () {
      if (input.files && input.files.length > 0 && input.form) input.form.submit();
    });
  });

  // ---- Favorite toggle (optimistic) ----
  document.querySelectorAll('[data-favorite-toggle]').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      var itemId = btn.getAttribute('data-favorite-toggle');
      var active = btn.classList.contains('is-active');
      btn.classList.toggle('is-active');
      fetch('/library/' + itemId + '/favorite', { method: 'POST' }).catch(function () {
        btn.classList.toggle('is-active', active);
      });
    });
  });

  // ---- Employee form: role select shows/hides supervisor field ----
  var roleSelect = document.querySelector('[data-role-select]');
  var supervisorField = document.querySelector('[data-supervisor-field]');
  function syncSupervisorField() {
    if (!roleSelect || !supervisorField) return;
    var needs = roleSelect.value === 'TRAVEL_AGENT' || roleSelect.value === 'FLIGHT_EXPERT';
    supervisorField.style.display = needs ? '' : 'none';
  }
  if (roleSelect) {
    roleSelect.addEventListener('change', syncSupervisorField);
    syncSupervisorField();
  }

  // ---- Library item form: item type shows file input vs URL vs note ----
  var itemTypeSelect = document.querySelector('[data-item-type-select]');
  function syncItemTypeFields() {
    if (!itemTypeSelect) return;
    var val = itemTypeSelect.value;
    document.querySelectorAll('[data-show-for-type]').forEach(function (el) {
      var types = el.getAttribute('data-show-for-type').split(',');
      el.style.display = types.indexOf(val) !== -1 ? '' : 'none';
    });
  }
  if (itemTypeSelect) {
    itemTypeSelect.addEventListener('change', syncItemTypeFields);
    syncItemTypeFields();
  }

  // ---- Assignment form: scope select shows individuals vs team ----
  var scopeSelect = document.querySelector('[data-scope-select]');
  function syncScopeFields() {
    if (!scopeSelect) return;
    var val = scopeSelect.value;
    document.querySelectorAll('[data-show-for-scope]').forEach(function (el) {
      var scopes = el.getAttribute('data-show-for-scope').split(',');
      el.style.display = scopes.indexOf(val) !== -1 ? '' : 'none';
    });
  }
  if (scopeSelect) {
    scopeSelect.addEventListener('change', syncScopeFields);
    syncScopeFields();
  }

  // ---- Course builder: dynamic module rows ----
  var moduleList = document.querySelector('[data-module-list]');
  var addModuleBtn = document.querySelector('[data-add-module]');
  var moduleTemplate = document.querySelector('#module-row-template');
  function renumberModules() {
    if (!moduleList) return;
    Array.prototype.forEach.call(moduleList.children, function (row, i) {
      var label = row.querySelector('[data-module-label]');
      if (label) label.textContent = 'Module ' + (i + 1);
    });
  }
  if (addModuleBtn && moduleTemplate && moduleList) {
    addModuleBtn.addEventListener('click', function () {
      var clone = moduleTemplate.content.cloneNode(true);
      moduleList.appendChild(clone);
      renumberModules();
    });
    moduleList.addEventListener('click', function (e) {
      var removeBtn = e.target.closest('[data-remove-module]');
      if (!removeBtn) return;
      var row = removeBtn.closest('[data-module-row]');
      if (row && moduleList.children.length > 1) {
        row.remove();
        renumberModules();
      }
    });
  }

  // Serializes module rows into a hidden JSON field before submit.
  var courseForm = document.querySelector('[data-course-form]');
  if (courseForm && moduleList) {
    courseForm.addEventListener('submit', function () {
      var modules = [];
      Array.prototype.forEach.call(moduleList.children, function (row) {
        var title = row.querySelector('[name="moduleTitle"]');
        if (!title || !title.value.trim()) return;
        modules.push({
          title: title.value.trim(),
          contentType: row.querySelector('[name="moduleContentType"]').value,
          externalUrl: row.querySelector('[name="moduleUrl"]').value || undefined,
          durationMinutes: row.querySelector('[name="moduleDuration"]').value || undefined,
          description: row.querySelector('[name="moduleDescription"]').value || undefined,
        });
      });
      document.querySelector('[name="modulesJson"]').value = JSON.stringify(modules);
    });
  }
})();

// Closes the top-right account menu on outside click or Escape.
(function () {
  var menu = document.querySelector('[data-user-menu]');
  if (!menu) return;
  document.addEventListener('click', function (e) { if (menu.open && !menu.contains(e.target)) menu.open = false; });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && menu.open) { menu.open = false; menu.querySelector('summary').focus(); } });
})();
// Close the View As dropdown on outside click / Escape.
(function () {
  var box = document.querySelector('[data-viewas]');
  if (!box) return;
  document.addEventListener('click', function (e) { if (box.open && !box.contains(e.target)) box.open = false; });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && box.open) { box.open = false; box.querySelector('summary').focus(); } });
})();
// Closes the notification bell dropdown on outside click or Escape. Opening it never marks
// anything read — that only happens when a row (or "See all") is actually clicked.
(function () {
  var menu = document.querySelector('[data-notif-menu]');
  if (!menu) return;
  document.addEventListener('click', function (e) { if (menu.open && !menu.contains(e.target)) menu.open = false; });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && menu.open) { menu.open = false; menu.querySelector('summary').focus(); } });
})();
