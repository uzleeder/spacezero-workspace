(function () {
  'use strict';
  // Generic repeater: add/remove/reorder rows for content blocks, workflow steps and
  // responsibility items. Pure DOM manipulation — nothing is persisted until the surrounding
  // form is submitted, so no separate server round-trip is needed just to reorder.
  function bindItem(list, item) {
    var up = item.querySelector('[data-move-up]');
    var down = item.querySelector('[data-move-down]');
    var remove = item.querySelector('[data-remove]');
    if (up) up.addEventListener('click', function () { var prev = item.previousElementSibling; if (prev) list.insertBefore(item, prev); });
    if (down) down.addEventListener('click', function () { var next = item.nextElementSibling; if (next) list.insertBefore(next, item); });
    if (remove) remove.addEventListener('click', function () { item.remove(); });
    var typeSelect = item.querySelector('[data-block-type]');
    if (typeSelect) {
      var sync = function () {
        var isList = typeSelect.value === 'bullets' || typeSelect.value === 'numbered';
        var textField = item.querySelector('[data-block-text-field]');
        var itemsField = item.querySelector('[data-block-items-field]');
        if (textField) textField.hidden = isList;
        if (itemsField) itemsField.hidden = !isList;
      };
      typeSelect.addEventListener('change', sync);
      sync();
    }
  }

  document.querySelectorAll('[data-repeater]').forEach(function (root) {
    var list = root.querySelector('[data-repeater-list]');
    var tpl = root.querySelector('[data-repeater-template]');
    var addBtn = root.querySelector('[data-repeater-add]');
    if (!list || !tpl) return;
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        var node = tpl.content.cloneNode(true);
        list.appendChild(node);
        bindItem(list, list.lastElementChild);
      });
    }
    Array.prototype.slice.call(list.querySelectorAll(':scope > [data-repeater-item]')).forEach(function (item) { bindItem(list, item); });
  });

  var audienceRadios = document.querySelectorAll('input[name=rolesAudience]');
  var audienceRoles = document.querySelector('[data-audience-roles]');
  if (audienceRadios.length && audienceRoles) {
    var syncAudience = function () {
      var mode = document.querySelector('input[name=rolesAudience]:checked');
      var active = mode && mode.value === 'ROLES';
      audienceRoles.style.opacity = active ? '1' : '.45';
      audienceRoles.querySelectorAll('input').forEach(function (i) { i.disabled = !active; });
    };
    audienceRadios.forEach(function (r) { r.addEventListener('change', syncAudience); });
    syncAudience();
  }
})();
