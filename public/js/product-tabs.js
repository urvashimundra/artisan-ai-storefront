(function () {
  'use strict';

  var TAB_BY_HASH = {
    '#tab-details': 'details',
    '#tab-price': 'price',
    '#tab-publish': 'publish'
  };
  var DEFAULT_TAB = 'details';

  var form = document.getElementById('review-form');
  if (!form) return;

  form.addEventListener('submit', function () {
    var field = form.querySelector('input[type="hidden"][name="tab"]');
    if (!field) {
      field = document.createElement('input');
      field.type = 'hidden';
      field.name = 'tab';
      form.appendChild(field);
    }
    field.value = TAB_BY_HASH[location.hash] || DEFAULT_TAB;
  });
})();
