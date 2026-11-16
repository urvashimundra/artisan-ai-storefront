import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { ORDER_EXPIRY_MINUTES, ORDER_RESUBMIT_MINUTES, isPastDeadline, reservationDeadline, secondsUntil } from '../../src/domain/orderRules.js';
import { ORDER_STRINGS } from '../../src/domain/orderStrings.js';
import { buildStatusView } from '../../src/services/orderService.js';

const read = (relative) => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8');
const NOW = Date.parse('2026-11-16T10:00:00Z');
const MINUTE = 60_000;
const migration = read('db/migrations/009_order_reservation_10min.sql');
const code = migration.replace(/--.*$/gm, '');

describe('deadline helpers', () => {
  it('uses a 10 minute reservation and keeps the 1 hour window only for not_received', () => {
    assert.equal(ORDER_EXPIRY_MINUTES, 10);
    assert.equal(ORDER_RESUBMIT_MINUTES, 60);
  });

  it('secondsUntil counts up to the deadline, rounds up, never goes negative and tolerates bad input', () => {
    assert.equal(secondsUntil(new Date(NOW + 10 * MINUTE).toISOString(), NOW), 600);
    assert.equal(secondsUntil(new Date(NOW + 1).toISOString(), NOW), 1);
    assert.equal(secondsUntil(new Date(NOW).toISOString(), NOW), 0);
    assert.equal(secondsUntil(new Date(NOW - 5 * MINUTE).toISOString(), NOW), 0);
    assert.equal(secondsUntil(null, NOW), null);
    assert.equal(secondsUntil('not a date', NOW), null);
  });

  it('treats the same instant written in UTC and in India time (+05:30) identically', () => {
    assert.equal(secondsUntil('2026-11-16T10:10:00Z', NOW), secondsUntil('2026-11-16T15:40:00+05:30', NOW));
    assert.equal(secondsUntil('2026-11-16T10:10:00.000+00:00', NOW), 600);
  });

  it('reservationDeadline is created_at plus exactly 10 minutes (the legacy order rule)', () => {
    assert.equal(reservationDeadline('2026-11-16T09:00:00Z'), '2026-11-16T09:10:00.000Z');
  });

  it('isPastDeadline only applies to orders still waiting for payment', () => {
    const past = new Date(NOW - 1000).toISOString();
    assert.equal(isPastDeadline({ status: 'awaiting_payment', expiresAt: past }, NOW), true);
    assert.equal(isPastDeadline({ status: 'not_received', expiresAt: past }, NOW), true);
    assert.equal(isPastDeadline({ status: 'awaiting_payment', expiresAt: new Date(NOW + 1000).toISOString() }, NOW), false);
    for (const status of ['payment_submitted', 'paid', 'cancelled']) assert.equal(isPastDeadline({ status, expiresAt: past }, NOW), false, status);
    assert.equal(isPastDeadline({ status: 'payment_submitted', expiresAt: null }, NOW), false);
  });
});

const baseOrder = (overrides) => ({
  reference: 'AS1001', status: 'awaiting_payment', cancelReason: null, payeeVpa: 'clay@okbank', totalPaise: 50000, utr: null, utrSubmissions: 0,
  expiresAt: new Date(NOW + 4 * MINUTE).toISOString(), items: [{ title: 'Diya', titleLang: 'en', quantity: 2, unitPricePaise: 25000, lineTotalPaise: 50000 }],
  shop: { name: 'Clay', slug: 'clay', defaultLanguage: 'en', accentKey: 'terracotta', whatsappNumber: null, whatsappEnabled: false }, ...overrides,
});
const view = (order, language = 'en', nowMs = NOW) => buildStatusView({ order, language, statusPath: '/o/x', nowMs });

describe('status view and the server deadline', () => {
  it('counts down from the server clock and refreshing gives the server remaining time again', () => {
    assert.equal(view(baseOrder()).order.countdown.secondsLeft, 240);
    assert.equal(view(baseOrder(), 'en', NOW + 3 * MINUTE).order.countdown.secondsLeft, 60);
  });

  it('shows an order past its deadline as expired even though the stored status was not swept yet', () => {
    const stale = view(baseOrder({ expiresAt: new Date(NOW - 1000).toISOString() }));
    assert.equal(stale.order.expired, true);
    assert.equal(stale.order.status, 'cancelled');
    assert.equal(stale.order.canSubmitUtr, false);
    assert.equal(stale.order.canCancel, false);
    assert.equal(stale.order.countdown, null);
    assert.equal(stale.payment, null);
    assert.equal(stale.order.help, ORDER_STRINGS.en.cancelledExpired);
  });

  it('a submitted order has no countdown and keeps showing it is reserved', () => {
    const submitted = view(baseOrder({ status: 'payment_submitted', utr: '123456789012', utrSubmissions: 1, expiresAt: null }));
    assert.equal(submitted.order.countdown, null);
    assert.equal(submitted.order.canSubmitUtr, false);
    assert.equal(submitted.order.help, ORDER_STRINGS.en.reservationHeld);
  });

  it('the reservation note names 10 minutes in every language', () => {
    for (const language of ['en', 'gu', 'hi']) assert.ok(view(baseOrder(), language).order.reservationNote.includes('10'), language);
  });
});

describe('new strings', () => {
  const KEYS = ['timeLeftLabel', 'reservationNote', 'reservationReleased', 'reservationHeld', 'countdownChecking', 'countdownExpired', 'countdownMinuteLeft',
    'checkoutReservationNote', 'stockAvailable', 'yourDetails', 'addressHint'];

  it('exist in en, gu and hi with the same placeholders', () => {
    for (const key of KEYS) {
      const placeholders = (language) => (ORDER_STRINGS[language][key].match(/\{\w+\}/g) ?? []).sort().join();
      for (const language of ['gu', 'hi']) {
        assert.ok(ORDER_STRINGS[language][key]?.length > 0, `${language}.${key}`);
        assert.equal(placeholders(language), placeholders('en'), `${language}.${key}`);
      }
    }
  });
});

