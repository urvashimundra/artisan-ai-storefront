(function () {
  'use strict';
  var field = document.querySelector('textarea[data-counter]');
  if (!field) return;
  var output = document.getElementById(field.getAttribute('data-counter'));
  if (!output) return;
  var limit = Number(field.getAttribute('maxlength'));
  function update() {
    var used = Array.from(field.value).length;
    output.textContent = used + ' / ' + limit;
  }
  field.addEventListener('input', update);
  update();
})();
