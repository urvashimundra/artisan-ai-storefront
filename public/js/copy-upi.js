/* Copy-UPI-ID button on the private order page. Self-hosted, no inline script (the CSP blocks those). The button is hidden
   in the HTML and shown here, so the page works without JavaScript: the UPI ID is always visible as text. */
(function () {
  'use strict';

  var button = document.querySelector('[data-copy-upi]');
  if (!button) return;
  var status = document.querySelector('[data-copy-status]');

  function announce(text) {
    if (status) status.textContent = text;
  }

  function fallbackCopy(text) {
    var field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.setAttribute('aria-hidden', 'true');
    field.className = 'visually-hidden';
    document.body.appendChild(field);
    field.select();
    var copied = false;
    try {
      copied = document.execCommand('copy');
    } catch (error) {
      copied = false;
    }
    document.body.removeChild(field);
    return copied;
  }

  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
  }

  button.hidden = false;
  button.addEventListener('click', function () {
    copy(button.getAttribute('data-copy-upi')).then(function (copied) {
      if (copied) announce(button.getAttribute('data-copied'));
    });
  });
})();