function runCountdown(secondsLeft) {
  const attrs = { 'data-seconds-left': String(secondsLeft), 'data-status-url': '/o/token', 'data-expired-text': 'Time is up', 'data-checking-text': 'Checking', 'data-minute-text': 'One minute' };
  const display = { textContent: '' };
  const live = { textContent: '' };
  const box = { getAttribute: (name) => attrs[name], querySelector: (selector) => (selector === '[data-countdown-time]' ? display : live) };
  let now = 0;
  const timers = [];
  const state = { assigned: null };
  const context = {
    document: { querySelector: () => box },
    performance: { now: () => now },
    window: { setTimeout: (fn, ms) => timers.push({ fn, at: now + ms }), location: { assign: (url) => { state.assigned = url; } } },
    parseInt,
    isNaN,
    Math,
    String,
  };
  vm.runInNewContext(read('public/js/countdown.js'), context);
  const advance = (ms) => {
    const target = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      if (!timers.length || timers[0].at > target) break;
      const next = timers.shift();
      now = next.at;
      next.fn();
    }
    now = target;
  };
  return { display, live, state, advance };
}

describe('countdown.js (display only)', () => {
  it('starts from the seconds the server sent and ticks down once a second', () => {
    const page = runCountdown(125);
    assert.equal(page.display.textContent, '02:05');
    page.advance(5000);
    assert.equal(page.display.textContent, '02:00');
  });

  it('announces one minute left, then at zero shows the expired text and asks the SERVER again by loading the status page', () => {
    const page = runCountdown(61);
    page.advance(1000);
    assert.equal(page.live.textContent, 'One minute');
    page.advance(60_000);
    assert.equal(page.display.textContent, 'Time is up');
    assert.equal(page.live.textContent, 'Checking');
    assert.equal(page.state.assigned, null);
    page.advance(2000);
    assert.equal(page.state.assigned, '/o/token');
  });

  it('never reads the browser clock for validity and never posts, stores or fetches anything', () => {
    const script = read('public/js/countdown.js');
    assert.doesNotMatch(script, /Date\.now|new Date|fetch|XMLHttpRequest|localStorage|sessionStorage|\.submit\(|\.disabled|\.hidden/);
  });
});

describe('migration 009 text', () => {
  it('sets the awaiting_payment window to 10 minutes and the not_received window to 1 hour', () => {
    assert.match(code, new RegExp(`order_expiry_interval\\(\\) RETURNS interval[\\s\\S]*?interval '${ORDER_EXPIRY_MINUTES} minutes'`));
    assert.match(code, new RegExp(`order_resubmit_interval\\(\\) RETURNS interval[\\s\\S]*?interval '${ORDER_RESUBMIT_MINUTES / 60} hour'`));
    assert.match(code, /expires_at = now\(\) \+ public\.order_resubmit_interval\(\)/);
  });

  it('is forward-only: it creates or replaces and never drops, truncates or deletes', () => {
    assert.doesNotMatch(code, /\bDROP\b|\bTRUNCATE\b|\bDELETE\b/i);
    assert.doesNotMatch(code, /pg_cron|cron\.schedule/i);
  });

  it('backfills legacy awaiting_payment orders to created_at + 10 minutes and only moves deadlines earlier', () => {
    assert.match(code, /SET expires_at = created_at \+ public\.order_expiry_interval\(\)[\s\S]*status = 'awaiting_payment' AND expires_at > created_at \+ public\.order_expiry_interval\(\)/);
  });

  it('pins search_path, revokes from public, anon and authenticated, and grants to service_role only', () => {
    for (const name of ['order_expiry_interval', 'order_resubmit_interval', 'resolve_payment']) {
      assert.match(code, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?SET search_path = public, pg_temp`), name);
      assert.match(code, new RegExp(`REVOKE EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`), name);
      assert.match(code, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) TO service_role;`), name);
    }
    assert.doesNotMatch(code, /GRANT EXECUTE[^;]*(PUBLIC|anon|authenticated)/);
  });

  it('leaves the 008 migration untouched in meaning (still 1 hour there) and its smoke test window-agnostic', () => {
    assert.match(read('db/migrations/008_orders.sql'), /SELECT interval '1 hour'/);
    assert.match(read('db/test/008_orders_smoke.sql'), /order_expiry_interval\(\)/);
  });

  it('ships verify, smoke and race scripts covering the required scenarios', () => {
    const verify = read('db/verify/009_order_reservation_checks.sql');
    const smoke = read('db/test/009_order_reservation_smoke.sql');
    const races = read('db/test/009_order_reservation_races.sql');
    assert.ok(verify.includes('order_resubmit_interval') && verify.includes('relrowsecurity') && verify.includes('has_function_privilege'));
    for (const phrase of ['UTR at 9 minutes is accepted', 'UTR after 10 minutes is rejected without a sweep', 'a second sweep restores nothing', 'unlimited stock stays NULL',
      'second buyer is refused', 'cannot be marked paid', 'legacy order', 'stock never goes negative', 'ALL CHECKS PASSED']) {
      assert.ok(smoke.includes(phrase), phrase);
    }
    for (const marker of ['EXPIRY vs LATE UTR', 'LATE UTR first, then EXPIRY', 'EXPIRY vs NEW ORDER', 'TWO BUYERS, ONE UNIT']) assert.ok(races.includes(marker), marker);
  });
});
