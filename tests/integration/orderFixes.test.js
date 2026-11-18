import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderEmail } from '../../src/domain/emailTemplates.js';
import { MAX_UTR_SUBMISSIONS, ORDER_EXPIRY_MINUTES, ORDER_RESUBMIT_MINUTES, holdMinutes } from '../../src/domain/orderRules.js';
import { PUBLIC_STRINGS } from '../../src/domain/publicStrings.js';
import { FORM, setup } from '../helpers/orderApp.js';

const UTRS = ['123456789012', '210987654321', '111111111111'];
const LANGUAGES = ['en', 'gu', 'hi'];
const EVIL_ORIGIN = 'http://evil.example';
const HIGH = { windowMs: 60_000, limit: 1000 };
const OPTIONS = { appOptions: { appDeps: { orderRateLimits: { page: HIGH, create: HIGH, utr: HIGH, status: HIGH } } } };
const countOf = (app, kind) => app.outbox.rows.filter((row) => row.kind === kind).length;
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => values[key]);
const escaped = (text) => text.replaceAll("'", '&#39;');

async function submitAndReject(app, token, utrs) {
  for (const utr of utrs) {
    assert.equal((await app.postTo(token, 'utr', { utr })).status, 303);
    assert.equal((await app.ownerPost(token, 'not-received')).status, 303);
  }
}

describe('O1: the third rejected payment reference cancels the order', () => {
  it('cancels in the same step, restores stock once, queues one email, and stays idempotent', async () => {
    const app = await setup(OPTIONS);
    try {
      const token = await app.place();
      await submitAndReject(app, token, UTRS.slice(0, 2));
      assert.equal(app.orderRepo.orders[0].status, 'not_received');
      assert.equal(countOf(app, 'order_payment_not_found'), 2);
      await submitAndReject(app, token, UTRS.slice(2));
      const [order] = app.orderRepo.orders;
      assert.equal(order.status, 'cancelled');
      assert.equal(order.cancelReason, 'utr_attempts_exhausted');
      assert.equal(app.product.stock, 5);
      assert.equal(countOf(app, 'order_payment_not_found'), 2);
      assert.equal(countOf(app, 'order_cancelled'), 1);
      assert.equal(app.outbox.rows.find((row) => row.kind === 'order_cancelled').payload.cancel_reason, 'utr_attempts_exhausted');
      assert.equal((await app.ownerPost(token, 'not-received')).status, 303);
      assert.equal(app.product.stock, 5);
      assert.equal(countOf(app, 'order_cancelled'), 1);
    } finally {
      await app.close();
    }
  });

  it('shows the customer a clear message and a link to the shop in every language', async () => {
    const app = await setup(OPTIONS);
    try {
      const token = await app.place();
      await submitAndReject(app, token, UTRS);
      for (const lang of LANGUAGES) {
        const page = await app.request(`/o/${token}?lang=${lang}`);
        const strings = PUBLIC_STRINGS[lang];
        assert.ok(page.text.includes(fill(strings.cancelledUtrExhausted, { attempts: String(MAX_UTR_SUBMISSIONS) })), lang);
        assert.match(page.text, new RegExp(`href="/s/${app.shop.slug}[^"]*"[^>]*>${strings.visitShop}`));
        assert.equal(page.text.includes('name="utr"'), false);
      }
    } finally {
      await app.close();
    }
  });

  it('writes reason-specific cancellation emails in each language', () => {
    const facts = { reference: 'AS1001', shop: 'Clay', slug: 'clay', cancel_reason: 'utr_attempts_exhausted' };
    const texts = LANGUAGES.map((language) => renderEmail({ kind: 'order_cancelled', language, facts, baseUrl: 'https://example.test' }).text);
    for (const text of texts) assert.ok(text.includes(String(MAX_UTR_SUBMISSIONS)));
    assert.equal(new Set(texts).size, LANGUAGES.length);
    const plain = renderEmail({ kind: 'order_cancelled', language: 'en', facts: { ...facts, cancel_reason: 'owner' }, baseUrl: 'https://example.test' }).text;
    assert.equal(plain.includes('could not be verified'), false);
  });

  it('warns the seller on the third attempt only', async () => {
    const app = await setup(OPTIONS);
    try {
      const token = await app.place();
      await submitAndReject(app, token, UTRS.slice(0, 2));
      await app.postTo(token, 'utr', { utr: UTRS[2] });
      const third = await app.owner(`/orders/${app.orderIdOf(token)}`);
      assert.ok(third.text.includes('will cancel this order'));
      assert.ok(third.text.includes('will CANCEL this order'));
      const other = await app.place();
      await app.postTo(other, 'utr', { utr: '999999999999' });
      const first = await app.owner(`/orders/${app.orderIdOf(other)}`);
      assert.equal(first.text.includes('will cancel this order'), false);
      assert.ok(first.text.includes('Payment not received'));
    } finally {
      await app.close();
    }
  });
});

