/* Shows progress while the AI request runs and prevents a second click. Works without JavaScript too. */
(function () {
  var form = document.getElementById('generate-form');
  if (!form) return;
  form.addEventListener('submit', function () {
    var button = document.getElementById('generate-button');
    var progress = document.getElementById('generate-progress');
    if (button) button.disabled = true;
    if (progress) progress.hidden = false;
  });
})();
