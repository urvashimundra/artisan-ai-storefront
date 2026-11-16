/* Payment countdown on the private order page. DISPLAY ONLY: the server decides whether an order is still valid.
   The server sends the seconds left (computed on its own clock), so the visitor's clock cannot make the timer wrong, and a
   refresh always starts again from the server's answer. At zero the page asks the server again (a GET of the status page);
   it never decides locally that the order expired and never changes the form. */
(function () {
  'use strict';

  var MS = 1000;
  var RELOAD_DELAY_MS = 1500;
  var SECONDS_PER_MINUTE = 60;
  var box = document.querySelector('[data-countdown]');
  if (!box) return;
  var display = box.querySelector('[data-countdown-time]');
  var live = box.querySelector('[data-countdown-live]');
  var left = parseInt(box.getAttribute('data-seconds-left'), 10);
  if (!display || isNaN(left)) return;
  var endsAt = performance.now() + left * MS;
  var warned = false;

  function pad(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function render(seconds) {
    display.textContent = pad(Math.floor(seconds / SECONDS_PER_MINUTE)) + ':' + pad(seconds % SECONDS_PER_MINUTE);
  }

  function finish() {
    display.textContent = box.getAttribute('data-expired-text');
    if (live) live.textContent = box.getAttribute('data-checking-text');
    window.setTimeout(function () {
      window.location.assign(box.getAttribute('data-status-url'));
    }, RELOAD_DELAY_MS);
  }

  function tick() {
    var seconds = Math.max(0, Math.ceil((endsAt - performance.now()) / MS));
    render(seconds);
    if (seconds === SECONDS_PER_MINUTE && !warned && live) {
      warned = true;
      live.textContent = box.getAttribute('data-minute-text');
    }
    if (seconds === 0) return finish();
    return window.setTimeout(tick, MS);
  }

  tick();
})();