describe('O2: cancelling asks twice', () => {
  it('customer: GET only shows the question, POST cancels once, repeats are harmless', async () => {
    const app = await setup(OPTIONS);
    try {
      const token = await app.place();
      const status = await app.status(token);
      assert.ok(status.text.includes(`href="/o/${token}/cancel"`));
      assert.equal(status.text.includes(`action="/o/${token}/cancel"`), false);
      for (const lang of LANGUAGES) {
        const page = await app.request(`/o/${token}/cancel?lang=${lang}`);
        const strings = PUBLIC_STRINGS[lang];
        assert.equal(page.status, 200);
        for (const key of ['cancelConfirmTitle', 'cancelConfirmBody', 'cancelConfirmYes', 'cancelConfirmNo']) assert.ok(page.text.includes(escaped(strings[key])), `${lang} ${key}`);
        assert.ok(page.text.includes(`action="/o/${token}/cancel"`));
      }
      assert.equal(app.orderRepo.orders[0].status, 'awaiting_payment');
      assert.equal((await app.postTo(token, 'cancel', {}, { origin: EVIL_ORIGIN })).status, 403);
      assert.equal(app.orderRepo.orders[0].status, 'awaiting_payment');
      assert.equal((await app.postTo(token, 'cancel')).status, 303);
      assert.equal((await app.postTo(token, 'cancel')).status, 303);
      assert.equal(app.product.stock, 5);
      assert.equal(countOf(app, 'order_cancelled'), 1);
      assert.equal((await app.request(`/o/${token}/cancel`)).status, 303);
      assert.equal((await app.request('/o/not-a-token/cancel')).status, 404);
    } finally {
      await app.close();
    }
  });

  it('seller: GET only shows the question, POST cancels once, repeats are harmless', async () => {
    const app = await setup(OPTIONS);
    try {
      const token = await app.place();
      const id = app.orderIdOf(token);
      const detail = await app.owner(`/orders/${id}`);
      assert.equal(detail.text.includes(`action="/orders/${id}/cancel"`), false);
      const page = await app.owner(`/orders/${id}/cancel`);
      assert.equal(page.status, 200);
      for (const text of ['Cancel this order?', 'Yes, cancel order', 'No, keep it']) assert.ok(page.text.includes(text), text);
      assert.equal(app.orderRepo.orders[0].status, 'awaiting_payment');
      assert.equal((await app.owner(`/orders/${id}/cancel`, { method: 'POST', origin: EVIL_ORIGIN })).status, 403);
      assert.equal((await app.ownerPost(token, 'cancel')).status, 303);
      assert.equal((await app.ownerPost(token, 'cancel')).status, 303);
      assert.equal(app.product.stock, 5);
      assert.equal((await app.owner(`/orders/${id}/cancel`)).status, 303);
    } finally {
      await app.close();
    }
  });
});

describe('O3: the help text matches the real hold time', () => {
  it('derives the minutes from the status and the constants', () => {
    assert.equal(holdMinutes('awaiting_payment'), ORDER_EXPIRY_MINUTES);
    assert.equal(holdMinutes('not_received'), ORDER_RESUBMIT_MINUTES);
  });

  it('shows 10 minutes while awaiting payment, 60 after not received, and no hold note for other statuses', async () => {
    const app = await setup(OPTIONS);
    try {
      const token = await app.place();
      const awaiting = await app.status(token);
      assert.ok(awaiting.text.includes(`held for you for ${ORDER_EXPIRY_MINUTES} minutes`));
      await app.postTo(token, 'utr', { utr: UTRS[0] });
      const submitted = await app.status(token);
      assert.equal(submitted.text.includes('data-countdown'), false);
      assert.equal(submitted.text.includes('minutes. Send your UTR'), false);
      await app.ownerPost(token, 'not-received');
      const rejected = await app.status(token);
      assert.ok(rejected.text.includes(`held for you for ${ORDER_RESUBMIT_MINUTES} minutes`));
      assert.equal(rejected.text.includes(`for ${ORDER_EXPIRY_MINUTES} minutes`), false);
      assert.match(rejected.text, new RegExp(`data-seconds-left="${ORDER_RESUBMIT_MINUTES * 60}"`));
      await app.ownerPost(token, 'cancel');
      assert.equal((await app.status(token)).text.includes('minutes. Send your UTR'), false);
      const paidToken = await app.place();
      await app.postTo(paidToken, 'utr', { utr: UTRS[1] });
      await app.ownerPost(paidToken, 'paid');
      assert.equal((await app.status(paidToken)).text.includes('minutes. Send your UTR'), false);
    } finally {
      await app.close();
    }
  });
});

describe('O4: names accept Indic scripts and reject digits and symbols', () => {
  const good = ['Asha Patel', 'આશા પટેલ', 'आशा पटेल', "O'Brien-Smith Jr.", 'Anne’s Jo', 'Ab'];
  const bad = ['A', '', '   ', 'Test 123', '<script>', 'Asha_Patel', 'A.', '12', 'Asha@Patel', 'x'.repeat(81), '- -'];

  it('checkout: accepts the good names and shows the localized field error for the bad ones', async () => {
    const app = await setup(OPTIONS);
    try {
      app.product.stock = null;
      for (const name of good) assert.equal((await app.buy({ ...FORM, name })).status, 303, name);
      for (const lang of LANGUAGES) {
        for (const name of bad) {
          const res = await app.request(app.buyPath(app.product, `?lang=${lang}`), { method: 'POST', form: { ...FORM, name } });
          assert.equal(res.status, 400, `${lang} ${name}`);
          assert.ok(res.text.includes(escaped(PUBLIC_STRINGS[lang].errName)), `${lang} ${name}`);
        }
      }
    } finally {
      await app.close();
    }
  });
});
