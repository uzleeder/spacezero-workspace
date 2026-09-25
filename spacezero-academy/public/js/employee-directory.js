(function () {
  'use strict';
  var directory = document.querySelector('.employee-directory');
  if (!directory) return;
  var wrap = directory.querySelector('.table-wrap');
  var heading = directory.querySelector('.employee-directory__heading');
  var topbar = document.querySelector('.topbar');
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
    directory.style.setProperty('--directory-top', (topbar ? topbar.getBoundingClientRect().height : 0) + 'px');
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
    if (source) observer.observe(source);
  } else window.addEventListener('resize', measure);
}());
