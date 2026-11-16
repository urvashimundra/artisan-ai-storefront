/* Client-side search over the orders already on the page (at most 200). No request is made: the page works without
   JavaScript, where the search box stays hidden and the status filter does the job. */
(function () {
  'use strict';

  var wrapper = document.querySelector('[data-order-search]');
  var input = document.getElementById('order-search');
  var rows = document.querySelectorAll('[data-order-row]');
  var empty = document.getElementById('order-search-empty');
  var count = document.getElementById('order-count');
  if (!wrapper || !input || rows.length === 0) return;
  wrapper.hidden = false;
  var baseCount = count ? count.textContent : '';

  function apply() {
    var query = input.value.trim().toLowerCase();
    var visible = 0;
    rows.forEach(function (row) {
      var match = query === '' || row.getAttribute('data-search').indexOf(query) !== -1;
      row.hidden = !match;
      if (match) visible += 1;
    });
    if (empty) empty.hidden = visible !== 0;
    if (count) count.textContent = query === '' ? baseCount : visible + ' matching this page';
  }

  input.addEventListener('input', apply);
})();
