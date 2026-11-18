/* Shows progress while an AI request runs and prevents a second click, for every form marked data-progress="<id of the progress note>".
   Works without JavaScript too: the form simply submits and the page waits. */
(function () {
  'use strict';

  document.querySelectorAll('form[data-progress]').forEach(function (form) {
    form.addEventListener('submit', function () {
      var progress = document.getElementById(form.getAttribute('data-progress'));
      form.querySelectorAll('button[type="submit"]').forEach(function (button) {
        button.disabled = true;
      });
      if (progress) progress.hidden = false;
    });
  });
})();
