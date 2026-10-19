(function () {
  'use strict';
  document.querySelectorAll('[data-sz-group-toggle]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var card = btn.closest('[data-sz-group]');
      if (card) card.classList.toggle('is-collapsed');
    });
  });
  document.querySelectorAll('.sz-scope tr.sz-row[data-href]').forEach(function (row) {
    row.addEventListener('click', function (e) {
      if (e.target.closest('a, button, input, form')) return;
      window.location.href = row.getAttribute('data-href');
    });
    row.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.target.closest('a, button, input, form')) window.location.href = row.getAttribute('data-href');
    });
  });
}());
