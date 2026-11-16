/* Share / copy-link control. Self-hosted, no inline script. The button is hidden in the HTML and shown here,
   so browsing works without JavaScript. Copies the current page URL (including ?lang) unless data-share-url is set. */
(function () {
  'use strict';

  var buttons = document.querySelectorAll('[data-share]');
  if (!buttons.length) return;
  var status = document.querySelector('[data-share-status]');

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

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return fallbackCopy(text); }
      );
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function copyAndAnnounce(button, url) {
    copyText(url).then(function (copied) {
      announce(copied ? button.getAttribute('data-copied') : url);
    });
  }

  function handleClick(event) {
    var button = event.currentTarget;
    var url = button.getAttribute('data-share-url') || window.location.href;
    if (!navigator.share) return copyAndAnnounce(button, url);
    return navigator
      .share({ title: button.getAttribute('data-share-title') || document.title, url: url })
      .catch(function (error) {
        if (!error || error.name !== 'AbortError') copyAndAnnounce(button, url);
      });
  }

  Array.prototype.forEach.call(buttons, function (button) {
    button.hidden = false;
    button.addEventListener('click', handleClick);
  });
})();
