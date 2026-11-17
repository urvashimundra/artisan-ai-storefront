/* Customer chat: progressive enhancement. Without this script the page is a normal form post and a normal page load.
   Ordinary HTTP only (fetch, no WebSockets). Nothing is stored in the browser: the private link lives only in the address bar and the
   server-rendered page. Message text is always set with textContent, never as HTML. */
(function () {
  'use strict';

  var root = document.querySelector('[data-chat]');
  if (!root || !window.fetch || !window.URLSearchParams) return;

  var log = document.getElementById('chat-log');
  var list = document.getElementById('chat-messages');
  var typing = document.getElementById('chat-typing');
  var errorBox = document.getElementById('chat-error');
  var form = document.getElementById('composer');
  var field = document.getElementById('composer-text');
  var idField = form.querySelector('input[name="messageId"]');
  var sendButton = form.querySelector('button[type="submit"]');
  var statusText = root.querySelector('[data-chat-status]');
  var sellerBox = root.querySelector('[data-needs-seller]');
  var pollUrl = root.getAttribute('data-poll-url');
  var pollMs = Number(root.getAttribute('data-poll-ms')) || 3000;
  var lang = root.getAttribute('data-lang');
  var lastSeq = Number(root.getAttribute('data-last-seq')) || 0;
  var text = {
    sending: root.getAttribute('data-str-sending'),
    network: root.getAttribute('data-str-network'),
    retry: root.getAttribute('data-str-retry'),
    unknown: root.getAttribute('data-str-unknown'),
    sources: root.getAttribute('data-str-sources')
  };
  var SEND_TIMEOUT_MS = 75000;
  var MAX_FIELD_HEIGHT = 160;
  var sending = false;
  var refreshing = false;
  var timer = null;
  var pending = null;

  function newId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    var hex = Array.prototype.map.call(bytes, function (b) { return (b + 256).toString(16).slice(1); }).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }

  function element(tag, className, content) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }

  function atBottom() {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  }

  function scrollToEnd() {
    log.scrollTop = log.scrollHeight;
  }

  function showError(message) {
    errorBox.textContent = message || '';
    errorBox.hidden = !message;
  }

  function buildMessage(message) {
    var item = element('li', 'msg msg-' + message.role + (message.escalated ? ' msg-flag' : ''));
    item.setAttribute('data-seq', String(message.seq));
    item.setAttribute('data-role', message.role);
    var bubble = element('div', 'msg-bubble');
    bubble.appendChild(element('p', message.role === 'customer' ? 'visually-hidden' : 'msg-speaker', message.speaker));
    bubble.appendChild(element('p', 'msg-text', message.text));
    if (message.sources && message.sources.length) bubble.appendChild(element('p', 'msg-sources', text.sources + ': ' + message.sources.join(', ')));
    var meta = element('p', 'msg-meta');
    var time = element('time', '', message.timeLabel);
    time.setAttribute('datetime', message.time);
    meta.appendChild(time);
    bubble.appendChild(meta);
    item.appendChild(bubble);
    return item;
  }

  function removePending() {
    if (pending && pending.parentNode) pending.parentNode.removeChild(pending);
    pending = null;
  }

  function appendMessages(messages) {
    var stick = atBottom();
    messages.forEach(function (message) {
      if (message.seq <= lastSeq) return;
      if (message.role === 'customer') removePending();
      list.appendChild(buildMessage(message));
      lastSeq = message.seq;
    });
    if (messages.length && (stick || sending)) scrollToEnd();
  }

  function applyState(state) {
    typing.hidden = !(state.aiRunning || sending);
    if (statusText && state.statusLabel) statusText.textContent = state.statusLabel;
    if (sellerBox) sellerBox.hidden = !state.needsSeller;
  }

  function schedule(state) {
    window.clearTimeout(timer);
    if (state && state.aiRunning && !sending) timer = window.setTimeout(refresh, pollMs);
  }

  function refresh() {
    if (refreshing) return Promise.resolve();
    refreshing = true;
    var url = pollUrl + '?after=' + lastSeq + '&lang=' + encodeURIComponent(lang);
    return fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (state) {
        if (!state) return;
        appendMessages(state.messages);
        applyState(state);
        schedule(state);
      })
      .catch(function () {})
      .then(function () { refreshing = false; });
  }

  function setSending(on) {
    sending = on;
    sendButton.disabled = on;
    sendButton.setAttribute('aria-busy', on ? 'true' : 'false');
    sendButton.querySelector('.composer-send-label').textContent = on ? text.sending : sendButton.getAttribute('data-label');
    if (on) typing.hidden = false;
  }

  function markFailed(failure) {
    if (!pending) return;
    pending.classList.remove('msg-pending');
    pending.classList.add('msg-failed');
    var retry = element('button', 'msg-retry', text.retry);
    retry.type = 'button';
    retry.addEventListener('click', function () {
      removePending();
      submit(failure.text, failure.id);
    });
    pending.querySelector('.msg-bubble').appendChild(retry);
    showError(failure.error);
  }

  function addPending(body) {
    var item = buildMessage({ seq: lastSeq + 0.5, role: 'customer', speaker: '', text: body, time: new Date().toISOString(), timeLabel: '…', sources: [] });
    item.classList.add('msg-pending');
    item.removeAttribute('data-seq');
    list.appendChild(item);
    pending = item;
    scrollToEnd();
  }

  function submit(body, id) {
    if (sending || !body) return;
    showError('');
    setSending(true);
    addPending(body);
    var controller = window.AbortController ? new AbortController() : null;
    var abort = controller ? window.setTimeout(function () { controller.abort(); }, SEND_TIMEOUT_MS) : null;
    var payload = new URLSearchParams({ message: body, messageId: id });
    var failure = { text: body, id: id, error: text.network };
    fetch(form.action, {
      method: 'POST', body: payload, credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: controller ? controller.signal : undefined
    })
      .then(function (response) { return response.json().then(function (data) { return { status: response.status, data: data }; }); })
      .then(function (result) { return handleResult(result, failure); })
      .catch(function () { markFailed(failure); })
      .then(function () {
        if (abort) window.clearTimeout(abort);
        setSending(false);
        return refresh();
      });
  }

  function handleResult(result, failure) {
    var data = result.data || {};
    if (data.saved) {
      idField.value = newId();
      field.value = '';
      grow();
      return null;
    }
    if (data.code === 'UNCONFIRMED') {
      failure.error = data.text || text.unknown;
      markFailed(failure);
      return null;
    }
    removePending();
    field.value = failure.text;
    grow();
    idField.value = data.code === 'PERSISTENCE_FAILED' ? failure.id : newId();
    showError(data.text || text.unknown);
    return null;
  }

  function grow() {
    field.style.height = 'auto';
    field.style.height = Math.min(field.scrollHeight, MAX_FIELD_HEIGHT) + 'px';
  }

  sendButton.setAttribute('data-label', sendButton.querySelector('.composer-send-label').textContent);

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var body = field.value.trim();
    if (!body) return;
    var id = idField.value;
    field.value = '';
    grow();
    submit(body, id);
  });

  field.addEventListener('input', grow);
  field.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (form.requestSubmit) form.requestSubmit();
    }
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') refresh();
  });
  window.addEventListener('focus', refresh);

  scrollToEnd();
  grow();
  refresh();
})();
