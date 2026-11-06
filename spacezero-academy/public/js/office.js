/* Office Management pages (views/office/*): drawers, the sticky toolbar offset, rows-per-page, "Show" on a desk
 * password. Everything also works without JavaScript (links and forms); this only makes it smoother:
 *   - an open drawer: focus moves into it, Tab stays inside, Escape or Close returns to the list (and to the row);
 *     with unsaved changes an in-page "Discard / Keep editing" bar appears first
 *   - the sticky toolbar's height is measured so table headings and focused fields are never hidden under it
 */
(function () {
  'use strict';
  var ws = document.querySelector('[data-office]');
  if (!ws) return;

  // ---- sticky offsets: the topbar's and the toolbar's real heights
  var topbar = document.querySelector('.topbar');
  var toolbar = document.querySelector('[data-o-toolbar]');
  function measure() {
    var top = topbar ? topbar.getBoundingClientRect().height : 0;
    var bar = toolbar ? toolbar.getBoundingClientRect().height : 0;
    document.documentElement.style.setProperty('--o-top', top + 'px');
    document.documentElement.style.setProperty('--o-toolbar-h', bar + 'px');
  }
  measure();
  window.addEventListener('resize', measure);
  if (toolbar) toolbar.addEventListener('toggle', measure, true);

  // ---- rows per page changes at once
  Array.prototype.forEach.call(document.querySelectorAll('[data-o-autosubmit]'), function (s) {
    s.addEventListener('change', function () { s.form.submit(); });
  });

  // ---- back to the row the manager came from
  if (/^#row-/.test(location.hash)) {
    var row = document.getElementById(location.hash.slice(1));
    var target = row && row.querySelector('a, button');
    if (target) { target.focus({ preventScroll: true }); row.scrollIntoView({ block: 'center' }); }
  }

  // ---- the drawer
  var drawer = document.querySelector('[data-o-drawer]');
  if (drawer) {
    var panel = drawer.querySelector('.o-drawer__panel');
    var closeHref = drawer.getAttribute('data-close-href');
    var dirty = false;
    var bar = drawer.querySelector('[data-o-discard]');
    document.documentElement.classList.add('o-drawer-open');
    Array.prototype.forEach.call(drawer.querySelectorAll('form[data-o-form]'), function (f) {
      f.addEventListener('input', function () { dirty = true; });
      f.addEventListener('change', function () { dirty = true; });
      f.addEventListener('submit', function () { dirty = false; });
    });
    Array.prototype.forEach.call(drawer.querySelectorAll('form:not([data-o-form])'), function (f) { f.addEventListener('submit', function () { dirty = false; }); });
    function close(href) {
      if (dirty && bar) {
        bar.hidden = false;
        bar.querySelector('[data-o-discard-go]').setAttribute('href', href || closeHref);
        bar.querySelector('[data-o-keep]').focus();
        return;
      }
      location.href = href || closeHref;
    }
    Array.prototype.forEach.call(drawer.querySelectorAll('[data-o-close], .o-drawer__backdrop'), function (a) {
      a.addEventListener('click', function (e) { e.preventDefault(); close(a.getAttribute('href')); });
    });
    if (bar) bar.querySelector('[data-o-keep]').addEventListener('click', function () { bar.hidden = true; var first = panel.querySelector('input:not([type=hidden]), select, textarea'); if (first) first.focus(); });
    window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
    drawer.addEventListener('click', function (e) { if (e.target.closest('[data-o-discard-go]')) dirty = false; });

    // focus: an error first, else the first field, else the heading
    var focusables = function () { return Array.prototype.filter.call(panel.querySelectorAll('a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'), function (el) { return el.offsetParent !== null; }); };
    var err = panel.querySelector('.form-alert.error');
    var start = err ? err : panel.querySelector('form[data-o-form] input:not([type=hidden]):not([readonly]), form[data-o-form] select, form[data-o-form] textarea') || panel.querySelector('h2');
    if (start) { if (!start.hasAttribute('tabindex') && !/^(INPUT|SELECT|TEXTAREA|A|BUTTON)$/.test(start.tagName)) start.setAttribute('tabindex', '-1'); start.focus(); }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { if (bar && !bar.hidden) { bar.hidden = true; return; } e.preventDefault(); close(); return; }
      if (e.key !== 'Tab') return;
      var list = focusables(); if (!list.length) return;
      var first = list[0], last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!panel.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    });
  }

  // ---- "Show" a desk's computer password (audited on the server), hidden again after 20 seconds
  Array.prototype.forEach.call(document.querySelectorAll('[data-pw-show]'), function (btn) {
    var value = btn.parentNode.querySelector('[data-pw-value]'), timer = null;
    function hide() { value.textContent = '•••••'; value.classList.remove('is-shown'); btn.textContent = 'Show'; timer = null; }
    btn.addEventListener('click', function () {
      if (timer) { clearTimeout(timer); hide(); return; }
      btn.disabled = true;
      fetch('/office/desks/' + encodeURIComponent(btn.getAttribute('data-pw-show')) + '/password', { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) { btn.disabled = false; if (!data) return; value.textContent = data.password || '(none)'; value.classList.add('is-shown'); btn.textContent = 'Hide'; timer = setTimeout(hide, 20000); })
        .catch(function () { btn.disabled = false; });
    });
  });
})();
