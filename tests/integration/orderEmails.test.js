import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PUBLIC_STRINGS } from '../../src/domain/publicStrings.js';
import { FORM, setup } from '../helpers/orderApp.js';

const UTR1 = '123456789012';
const UTR2 = '210987654321';
const OWNER_ACCOUNT_EMAIL = 'maker@example.com';
const MS_PER_MINUTE = 60_000;
const LANGUAGES = ['en', 'gu', 'hi'];
const HIGH = { windowMs: 60_000, limit: 1000 };
const HIGH_ORDER_LIMITS = { page: HIGH, create: HIGH, utr: HIGH, status: HIGH };
const countOf = (app, kind) => app.outbox.rows.filter((row) => row.kind === kind).length;
const kindsOf = (app) => app.outbox.rows.map((row) => row.kind);
const buyIn = (app, lang, form) => app.request(app.buyPath(app.product, `?lang=${lang}`), { method: 'POST', form });

describe('checkout email is required', () => {
  it('refuses an empty, missing or malformed email in every language, shows the localized error and places nothing', async () => {
    const app = await setup({ appOptions: { appDeps: { orderRateLimits: HIGH_ORDER_LIMITS } } });
    try {
      for (const lang of LANGUAGES) {
        for (const email of ['', '   ', 'nope', 'a@b']) {
          const res = await buyIn(app, lang, { ...FORM, email });
          assert.equal(res.status, 400, `${lang} ${JSON.stringify(email)}`);
          assert.ok(res.text.includes(PUBLIC_STRINGS[lang].errEmail), `${lang} error text`);
          assert.match(res.text, /id="email-error"/);
        }
        const { email: _omitted, ...withoutEmail } = FORM;
        assert.equal((await buyIn(app, lang, withoutEmail)).status, 400, `${lang} missing key`);
      }
      assert.equal(app.orderRepo.orders.length, 0);
      assert.equal(app.outbox.rows.length, 0);
    } finally {
      await app.close();
    }
  });

  it('shows a required, labelled email field with a hint and no "optional" marker in each language', async () => {
    const app = await setup();
    try {
      for (const lang of LANGUAGES) {
        const page = await app.request(app.buyPath(app.product, `?lang=${lang}`));
        assert.match(page.text, /<input type="email" id="email" name="email"[^>]*\srequired[^>]*aria-describedby="email-hint"/);
        assert.ok(page.text.includes(`<label for="email">${PUBLIC_STRINGS[lang].yourEmail}</label>`), lang);
        assert.ok(page.text.includes(PUBLIC_STRINGS[lang].emailHint), lang);
        assert.doesNotMatch(page.text, /class="optional"/);
      }
    } finally {
      await app.close();
    }
  });
});

