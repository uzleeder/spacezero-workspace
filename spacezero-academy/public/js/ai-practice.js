// AI Practice: small progressive enhancements. Every page works without this file; it only removes friction.
(function () {
  // 1. Double-submit protection: a form marked data-once is sent once; its buttons are disabled right after submit.
  document.querySelectorAll('form[data-once]').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      if (form.dataset.sent === '1') { event.preventDefault(); return; }
      form.dataset.sent = '1';
      setTimeout(function () { form.querySelectorAll('button[type=submit]').forEach(function (b) { b.disabled = true; }); }, 0);
    });
  });

  // 2. Confirmation on buttons that carry data-confirm-msg.
  document.addEventListener('click', function (event) {
    var el = event.target.closest('[data-confirm-msg]');
    if (el && !window.confirm(el.getAttribute('data-confirm-msg'))) { event.preventDefault(); event.stopPropagation(); var f = el.form; if (f) delete f.dataset.sent; }
  }, true);

  // 3. Upload form: show the chosen files, switch wording between material and calls.
  var upload = document.querySelector('[data-upload-form]');
  if (upload) {
    var input = upload.querySelector('[data-files]');
    var list = upload.querySelector('[data-file-list]');
    var kinds = upload.querySelectorAll('[data-kind]');
    var originalAccept = input.accept;
    var render = function () {
      list.innerHTML = '';
      Array.prototype.forEach.call(input.files, function (f) {
        var li = document.createElement('li');
        li.textContent = f.name + ' — ' + (f.size / 1048576).toFixed(1) + ' MB';
        list.appendChild(li);
      });
    };
    var sync = function () {
      var kind = upload.querySelector('[data-kind]:checked').value;
      upload.querySelectorAll('[data-only]').forEach(function (n) { n.style.display = n.getAttribute('data-only') === kind ? '' : 'none'; });
      input.accept = kind === 'call' ? '.mp3,.wav,.ogg,.mp4,.webm' : originalAccept;
    };
    input.addEventListener('change', render);
    kinds.forEach(function (k) { k.addEventListener('change', sync); });
    sync();
  }

  // 4. Pages that show work in progress reload themselves until it finishes (the work itself never depends on this page being open).
  var auto = document.querySelector('[data-autorefresh]');
  if (auto) {
    var wait = 6000;
    setTimeout(function tick() {
      if (document.hidden) { setTimeout(tick, wait); return; }
      // replace() is a normal navigation; reload() would replay the app's welcome animation every few seconds.
      window.location.replace(window.location.href);
    }, wait);
  }
})();
