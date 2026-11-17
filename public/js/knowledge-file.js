/* Reads a .txt or .md file IN THE BROWSER into the shop-notes box. Nothing is uploaded: the server only ever sees the text the
   owner then saves. Self-hosted, no inline script. Without JavaScript the file picker stays hidden and the owner pastes the text. */
(function (root) {
  'use strict';

  var MAX_FILE_BYTES = 100000;
  var MAX_CHARACTERS = 20000;
  var ALLOWED_NAME = /\.(txt|md|markdown)$/i;
  var ALLOWED_TYPES = ['text/plain', 'text/markdown', 'text/x-markdown', ''];

  /** Returns null when the file may be read, otherwise a short message. */
  function check(file) {
    if (!file) return 'Choose a file first.';
    if (!ALLOWED_NAME.test(file.name || '') || ALLOWED_TYPES.indexOf(file.type || '') === -1) return 'Choose a .txt or .md file.';
    if (file.size > MAX_FILE_BYTES) return 'This file is too big. The limit is 100 KB.';
    return null;
  }

  /** Returns null when the text fits the notes box, otherwise a short message. */
  function checkText(text) {
    if (Array.from(text).length > MAX_CHARACTERS) return 'This file is longer than ' + MAX_CHARACTERS + ' characters. Shorten it and try again.';
    return null;
  }

  root.KnowledgeFile = { check: check, checkText: checkText, MAX_FILE_BYTES: MAX_FILE_BYTES, MAX_CHARACTERS: MAX_CHARACTERS };

  var doc = root.document;
  if (!doc) return;
  var picker = doc.getElementById('knowledge-file');
  var target = doc.getElementById('knowledge-content');
  var status = doc.getElementById('knowledge-file-status');
  var wrapper = doc.querySelector('[data-knowledge-file]');
  if (!picker || !target || !status || !wrapper) return;
  wrapper.hidden = false;

  function show(message) {
    status.textContent = message;
  }

  picker.addEventListener('change', function () {
    var file = picker.files && picker.files[0];
    var problem = check(file);
    if (problem) return show(problem);
    var reader = new root.FileReader();
    reader.onload = function () {
      var text = String(reader.result || '');
      var tooLong = checkText(text);
      if (tooLong) return show(tooLong);
      target.value = text;
      target.dispatchEvent(new root.Event('input', { bubbles: true }));
      return show('File loaded. Read it, then press Save notes.');
    };
    reader.onerror = function () {
      show('This file could not be read.');
    };
    return reader.readAsText(file);
  });
})(typeof window !== 'undefined' ? window : globalThis);
