(function () {
  'use strict';

  var TAB_BY_HASH = {
    '#tab-contact': 'contact',
    '#tab-notify': 'notify',
    '#tab-identity': 'identity'
  };
  var DEFAULT_TAB = 'identity';

  var form = document.querySelector('form[action="/store/settings"]');
  if (!form) return;

  function formTab() {
    var tab = form.getAttribute('data-active-tab');
    for (var hash in TAB_BY_HASH) {
      if (TAB_BY_HASH[hash] === tab) return tab;
    }
    return null;
  }

  form.addEventListener('submit', function () {
    if (location.hash === '#tab-languages') return;

    var buttons = form.querySelectorAll('button[name="tab"]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].removeAttribute('name');
    }

    var field = form.querySelector('input[type="hidden"][name="tab"]');
    if (!field) {
      field = document.createElement('input');
      field.type = 'hidden';
      field.name = 'tab';
      form.appendChild(field);
    }
    field.value = TAB_BY_HASH[location.hash] || formTab() || DEFAULT_TAB;
  });
})();
