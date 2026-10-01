(function () {
  'use strict';

  function bindBulkForm() {
    var form = document.querySelector('[data-bulk-setup-form]');
    if (!form) return;
    var saveBtn = form.querySelector('[data-bulk-save]');
    var hint = form.querySelector('[data-unsaved-hint]');
    var count = document.querySelector('[data-unsaved-count]');
    var boxes = Array.prototype.slice.call(form.querySelectorAll('[data-bulk-checkbox]'));

    function refresh() {
      var changed = boxes.filter(function (b) { return (b.checked ? '1' : '0') !== b.getAttribute('data-was'); }).length;
      if (saveBtn) saveBtn.disabled = changed === 0;
      if (hint) hint.textContent = changed === 0 ? 'No changes yet' : changed + ' unsaved change' + (changed === 1 ? '' : 's');
      if (count) { count.hidden = changed === 0; count.textContent = changed === 0 ? '' : changed + ' unsaved change' + (changed === 1 ? '' : 's'); }
    }

    boxes.forEach(function (b) { b.addEventListener('change', refresh); });
    refresh();
  }

  // The employee's own "I Have / I Don't Have" checklist: same unsaved-count pattern, plus the
  // note field only becomes visible/required once "I Don't Have" is chosen for that row — server
  // re-validates this regardless (never trust the client alone).
  function bindSelfBulkForm() {
    var form = document.querySelector('[data-self-bulk-form]');
    if (!form) return;
    var saveBtn = form.querySelector('[data-self-bulk-save]');
    var hint = form.querySelector('[data-unsaved-hint]');
    var count = document.querySelector('[data-unsaved-count]');
    var rows = Array.prototype.slice.call(form.querySelectorAll('[data-self-row]'));

    function rowState(row) {
      var checked = row.querySelector('input[type=radio]:checked');
      return checked ? checked.value : '';
    }

    function syncRow(row) {
      var note = row.querySelector('[data-note-field]');
      var textarea = note ? note.querySelector('textarea') : null;
      var isDontHave = rowState(row) === 'dontHave';
      if (note) note.hidden = !isDontHave;
      if (textarea) textarea.required = isDontHave;
    }

    function refresh() {
      var changed = rows.filter(function (row) {
        var radio = row.querySelector('input[type=radio]');
        var was = radio ? radio.getAttribute('data-was') || '' : '';
        return rowState(row) !== was;
      }).length;
      if (saveBtn) saveBtn.disabled = changed === 0;
      if (hint) hint.textContent = changed === 0 ? 'No changes yet' : changed + ' unsaved change' + (changed === 1 ? '' : 's');
      if (count) { count.hidden = changed === 0; count.textContent = changed === 0 ? '' : changed + ' unsaved change' + (changed === 1 ? '' : 's'); }
    }

    rows.forEach(function (row) {
      row.querySelectorAll('input[type=radio]').forEach(function (radio) {
        radio.addEventListener('change', function () { syncRow(row); refresh(); });
      });
      syncRow(row);
    });
    refresh();
  }

  bindBulkForm();
  bindSelfBulkForm();
}());
