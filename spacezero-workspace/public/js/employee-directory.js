(function () {
  'use strict';
  var directory = document.querySelector('.employee-directory');
  if (!directory) return;
  var wrap = directory.querySelector('.table-wrap');
  var heading = directory.querySelector('.employee-directory__heading');
  var topbar = document.querySelector('.topbar');
  var toolbar = document.querySelector('.tabs--sticky');
  var source = wrap && wrap.querySelector('thead');
  var copy;
  if (source) {
    copy = document.createElement('table');
    copy.appendChild(source.cloneNode(true));
    heading.appendChild(copy);
    directory.classList.add('employee-directory--enhanced');
    wrap.addEventListener('scroll', function () { heading.scrollLeft = wrap.scrollLeft; }, { passive: true });
  }
  function measure() {
    var topHeight = topbar ? topbar.getBoundingClientRect().height : 0;
    directory.style.setProperty('--directory-top', (topHeight + (toolbar ? toolbar.getBoundingClientRect().height : 0)) + 'px');
    if (!source) return;
    copy.style.width = wrap.querySelector('table').getBoundingClientRect().width + 'px';
    var cells = copy.querySelectorAll('th');
    source.querySelectorAll('th').forEach(function (cell, index) {
      cells[index].style.width = cell.getBoundingClientRect().width + 'px';
    });
    heading.scrollLeft = wrap.scrollLeft;
  }
  measure();

  // Live search: as you type, only the rows whose name, username or e-mail contain every word stay
  // visible ("an" keeps Daniel and Hannah, "dan ort" keeps Daniel Ortiz). The address bar follows along,
  // so Apply filters, refresh and sharing the link keep the search.
  var search = document.querySelector('[data-live-search]');
  var rows = wrap ? wrap.querySelectorAll('tbody tr[data-search]') : [];
  var empty = directory.querySelector('[data-live-empty]');
  if (search && rows.length) {
    var loadedWith = search.value.trim().toLowerCase(); // the server already narrowed the list to this
    var reload;
    var apply = function () {
      var value = search.value.trim().toLowerCase();
      // Rows the server left out (page opened with a search) can only come back from the server.
      if (loadedWith && value.indexOf(loadedWith) === -1) {
        clearTimeout(reload);
        reload = setTimeout(function () { search.form.requestSubmit ? search.form.requestSubmit() : search.form.submit(); }, 400);
        return;
      }
      var words = value.split(/\s+/).filter(Boolean);
      var shown = 0;
      rows.forEach(function (row) {
        var text = row.getAttribute('data-search');
        var match = words.every(function (w) { return text.indexOf(w) !== -1; });
        row.hidden = !match;
        row.classList.toggle('is-alt', match && shown % 2 === 1); // keep the stripes even among visible rows
        if (match) shown += 1;
      });
      wrap.querySelector('table').classList.toggle('is-filtered', words.length > 0);
      wrap.hidden = shown === 0;
      heading.parentElement.hidden = shown === 0; // the pinned column labels have no columns to label
      if (empty) empty.hidden = shown > 0;
      var url = new URL(window.location.href);
      if (value) url.searchParams.set('q', search.value.trim()); else url.searchParams.delete('q');
      window.history.replaceState(null, '', url);
      if (shown) measure();
    };
    search.addEventListener('input', apply);
  }

  if (window.ResizeObserver) {
    var observer = new ResizeObserver(measure);
    observer.observe(directory);
    if (topbar) observer.observe(topbar);
    if (toolbar) observer.observe(toolbar);
    if (source) observer.observe(source);
  } else window.addEventListener('resize', measure);
}());

// Searching or applying filters sends only the fields that are filled in, so the address bar reads
// "?role=TRAVEL_AGENT&teamId=…" instead of a long list of empty "&status=&teamId=&…".
(function () {
  'use strict';
  var form = document.querySelector('form.mgmt-toolbar');
  if (!form) return;
  form.addEventListener('submit', function () {
    form.querySelectorAll('input[name], select[name]').forEach(function (field) {
      var empty = (field.type === 'checkbox' || field.type === 'radio') ? !field.checked : field.value === '';
      if (empty) field.disabled = true;
    });
  });
  // Coming back with the browser's Back button may restore the page as it was left, fields disabled.
  window.addEventListener('pageshow', function () {
    form.querySelectorAll('[disabled]').forEach(function (field) { field.disabled = false; });
  });
}());
