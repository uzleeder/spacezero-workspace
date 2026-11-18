// Manage library (views/admin/library.ejs): the "Add material" steps show only the fields for what you chose (a file,
// a link or a note), the role boxes only when "Only some roles" is chosen, a chosen file fills an empty title, the list
// can be narrowed by typing. (Forms with data-confirm-submit ask first: public/js/app.js.)
(function () {
  'use strict';
  var form = document.querySelector('[data-lib-add]');
  if (form) {
    var sources = form.querySelectorAll('[data-lib-source]');
    var audiences = form.querySelectorAll('[data-lib-audience]');
    var roles = form.querySelector('[data-lib-roles]');
    var title = form.querySelector('#lib-title');
    var file = form.querySelector('#lib-file');
    var current = function (list) { var v = ''; Array.prototype.forEach.call(list, function (r) { if (r.checked) v = r.value; }); return v; };
    var syncSource = function () {
      var v = current(sources) || 'file';
      form.querySelectorAll('[data-lib-for]').forEach(function (el) {
        var on = el.getAttribute('data-lib-for').split(' ').indexOf(v) !== -1;
        el.hidden = !on;
        el.querySelectorAll('input, textarea, select').forEach(function (i) { i.disabled = !on; });
      });
      var url = form.querySelector('#lib-url');
      if (url) url.required = v === 'link';
      var note = form.querySelector('#lib-note');
      if (note) note.required = v === 'note';
      if (file) file.required = v === 'file';
    };
    var syncAudience = function () {
      var some = current(audiences) === 'some';
      if (!roles) return;
      roles.hidden = !some;
      roles.querySelectorAll('input').forEach(function (i) { i.disabled = !some; });
    };
    Array.prototype.forEach.call(sources, function (r) { r.addEventListener('change', syncSource); });
    Array.prototype.forEach.call(audiences, function (r) { r.addEventListener('change', syncAudience); });
    syncSource();
    syncAudience();
    if (file && title) file.addEventListener('change', function () {
      if (title.value.trim() || !file.files || !file.files[0]) return;
      title.value = file.files[0].name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
    });
    form.addEventListener('submit', function (e) {
      if (current(audiences) === 'some' && roles && !roles.querySelector('input:checked')) {
        e.preventDefault();
        window.alert('Choose at least one role, or choose Everyone.');
      }
    });
  }

  document.querySelectorAll('[data-table-filter]').forEach(function (input) {
    var table = document.getElementById(input.getAttribute('data-table-filter'));
    if (!table) return;
    input.addEventListener('input', function () {
      var q = input.value.trim().toLowerCase();
      table.querySelectorAll('tbody tr').forEach(function (tr) { tr.hidden = q && (tr.getAttribute('data-filter-text') || '').indexOf(q) === -1; });
    });
  });

})();
