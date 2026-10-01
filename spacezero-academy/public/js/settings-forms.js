// Scoped to configuration forms. Keep failed edits in the DOM, never in browser storage.
(() => {
  'use strict';
  const forms = Array.from(document.querySelectorAll('main form[method="post"]'));
  const dirty = new Set();
  let leaving = false;
  forms.forEach((form) => {
    form.addEventListener('input', () => dirty.add(form));
    form.addEventListener('change', () => dirty.add(form));
  });
  window.addEventListener('beforeunload', (event) => {
    if (!leaving && dirty.size) { event.preventDefault(); event.returnValue = ''; }
  });
  document.addEventListener('submit', async (event) => {
    const form = event.target;
    if (!forms.includes(form) || event.defaultPrevented) return;
    event.preventDefault();
    if (form.dataset.saving) return;
    form.dataset.saving = '1';
    const button = event.submitter;
    const buttonText = button?.textContent;
    let feedback = form.querySelector('[data-save-feedback]');
    if (!feedback) {
      feedback = document.createElement('div');
      feedback.dataset.saveFeedback = '1';
      feedback.setAttribute('role', 'alert');
      form.prepend(feedback);
    }
    feedback.className = 'form-alert error mt-16';
    feedback.hidden = true;
    try {
      const body = new URLSearchParams(new FormData(form));
      if (button?.name) body.append(button.name, button.value);
      const response = await fetch(form.action, { method: 'POST', body, credentials: 'same-origin' });
      const page = new DOMParser().parseFromString(await response.text(), 'text/html');
      const error = page.querySelector('.form-alert.error');
      const url = new URL(response.url);
      if (!response.ok || error || url.searchParams.has('error') || url.pathname === '/login') {
        feedback.textContent = error?.textContent || url.searchParams.get('error') || 'The save could not be confirmed. Your entries are still here. Check your connection and sign-in before trying again.';
        feedback.hidden = false;
        return;
      }
      dirty.delete(form);
      if (dirty.size) {
        feedback.className = 'form-alert success mt-16';
        feedback.textContent = 'Changes saved. Other unsaved edits on this page have been kept.';
        feedback.hidden = false;
        return;
      }
      leaving = true;
      window.location.assign(url.href);
    } catch {
      feedback.textContent = 'The save could not be confirmed. Your entries are still here. Check your connection before trying again.';
      feedback.hidden = false;
    } finally {
      delete form.dataset.saving;
      if (button) { button.disabled = false; button.textContent = buttonText; }
    }
  });
})();
