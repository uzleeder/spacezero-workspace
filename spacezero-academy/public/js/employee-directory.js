(function () {
  'use strict';
  var directory = document.querySelector('.employee-directory');
  if (!directory) return;
  var wrap = directory.querySelector('.table-wrap');
  var heading = directory.querySelector('.employee-directory__heading');
  var topbar = document.querySelector('.topbar');
  var toolbar = document.querySelector('.employee-directory-toolbar');
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
    if (toolbar) toolbar.style.setProperty('--toolbar-top', topHeight + 'px');
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
  if (window.ResizeObserver) {
    var observer = new ResizeObserver(measure);
    observer.observe(directory);
    if (topbar) observer.observe(topbar);
    if (toolbar) observer.observe(toolbar);
    if (source) observer.observe(source);
  } else window.addEventListener('resize', measure);
}());

// "See more" pill next to the quick filters: shows/hides the search + filter bar below, instead
// of it always taking up space. Starts open server-side when a filter is already applied.
(function () {
  'use strict';
  var toggle = document.querySelector('[data-employee-filters-toggle]');
  var panel = document.getElementById('employee-filters-panel');
  if (!toggle || !panel) return;
  toggle.addEventListener('click', function () {
    var opening = panel.hasAttribute('hidden');
    if (opening) panel.removeAttribute('hidden'); else panel.setAttribute('hidden', '');
    toggle.setAttribute('aria-expanded', opening ? 'true' : 'false');
    toggle.classList.toggle('btn-gold', opening);
    toggle.classList.toggle('btn-secondary', !opening);
  });
}());
