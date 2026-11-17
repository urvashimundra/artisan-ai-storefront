(function () {
  'use strict';
  var DEFAULT_MESSAGE = 'Writing your translations\u2026 this takes about 20 seconds. Please keep this page open.';
  var form = document.querySelector('form[data-autosubmit]');
  if (!form || form.hasAttribute('data-submitting')) return;
  var MESSAGE = form.getAttribute('data-autosubmit-message') || DEFAULT_MESSAGE;
  form.setAttribute('data-submitting', '');
  var status = document.querySelector('[data-autosubmit-status]');
  var controls = form.querySelectorAll('button, [data-autosubmit-skip]');
  for (var i = 0; i < controls.length; i++) {
    if (controls[i].tagName === 'BUTTON') controls[i].disabled = true;
    controls[i].hidden = true;
  }
  if (status) {
    status.textContent = MESSAGE;
    status.setAttribute('tabindex', '-1');
    status.focus();
  }
  form.submit();
})();