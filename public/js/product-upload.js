/* New-product page: shrinks the photo in the browser with resize.js (long side 1200 px, JPEG; re-encoding strips EXIF and
   GPS data), uploads it as raw bytes, then posts the story to the generate route. If resizing is unavailable or fails,
   the original file is uploaded unchanged and the server validates it. */
(function () {
  var MAX_BYTES = 4 * 1024 * 1024;
  var MAX_STORY = 1500;
  var ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];
  var form = document.getElementById('new-product-form');
  if (!form) return;
  var fileInput = document.getElementById('photo');
  var storyInput = document.getElementById('story');
  var button = document.getElementById('submit-button');
  var progress = document.getElementById('progress');
  var formError = document.getElementById('form-error');
  formError.tabIndex = -1;

  function show(element, text) {
    element.textContent = text;
    element.hidden = false;
  }

  function clearMessages() {
    ['photo-error', 'story-error', 'form-error', 'progress'].forEach(function (id) {
      var element = document.getElementById(id);
      element.hidden = true;
      element.textContent = '';
    });
    fileInput.removeAttribute('aria-invalid');
    storyInput.removeAttribute('aria-invalid');
  }

  function reject(field, id, message) {
    field.setAttribute('aria-invalid', 'true');
    show(document.getElementById(id), message);
    field.focus();
    return null;
  }

  function validate() {
    var file = fileInput.files && fileInput.files[0];
    if (!file) return reject(fileInput, 'photo-error', 'Please choose a photo.');
    if (ALLOWED.indexOf(file.type) === -1) return reject(fileInput, 'photo-error', 'Please choose a JPEG, PNG or WebP photo.');
    var story = storyInput.value.trim();
    if (!story || Array.from(story).length > MAX_STORY) {
      return reject(storyInput, 'story-error', 'Write a few sentences about the product, up to ' + MAX_STORY + ' characters.');
    }
    return { file: file, story: story };
  }

  function prepare(file) {
    var resizer = window.ArtisanResize;
    if (!resizer) return Promise.resolve(file);
    return resizer.resizeToJpeg(file).catch(function () { return file; });
  }

  function upload(blob) {
    if (blob.size > MAX_BYTES) return Promise.reject(new Error('too-large'));
    return fetch(form.getAttribute('data-upload-url'), {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'application/octet-stream', Accept: 'application/json' },
      body: blob,
      credentials: 'same-origin',
    }).then(function (response) {
      if (response.redirected) throw new Error('login');
      return response.json().then(function (data) {
        if (!response.ok) throw new Error((data && data.error && data.error.message) || 'upload');
        return data;
      });
    });
  }

  function postGenerate(url, story) {
    var next = document.createElement('form');
    next.method = 'post';
    next.action = url;
    var field = document.createElement('input');
    field.type = 'hidden';
    field.name = 'story';
    field.value = story;
    next.appendChild(field);
    document.body.appendChild(next);
    next.submit();
  }

  function friendly(error) {
    if (error.message === 'login') return 'Your session has ended. Please log in again.';
    if (error.message === 'too-large') return 'That photo is too large. Please choose a smaller one.';
    return error.message && error.message.length < 200 ? error.message : 'Something went wrong. Please try again.';
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    clearMessages();
    var input = validate();
    if (!input) return;
    button.disabled = true;
    show(progress, 'Preparing your photo...');
    prepare(input.file)
      .then(function (blob) {
        show(progress, 'Uploading your photo...');
        return upload(blob);
      })
      .then(function (data) {
        show(progress, 'The AI is writing your listing. This can take up to a minute. Please keep this page open.');
        postGenerate(data.generateUrl, input.story);
      })
      .catch(function (error) {
        button.disabled = false;
        progress.hidden = true;
        show(formError, friendly(error));
        formError.focus();
      });
  });
})();
