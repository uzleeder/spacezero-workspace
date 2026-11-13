// Setup checklist pages (views/admin/setup-requirements.ejs and setup-requirement-form.ejs): category chips narrow the
// list, only one "⋯" menu is open at a time (and it closes on a click elsewhere or Escape), and in the form the long
// lists of people and teams can be searched and show how many are chosen.
(function () {
  'use strict';
  var chips = document.querySelectorAll('[data-sr-cat]');
  var rows = document.querySelectorAll('[data-sr-row]');
  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      var cat = chip.getAttribute('data-sr-cat');
      chips.forEach(function (c) { c.classList.toggle('is-active', c === chip); c.setAttribute('aria-pressed', c === chip ? 'true' : 'false'); });
      rows.forEach(function (r) { r.hidden = Boolean(cat) && r.getAttribute('data-cat') !== cat; });
    });
  });

  var menus = Array.prototype.slice.call(document.querySelectorAll('details.sr-menu'));
  menus.forEach(function (m) {
    m.addEventListener('toggle', function () { if (m.open) menus.forEach(function (o) { if (o !== m) o.open = false; }); });
  });
  document.addEventListener('click', function (e) { menus.forEach(function (m) { if (m.open && !m.contains(e.target)) m.open = false; }); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    menus.forEach(function (m) { if (m.open) { m.open = false; m.querySelector('summary').focus(); } });
  });

  document.querySelectorAll('[data-pick]').forEach(function (box) {
    var input = box.querySelector('[data-pick-filter]');
    var items = box.querySelectorAll('[data-pick-item]');
    var count = box.querySelector('[data-pick-count]');
    var recount = function () { if (count) count.textContent = String(box.querySelectorAll('[data-pick-item] input:checked').length); };
    if (input) input.addEventListener('input', function () {
      var q = input.value.trim().toLowerCase();
      items.forEach(function (it) { it.hidden = q && (it.getAttribute('data-pick-item') || '').indexOf(q) === -1; });
    });
    box.addEventListener('change', recount);
    recount();
  });
})();
