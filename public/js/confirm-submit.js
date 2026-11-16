/* Asks "are you sure?" before a form marked data-confirm is submitted. Without JavaScript the form still works, because the
   cancel button sits inside a closed disclosure and the server checks every transition anyway. */
(function () {
  'use strict';

  document.querySelectorAll('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      if (!window.confirm(form.getAttribute('data-confirm'))) event.preventDefault();
    });
  });
})();