describe('order emails are queued by the same step as each state change', () => {
  it('placing queues exactly one order_placed row, to the customer, in the order language, with the private link', async () => {
    const app = await setup();
    try {
      const res = await buyIn(app, 'gu', FORM);
      assert.equal(res.status, 303);
      const token = res.location.slice('/o/'.length);
      assert.deepEqual(kindsOf(app), ['order_placed']);
      const [row] = app.outbox.rows;
      assert.deepEqual([row.toEmail, row.language, row.storeId], ['buyer@example.test', 'gu', app.store.id]);
      assert.equal(app.linkCipher.decrypt(row.payload.token_enc), token);
      assert.ok(!JSON.stringify(row.payload).includes(token), 'the token itself is not in the payload');
      assert.ok(!JSON.stringify(app.orderRepo.orders[0]).includes(token), 'nor on the order row');
      assert.equal(row.payload.reference, 'AS1001');
      assert.equal(row.dedupeKey, `order_placed:${app.orderRepo.orders[0].id}`);
    } finally {
      await app.close();
    }
  });

  it('every transition queues its email exactly once, and repeating a step queues nothing more', async () => {
    const app = await setup();
    try {
      const token = await app.place();
      await app.postTo(token, 'utr', { utr: UTR1 });
      assert.equal(countOf(app, 'order_payment_received'), 1);
      assert.equal(countOf(app, 'seller_payment_submitted'), 1);
      await app.postTo(token, 'utr', { utr: UTR1 });
      assert.equal(countOf(app, 'order_payment_received'), 1, 'the same reference again');

      await app.ownerPost(token, 'not-received');
      await app.ownerPost(token, 'not-received');
      assert.equal(countOf(app, 'order_payment_not_found'), 1);

      await app.postTo(token, 'utr', { utr: UTR2 });
      assert.equal(countOf(app, 'order_payment_received'), 2, 'a second attempt gets its own email');
      assert.equal(countOf(app, 'seller_payment_submitted'), 2);

      await app.ownerPost(token, 'paid');
      await app.ownerPost(token, 'paid');
      assert.equal(countOf(app, 'order_confirmed'), 1);
      const customerRows = app.outbox.rows.filter((row) => !row.kind.startsWith('seller_'));
      assert.equal(customerRows.length, 5);
      for (const row of customerRows) assert.equal(app.linkCipher.decrypt(row.payload.token_enc), token, row.kind);
      assert.deepEqual(kindsOf(app), ['order_placed', 'order_payment_received', 'seller_payment_submitted', 'order_payment_not_found',
        'order_payment_received', 'seller_payment_submitted', 'order_confirmed']);
      assert.equal(new Set(app.outbox.rows.map((row) => row.dedupeKey)).size, app.outbox.rows.length);
    } finally {
      await app.close();
    }
  });

  it('the payment alert goes to the owner ACCOUNT email, in English, never to anything the customer typed', async () => {
    const app = await setup();
    try {
      const token = await app.place({ ...FORM, email: 'someone.else@example.test' });
      await app.postTo(token, 'utr', { utr: UTR1 });
      const alert = app.outbox.rows.find((row) => row.kind === 'seller_payment_submitted');
      assert.equal(alert.toEmail, OWNER_ACCOUNT_EMAIL);
      assert.equal(alert.language, 'en');
      assert.equal(app.linkCipher.decrypt(app.outbox.rows.find((row) => row.kind === 'order_payment_received').payload.token_enc), token);
      const extraKeys = await app.postTo(token, 'utr', { utr: UTR2, email: 'attacker@example.test', to: 'attacker@example.test' });
      assert.equal(extraKeys.status, 400, 'unknown form keys are rejected');
      assert.equal(app.outbox.rows.filter((row) => row.toEmail.includes('attacker')).length, 0);
    } finally {
      await app.close();
    }
  });

  it('a cancel by the customer or the owner queues one order_cancelled row; cancelling again queues nothing', async () => {
    const app = await setup();
    try {
      const byCustomer = await app.place();
      await app.postTo(byCustomer, 'cancel');
      await app.postTo(byCustomer, 'cancel');
      const byOwner = await app.place();
      await app.ownerPost(byOwner, 'cancel');
      await app.ownerPost(byOwner, 'cancel');
      assert.equal(countOf(app, 'order_cancelled'), 2);
      assert.equal(countOf(app, 'order_expired'), 0);
    } finally {
      await app.close();
    }
  });

  it('expiry queues one order_expired row wherever it is noticed: status page, owner list, or another customer placing', async () => {
    const app = await setup();
    try {
      const viaStatus = await app.place();
      app.orderClock.now += 11 * MS_PER_MINUTE;
      await app.status(viaStatus);
      await app.status(viaStatus);
      assert.equal(countOf(app, 'order_expired'), 1);

      await app.place();
      app.orderClock.now += 11 * MS_PER_MINUTE;
      await app.owner('/orders');
      assert.equal(countOf(app, 'order_expired'), 2);

      await app.place();
      app.orderClock.now += 11 * MS_PER_MINUTE;
      await app.place();
      assert.equal(countOf(app, 'order_expired'), 3);
      assert.equal(countOf(app, 'order_cancelled'), 0);
    } finally {
      await app.close();
    }
  });

  it('a late payment reference is refused and queues only the expiry email', async () => {
    const app = await setup();
    try {
      const token = await app.place();
      app.orderClock.now += 11 * MS_PER_MINUTE;
      await app.postTo(token, 'utr', { utr: UTR1 });
      assert.deepEqual(kindsOf(app), ['order_placed', 'order_expired']);
    } finally {
      await app.close();
    }
  });

  it('nothing is queued when the change fails', async () => {
    const app = await setup();
    try {
      app.product.stock = 1;
      assert.equal((await app.buy({ ...FORM, quantity: '2' })).status, 409);
      assert.equal((await app.buy({ ...FORM, phone: '123' })).status, 400);
      assert.equal(app.outbox.rows.length, 0, 'refused orders');

      const token = await app.place({ ...FORM, quantity: '1' });
      const before = app.outbox.rows.length;
      assert.equal((await app.postTo(token, 'utr', { utr: '12' })).status, 400);
      await app.ownerPost(token, 'paid');
      assert.equal(app.outbox.rows.length, before, 'a bad reference, and paid before any payment was submitted');

      await app.postTo(token, 'utr', { utr: UTR1 });
      const afterSubmit = app.outbox.rows.length;
      await app.postTo(token, 'cancel');
      assert.equal(app.outbox.rows.length, afterSubmit, 'a customer cannot cancel once the reference is submitted');
    } finally {
      await app.close();
    }
  });

  it('a reference reused in the same store is refused and queues nothing', async () => {
    const app = await setup();
    try {
      const first = await app.place({ ...FORM, quantity: '1' });
      const second = await app.place({ ...FORM, quantity: '1' });
      await app.postTo(first, 'utr', { utr: UTR1 });
      const before = app.outbox.rows.length;
      assert.equal((await app.postTo(second, 'utr', { utr: UTR1 })).status, 409);
      assert.equal(app.outbox.rows.length, before);
    } finally {
      await app.close();
    }
  });

  it('an order whose address cannot receive email still works; only the seller is told', async () => {
    const app = await setup();
    try {
      const token = await app.place();
      app.orderRepo.orders[0].customerEmail = null;
      app.outbox.rows.length = 0;
      await app.postTo(token, 'utr', { utr: UTR1 });
      assert.deepEqual(kindsOf(app), ['seller_payment_submitted']);
    } finally {
      await app.close();
    }
  });
});
