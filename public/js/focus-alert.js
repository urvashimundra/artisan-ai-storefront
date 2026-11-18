/* Moves focus to the first error summary marked data-focus-alert, so keyboard and screen reader users land on the problem.
   Self-hosted, no inline script. Without JavaScript the summary is still read out because it has role="alert". */
(function (root) {
  'use strict';

  var doc = root.document;
  if (!doc) return;
  var summary = doc.querySelector('[data-focus-alert]');
  if (summary && typeof summary.focus === 'function') summary.focus();
})(typeof window !== 'undefined' ? window : globalThis);
