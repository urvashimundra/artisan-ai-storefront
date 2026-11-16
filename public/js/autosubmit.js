(function () {
  'use strict';
  var form = document.querySelector('form[data-autosubmit]');
  if (!form) return;
  var button = form.querySelector('button');
  var status = document.querySelector('[data-autosubmit-status]');
  if (button) button.disabled = true;
  if (status) status.textContent = 'Writing your translations…';
  form.submit();
})();
