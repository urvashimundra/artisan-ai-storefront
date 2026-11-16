import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PUBLIC_STRINGS } from '../../src/domain/publicStrings.js';
import { hashStatusToken } from '../../src/lib/statusToken.js';
import { STORE_FORM, signupAndLogin } from '../helpers/appHarness.js';
import { startOrderApp } from '../helpers/orderFakes.js';

const EN = PUBLIC_STRINGS.en;
const GU = PUBLIC_STRINGS.gu;
const FORM = { quantity: '2', name: 'Test Buyer', phone: '98765 43210', email: '', address: '12 Test Lane, Ahmedabad' };
const UTR1 = '123456789012';
const UTR2 = '210987654321';
const UTR3 = '111111111111';
const UTR4 = '222222222222';
const EVIL_ORIGIN = 'http://evil.example';
const OWNER_PRIVACY = ['Test Buyer', '919876543210', '98765 43210', 'test-address-line'];

/** An app with one owner (logged in), one shop with a UPI ID and WhatsApp, and one product (stock 5, Rs 250). */
async function setup(options = {}) {
  const app = await startOrderApp(options);
  const cookie = await signupAndLogin(app);
  await app.request('/store/new', { method: 'POST', cookie, form: STORE_FORM });
  const store = app.storesRepo.rows[0];
  const shop = app.repo.addShop({
    id: store.id, ownerId: store.ownerId, slug: store.slug, name: store.name, defaultLanguage: 'en', upiId: 'clay@okbank',
    whatsappNumber: '919123456780', whatsappEnabled: true, ...options.shop,
  });
  const product = app.repo.addProduct(shop, { pricePaise: 25000, stock: 5 });
  const buyPath = (target = product, query = '') => `/s/${shop.slug}/p/${target.id}/buy${query}`;
  const buy = (form = FORM, extra = {}) => app.request(buyPath(), { method: 'POST', form, ...extra });
  const place = async (form = FORM) => {
    const res = await buy(form);
    assert.equal(res.status, 303, res.text.slice(0, 200));
    return res.location.slice('/o/'.length);
  };
  const status = (token, extra = {}) => app.request(`/o/${token}`, extra);
  const postTo = (token, action, form = {}, extra = {}) => app.request(`/o/${token}/${action}`, { method: 'POST', form, ...extra });
  const orderIdOf = (token) => app.orderRepo.orders.find((o) => o.tokenHash === hashStatusToken(token)).id;
  const owner = (path, extra = {}) => app.request(path, { cookie, ...extra });
  const ownerPost = (token, action) => owner(`/orders/${orderIdOf(token)}/${action}`, { method: 'POST' });
  return { ...app, cookie, store, shop, product, buyPath, buy, place, status, postTo, orderIdOf, owner, ownerPost };
}

describe('buy now and placing an order', () => {
  it('shows Buy now only when the store has a valid UPI ID and the product is in stock', async () => {
    const app = await setup();
    try {
      const page = await app.request(`/s/${app.shop.slug}/p/${app.product.id}`);
      assert.match(page.text, new RegExp(`href="/s/${app.shop.slug}/p/${app.product.id}/buy\\?lang=en"`));
      assert.ok(page.text.includes(EN.buyNow));
      app.shop.upiId = null;
      assert.equal((await app.request(`/s/${app.shop.slug}/p/${app.product.id}`)).text.includes(EN.buyNow), false);
      assert.equal((await app.request(app.buyPath())).status, 404);
      app.shop.upiId = 'not a vpa';
      assert.equal((await app.request(app.buyPath())).status, 404);
      app.shop.upiId = 'clay@okbank';
      app.product.stock = 0;
      assert.equal((await app.request(`/s/${app.shop.slug}/p/${app.product.id}`)).text.includes(EN.buyNow), false);
    } finally {
      await app.close();
    }
  });

  it('places one order: server-side price, per-store reference, stock reserved, token stored only as a hash', async () => {
    const app = await setup();
    try {
      const res = await app.buy();
      assert.equal(res.status, 303);
      assert.match(res.location, /^\/o\/[A-Za-z0-9_-]{43}$/);
      const token = res.location.slice(3);
      const [order] = app.orderRepo.orders;
      assert.equal(order.reference, 'AS1001');
      assert.equal(order.totalPaise, 50000);
      assert.equal(order.payeeVpa, 'clay@okbank');
      assert.equal(order.customerPhone, '919876543210');
      assert.deepEqual(order.items.map((i) => [i.title, i.quantity, i.unitPricePaise, i.lineTotalPaise]), [['Clay diya', 2, 25000, 50000]]);
      assert.equal(app.product.stock, 3);
      assert.equal(order.tokenHash, hashStatusToken(token));
      assert.equal(JSON.stringify(app.orderRepo.orders).includes(token), false);
      assert.equal((await app.place()).length, 43);
      assert.equal(app.orderRepo.orders[1].reference, 'AS1002');
    } finally {
      await app.close();
    }
  });

  it('rejects client-supplied price, store_id, title, vpa, total, status and owner (nothing is created)', async () => {
    const app = await setup();
    try {
      for (const key of ['price', 'store_id', 'title', 'vpa', 'upi_id', 'total', 'status', 'owner_id', 'product_id']) {
        const res = await app.buy({ ...FORM, [key]: 'x' });
        assert.equal(res.status, 400, key);
      }
      assert.equal(app.orderRepo.orders.length, 0);
      assert.equal(app.product.stock, 5);
    } finally {
      await app.close();
    }
  });

  it('enforces quantity 1 to 20, stock, and shows the pointer for more than 20', async () => {
    const app = await setup();
    try {
      for (const quantity of ['0', '21', '-1', '1.5', 'abc', '']) assert.equal((await app.buy({ ...FORM, quantity })).status, 400, quantity);
      const tooMany = await app.buy({ ...FORM, quantity: '6' });
      assert.equal(tooMany.status, 409);
      assert.ok(tooMany.text.includes(EN.errOutOfStock));
      const checkout = (await app.request(app.buyPath())).text;
      assert.ok(checkout.includes('Only 5 available.') && !checkout.includes('coming soon'));
      assert.equal(app.product.stock, 5);
      assert.equal((await app.buy({ ...FORM, quantity: '5' })).status, 303);
      assert.equal(app.product.stock, 0);
      assert.equal((await app.buy()).status, 409);
    } finally {
      await app.close();
    }
  });

  it('re-renders the form with accessible errors and keeps what was typed (escaped)', async () => {
    const app = await setup();
    try {
      const res = await app.buy({ ...FORM, name: '<script>alert(1)</script>', phone: '123' });
      assert.equal(res.status, 400);
      assert.ok(res.text.includes(EN.errPhone));
      assert.match(res.text, /role="alert"/);
      assert.match(res.text, /aria-invalid="true"/);
      assert.equal(res.text.includes('<script>alert(1)</script>'), false);
      assert.ok(res.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    } finally {
      await app.close();
    }
  });

  it('does not place an order for a draft, another shop product, or an unknown id', async () => {
    const app = await setup();
    try {
      const draft = app.repo.addProduct(app.shop, { status: 'draft' });
      const otherShop = app.repo.addShop({ upiId: 'other@okbank' });
      const foreign = app.repo.addProduct(otherShop);
      for (const target of [draft, foreign, { id: '00000000-0000-4000-8000-000000000000' }, { id: 'nope' }]) {
        assert.equal((await app.request(app.buyPath(target), { method: 'POST', form: FORM })).status, 404);
      }
      assert.equal(app.orderRepo.orders.length, 0);
    } finally {
      await app.close();
    }
  });
});

describe('the private status page', () => {
  it('shows the order, the exact amount, one UPI link shared with the QR, the VPA and the manual-verification notice', async () => {
    const app = await setup();
    try {
      const token = await app.place();
      const res = await app.status(token);
      assert.equal(res.status, 200);
      for (const text of ['AS1001', '₹500.00', 'Clay diya', 'clay@okbank', EN.payWithUpi, EN.utrNotVerified, EN.copyUpiId]) assert.ok(res.text.includes(text), text);
      const uri = `upi://pay?pa=clay%40okbank&amp;pn=${encodeURIComponent(app.store.name)}&amp;am=500.00&amp;cu=INR&amp;tn=AS1001`;
      assert.ok(res.text.includes(`href="${uri}"`), 'pay link');
      assert.equal(res.text.includes('tr='), false);
      assert.match(res.text, /<svg role="img" aria-labelledby="qr-title qr-desc"/);
      assert.match(res.text, /<desc id="qr-desc">[^<]*AS1001/);
      assert.match(res.text, /<path d="M\d+ \d+h1v1h-1z/);
      assert.match(res.text, /<script src="\/js\/copy-upi.js" defer><\/script>/);
      assert.equal(/<script(?![^>]*src="\/js\/)/.test(res.text), false);
      assert.equal(/(?:src|href)="https?:\/\/(?!wa\.me)/.test(res.text), false);
      assert.match(res.text, /<h1>/);
      assert.match(res.text, /<html lang="en">/);
    } finally {
      await app.close();
    }
  });

  it('sends the privacy headers on every order response', async () => {
    const app = await setup();
    try {
      const token = await app.place();
      const responses = [await app.status(token), await app.status('x'.repeat(43)), await app.status('short'), await app.buy({ ...FORM, phone: '1' }), await app.request(app.buyPath())];
      for (const res of responses) {
        assert.equal(res.headers.get('cache-control'), 'no-store');
        assert.match(res.headers.get('x-robots-tag'), /noindex/);
        assert.equal(res.headers.get('referrer-policy'), 'same-origin');
      }
      assert.match((await app.status(token)).text, /<meta name="robots" content="noindex, nofollow">/);
      assert.equal((await app.request('/health')).headers.get('cache-control') === 'no-store', false);
    } finally {
      await app.close();
    }
  });

  it('answers unknown, malformed and foreign tokens with the same not-found page', async () => {
    const app = await setup();
    try {
      await app.place();
      const unknown = await app.status('A'.repeat(43));
      const malformed = await app.status('not-a-token');
      const longer = await app.status('A'.repeat(200));
      for (const res of [unknown, malformed, longer]) assert.equal(res.status, 404);
      assert.equal(unknown.text, malformed.text);
      assert.equal(unknown.text, longer.text);
      assert.equal((await app.postTo('A'.repeat(43), 'utr', { utr: UTR1 })).status, 404);
      assert.equal((await app.postTo('A'.repeat(43), 'cancel')).status, 404);
    } finally {
      await app.close();
    }
  });

  it('is available in Gujarati and Hindi and shows status in text', async () => {
    const app = await setup();
    try {
      const token = await app.place();
      const gu = await app.status(token, { headers: { 'accept-language': 'gu' } });
      assert.ok(gu.text.includes(GU.statusAwaitingPayment));
      assert.match(gu.text, /<html lang="gu">/);
      const hi = await app.status(`${token}?lang=hi`);
      assert.ok(hi.text.includes(PUBLIC_STRINGS.hi.statusAwaitingPayment));
      assert.ok((await app.request(`${app.buyPath()}?lang=gu`)).text.includes(GU.buyNow));
    } finally {
      await app.close();
    }
  });

  it('offers a prefilled WhatsApp link with only the reference and amount, hidden when the store has none', async () => {
    const app = await setup();
    try {
      const token = await app.place();
      const res = await app.status(token);
      const link = /href="(https:\/\/wa\.me\/[^"]+)"/.exec(res.text)[1];
      assert.match(link, /^https:\/\/wa\.me\/919123456780\?text=/);
      const message = decodeURIComponent(new URL(link.replaceAll('&amp;', '&')).searchParams.get('text'));
      assert.ok(message.includes('AS1001') && message.includes('₹500.00'));
      assert.equal(message.includes('Test Buyer') || message.includes(token), false);
      app.shop.whatsappEnabled = false;
      assert.equal((await app.status(token)).text.includes('wa.me'), false);
    } finally {
      await app.close();
    }
  });
});

describe('UTR submission, cancellation and the state machine', () => {
  it('accepts exactly 12 digits, then shows the submitted state and never claims verification', async () => {
    const app = await setup();
    try {
      const token = await app.place();
      for (const utr of ['12345678901', '1234567890123', '12345678901a', '']) {
        const bad = await app.postTo(token, 'utr', { utr });
        assert.equal(bad.status, 400, utr);
        assert.ok(bad.text.includes(EN.errUtr));
      }
      const ok = await app.postTo(token, 'utr', { utr: UTR1 });
      assert.equal(ok.status, 303);
      assert.equal(ok.location, `/o/${token}`);
      const page = await app.status(token);
      assert.ok(page.text.includes(EN.statusPaymentSubmitted));
      assert.ok(page.text.includes(UTR1));
      assert.equal(page.text.includes('name="utr"'), false);
      assert.equal(page.text.includes('upi://pay'), false);
      assert.equal(/verified automatically|payment verified/i.test(page.text.replace(EN.utrNotVerified, '')), false);
    } finally {
      await app.close();
    }
  });

  it('is idempotent for the same UTR and rejects a different one while submitted', async () => {
    const app = await setup();
    try {
      const token = await app.place();
      await app.postTo(token, 'utr', { utr: UTR1 });
      assert.equal((await app.postTo(token, 'utr', { utr: UTR1 })).status, 303);
      const other = await app.postTo(token, 'utr', { utr: UTR2 });
      assert.equal(other.status, 409);
      assert.ok(other.text.includes(EN.errOrderState));
      assert.equal(app.orderRepo.orders[0].utrSubmissions, 1);
    } finally {
      await app.close();
    }
  });

  it('never lets a customer mark an order paid (no route, and extra fields are rejected)', async () => {
    const app = await setup();
    try {
      const token = await app.place();
      for (const action of ['paid', 'mark-paid', 'status', 'resolve']) assert.equal((await app.postTo(token, action, { status: 'paid' })).status, 404, action);
      assert.equal((await app.postTo(token, 'utr', { utr: UTR1, status: 'paid' })).status, 400);
      assert.equal(app.orderRepo.orders[0].status, 'awaiting_payment');
      await app.postTo(token, 'utr', { utr: UTR1 });
      assert.equal(app.orderRepo.orders[0].status, 'payment_submitted');
    } finally {
      await app.close();
    }
  });

  it('allows three submissions per order, then rejects the fourth; a used UTR can never come back', async () => {
    const app = await setup();
    try {
      const token = await app.place();
      for (const utr of [UTR1, UTR2, UTR3]) {
        assert.equal((await app.postTo(token, 'utr', { utr })).status, 303, utr);
        assert.equal((await app.ownerPost(token, 'not-received')).status, 303);
      }
      assert.equal(app.orderRepo.orders[0].status, 'not_received');
      const page = await app.status(token);
      assert.equal(page.text.includes('name="utr"'), false);
      const fourth = await app.postTo(token, 'utr', { utr: UTR4 });
      assert.equal(fourth.status, 409);
      assert.ok(fourth.text.includes(EN.errUtrLimit));
      assert.equal(app.orderRepo.orders[0].utrSubmissions, 3);
      assert.equal(app.orderRepo.orders[0].attempts.length, 3);
    } finally {
      await app.close();
    }
  });

  it('rejects a UTR already used in the same store, but allows it in a different store', async () => {
    const app = await setup();
    try {
      const first = await app.place();
      const second = await app.place();
      await app.postTo(first, 'utr', { utr: UTR1 });
      const reuse = await app.postTo(second, 'utr', { utr: UTR1 });
      assert.equal(reuse.status, 409);
      assert.ok(reuse.text.includes(EN.errUtrInUse));
      assert.equal(app.orderRepo.orders[1].status, 'awaiting_payment');
      const otherShop = app.repo.addShop({ upiId: 'other@okbank', name: 'Other' });
      const otherProduct = app.repo.addProduct(otherShop, { pricePaise: 10000, stock: null });
      const placed = await app.request(`/s/${otherShop.slug}/p/${otherProduct.id}/buy`, { method: 'POST', form: FORM });
      assert.equal(placed.status, 303);
      assert.equal((await app.postTo(placed.location.slice(3), 'utr', { utr: UTR1 })).status, 303);
    } finally {
      await app.close();
    }
  });

  it('lets the customer cancel while unpaid (stock restored once, repeat harmless) but not after submitting', async () => {
    const app = await setup();
    try {
      const token = await app.place();
      assert.equal(app.product.stock, 3);
      assert.equal((await app.postTo(token, 'cancel')).status, 303);
      assert.equal(app.product.stock, 5);
      assert.equal((await app.postTo(token, 'cancel')).status, 303);
      assert.equal(app.product.stock, 5);
      const page = await app.status(token);
      assert.ok(page.text.includes(EN.cancelledCustomer));
      assert.equal(page.text.includes('upi://pay'), false);
      assert.equal((await app.postTo(token, 'utr', { utr: UTR1 })).status, 409);
      const paid = await app.place();
      await app.postTo(paid, 'utr', { utr: UTR2 });
      assert.equal((await app.postTo(paid, 'cancel')).status, 409);
      assert.equal(app.orderRepo.orders[1].status, 'payment_submitted');
    } finally {
      await app.close();
    }
  });

  it('expires after the window: cancelled, stock restored once, and the last unit can be bought again', async () => {
    const app = await setup();
    try {
      app.product.stock = 2;
      const token = await app.place();
      assert.equal(app.product.stock, 0);
      assert.equal((await app.buy()).status, 409);
      app.orderClock.now += 11 * 60_000;
      const page = await app.status(token);
      assert.ok(page.text.includes(EN.cancelledExpired));
      assert.equal(app.product.stock, 2);
      await app.status(token);
      assert.equal(app.product.stock, 2);
      const late = await app.postTo(token, 'utr', { utr: UTR1 });
      assert.equal(late.status, 409);
      assert.equal((await app.buy()).status, 303);
    } finally {
      await app.close();
    }
  });
});

describe('owner Orders pages', () => {
  it('lists orders, shows the detail with snapshots and UTR history, and gives the dashboard badge', async () => {
    const app = await setup();
    try {
      const token = await app.place({ ...FORM, name: 'Asha <b>Patel</b>', address: 'test-address-line' });
      await app.postTo(token, 'utr', { utr: UTR1 });
      const list = await app.owner('/orders');
      assert.equal(list.status, 200);
      assert.ok(list.text.includes('AS1001') && list.text.includes('₹500.00') && list.text.includes('Payment submitted'));
      assert.equal(list.text.includes('<b>Patel</b>'), false);
      assert.ok((await app.owner('/orders?status=paid')).text.includes('No orders to show'));
      const detail = await app.owner(`/orders/${app.orderIdOf(token)}`);
      for (const text of ['clay@okbank', UTR1, 'Clay diya', 'test-address-line', 'Mark paid', 'Payment not received', 'Cancel order', 'wa.me/919876543210']) assert.ok(detail.text.includes(text), text);
      assert.ok((await app.owner('/dashboard')).text.includes('1 to check'));
      assert.match((await app.owner('/dashboard')).text, /href="\/orders"/);
    } finally {
      await app.close();
    }
  });

  it('marks paid (idempotent), shows only the buttons the state allows, and refuses invalid transitions', async () => {
    const app = await setup();
    try {
      const token = await app.place();
      let detail = await app.owner(`/orders/${app.orderIdOf(token)}`);
      assert.equal(detail.text.includes('Mark paid'), false);
      assert.ok(detail.text.includes('Cancel order'));
      assert.equal((await app.ownerPost(token, 'paid')).location.includes('error=state'), true);
      await app.postTo(token, 'utr', { utr: UTR1 });
      const paid = await app.ownerPost(token, 'paid');
      assert.equal(paid.location, `/orders/${app.orderIdOf(token)}?done=paid`);
      assert.equal((await app.ownerPost(token, 'paid')).location.endsWith('?done=paid'), true);
      detail = await app.owner(`/orders/${app.orderIdOf(token)}`);
      for (const text of ['Mark paid', 'Cancel order', 'Payment not received']) assert.equal(detail.text.includes(text), false, text);
      assert.ok((await app.ownerPost(token, 'cancel')).location.includes('error=state'));
      assert.ok((await app.ownerPost(token, 'not-received')).location.includes('error=state'));
      assert.equal(app.orderRepo.orders[0].status, 'paid');
      assert.equal(app.product.stock, 3);
      app.orderClock.now += 3 * 3_600_000;
      await app.owner('/orders');
      assert.equal(app.orderRepo.orders[0].status, 'paid');
      assert.ok((await app.status(token)).text.includes(EN.statusPaid));
    } finally {
      await app.close();
    }
  });

  it('not_received holds stock and gives a fresh window; owner cancel restores stock once', async () => {
    const app = await setup();
    try {
      const token = await app.place();
      await app.postTo(token, 'utr', { utr: UTR1 });
      await app.ownerPost(token, 'not-received');
      const [order] = app.orderRepo.orders;
      assert.equal(order.status, 'not_received');
      assert.equal(app.product.stock, 3);
      assert.ok(Date.parse(order.expiresAt) > app.orderClock.now);
      assert.ok((await app.status(token)).text.includes(EN.helpNotReceived));
      await app.ownerPost(token, 'cancel');
      await app.ownerPost(token, 'cancel');
      assert.equal(app.product.stock, 5);
      assert.equal(order.cancelReason, 'owner');
    } finally {
      await app.close();
    }
  });

  it('is scoped to the session store: another owner cannot see or change this store orders', async () => {
    const app = await setup();
    try {
      const token = await app.place();
      await app.postTo(token, 'utr', { utr: UTR1 });
      const id = app.orderIdOf(token);
      const cookie2 = await signupAndLogin(app, 'second@example.com');
      await app.request('/store/new', { method: 'POST', cookie: cookie2, form: { ...STORE_FORM, slug: 'other-works', name: 'Other Works' } });
      const store2 = app.storesRepo.rows[1];
      app.repo.addShop({ id: store2.id, ownerId: store2.ownerId, slug: store2.slug, name: store2.name, upiId: 'two@okbank' });
      assert.ok((await app.request('/orders', { cookie: cookie2 })).text.includes('No orders to show'));
      assert.equal((await app.request(`/orders/${id}`, { cookie: cookie2 })).status, 404);
      for (const action of ['paid', 'not-received', 'cancel']) {
        assert.equal((await app.request(`/orders/${id}/${action}`, { method: 'POST', cookie: cookie2 })).status, 404, action);
      }
      assert.equal(app.orderRepo.orders[0].status, 'payment_submitted');
      assert.equal(app.product.stock, 3);
    } finally {
      await app.close();
    }
  });

  it('requires an owner session and the Origin check on every owner action', async () => {
    const app = await setup();
    try {
      const token = await app.place();
      await app.postTo(token, 'utr', { utr: UTR1 });
      const id = app.orderIdOf(token);
      assert.equal((await app.request('/orders')).status, 303);
      assert.equal((await app.request(`/orders/${id}/paid`, { method: 'POST' })).status, 303);
      assert.equal((await app.owner(`/orders/${id}/paid`, { method: 'POST', origin: EVIL_ORIGIN })).status, 403);
      assert.equal((await app.owner(`/orders/${id}/paid`, { method: 'POST', origin: null })).status, 403);
      assert.equal((await app.owner('/orders/not-a-uuid')).status, 404);
      assert.equal(app.orderRepo.orders[0].status, 'payment_submitted');
    } finally {
      await app.close();
    }
  });
});

describe('CSRF, rate limits and privacy', () => {
  it('applies the Origin check to every customer POST', async () => {
    const app = await setup();
    try {
      const token = await app.place();
      for (const origin of [EVIL_ORIGIN, null]) {
        assert.equal((await app.buy(FORM, { origin })).status, 403);
        assert.equal((await app.postTo(token, 'utr', { utr: UTR1 }, { origin })).status, 403);
        assert.equal((await app.postTo(token, 'cancel', {}, { origin })).status, 403);
      }
      assert.equal(app.orderRepo.orders.length, 1);
      assert.equal(app.orderRepo.orders[0].status, 'awaiting_payment');
    } finally {
      await app.close();
    }
  });

  it('never sends no-referrer on a page that contains a form: Chrome would post Origin: null (production 403)', async () => {
    const app = await setup();
    try {
      const token = await app.place();
      for (const res of [await app.request(app.buyPath()), await app.status(token)]) {
        assert.match(res.text, /<form method="post"/);
        assert.notEqual(res.headers.get('referrer-policy'), 'no-referrer');
        assert.equal(res.headers.get('referrer-policy'), 'same-origin');
      }
    } finally {
      await app.close();
    }
  });

  it('rejects the literal Origin: null on every customer POST while a real same-origin Origin is accepted', async () => {
    const app = await setup();
    try {
      const token = await app.place();
      const literalNull = { origin: 'null' };
      assert.equal((await app.buy(FORM, literalNull)).status, 403);
      assert.equal((await app.postTo(token, 'utr', { utr: UTR1 }, literalNull)).status, 403);
      assert.equal((await app.postTo(token, 'cancel', {}, literalNull)).status, 403);
      assert.equal(app.orderRepo.orders.length, 1);
      assert.equal((await app.buy()).status, 303);
      assert.equal(app.orderRepo.orders.length, 2);
    } finally {
      await app.close();
    }
  });

  it('rate-limits order creation, UTR submission and status lookup per IP', async () => {
    const limits = { create: { windowMs: 60_000, limit: 2 }, utr: { windowMs: 60_000, limit: 2 }, status: { windowMs: 60_000, limit: 3 } };
    const app = await setup({ appOptions: { appDeps: { orderRateLimits: limits } } });
    try {
      const token = await app.place();
      assert.equal((await app.buy()).status, 303);
      assert.equal((await app.buy()).status, 429);
      assert.equal((await app.postTo(token, 'utr', { utr: '1' })).status, 400);
      assert.equal((await app.postTo(token, 'utr', { utr: '2' })).status, 400);
      assert.equal((await app.postTo(token, 'utr', { utr: UTR1 })).status, 429);
      const statuses = [];
      for (let i = 0; i < 4; i += 1) statuses.push((await app.status(token)).status);
      assert.deepEqual(statuses, [200, 200, 200, 429]);
    } finally {
      await app.close();
    }
  });

  it('never logs the token, UTR, name, phone, address or WhatsApp links, and redacts the token path', async () => {
    const app = await setup();
    try {
      const token = await app.place({ ...FORM, address: 'test-address-line' });
      await app.status(token);
      await app.postTo(token, 'utr', { utr: UTR1 });
      await app.postTo(token, 'utr', { utr: 'bad' });
      await app.owner(`/orders/${app.orderIdOf(token)}`);
      await app.postTo(token, 'cancel');
      await app.waitForLog((entry) => entry.path === '/o/[REDACTED]/cancel');
      const everything = JSON.stringify([app.logs, app.orderLogs.entries]);
      for (const secret of [token, UTR1, ...OWNER_PRIVACY, 'wa.me', 'clay@okbank']) assert.equal(everything.includes(secret), false, secret);
      assert.ok(app.logs.some((entry) => entry.path === '/o/[REDACTED]'));
      assert.ok(app.orderLogs.entries.some((entry) => entry.message === 'order placed'));
    } finally {
      await app.close();
    }
  });

  it('never exposes the status token hash, the owner id or the UPI ID of other orders in any page', async () => {
    const app = await setup();
    try {
      const token = await app.place();
      const html = (await app.status(token)).text + (await app.owner('/orders')).text + (await app.owner(`/orders/${app.orderIdOf(token)}`)).text;
      assert.equal(html.includes(hashStatusToken(token)), false);
      assert.equal(html.includes(app.store.ownerId), false);
    } finally {
      await app.close();
    }
  });
});

describe('checkout form and stock display', () => {
  it('requires a delivery address and shows the message in every language', async () => {
    const app = await setup();
    try {
      for (const [lang, strings] of [['en', EN], ['gu', GU], ['hi', PUBLIC_STRINGS.hi]]) {
        const res = await app.request(`${app.buyPath(app.product, `?lang=${lang}`)}`, { method: 'POST', form: { ...FORM, address: '   ' } });
        assert.equal(res.status, 400);
        assert.ok(res.text.includes(strings.errAddress), lang);
      }
      const { address, ...withoutAddress } = FORM;
      assert.equal((await app.buy(withoutAddress)).status, 400);
      assert.equal((await app.buy({ ...FORM, address: 'x'.repeat(301) })).status, 400);
      assert.equal(app.orderRepo.orders.length, 0);
    } finally {
      await app.close();
    }
  });

  it('uses the right input types, autocomplete and inputmode, and marks the address required', async () => {
    const app = await setup();
    try {
      const { text } = await app.request(app.buyPath());
      assert.match(text, /<input type="text" id="name"[^>]*autocomplete="name"/);
      assert.match(text, /<input type="tel" id="phone"[^>]*inputmode="tel"[^>]*autocomplete="tel"/);
      assert.match(text, /<input type="email" id="email"[^>]*autocomplete="email"[^>]*inputmode="email"/);
      assert.match(text, /<textarea id="address"[^>]*maxlength="300"[^>]*autocomplete="street-address"[^>]* required/);
      assert.ok(!text.includes(`${EN.yourAddress} ${EN.optionalField}`));
    } finally {
      await app.close();
    }
  });

  it('shows "Only N available" below the maximum and "Choose from 1 to 20" otherwise, straight after an order', async () => {
    const app = await setup();
    try {
      assert.ok((await app.request(app.buyPath())).text.includes('Only 5 available.'));
      await app.place({ ...FORM, quantity: '2' });
      const after = await app.request(app.buyPath());
      assert.ok(after.text.includes('Only 3 available.'));
      assert.equal(after.headers.get('cache-control'), 'no-store');
      app.product.stock = null;
      assert.ok((await app.request(app.buyPath())).text.includes('Choose from 1 to 20.'));
      app.product.stock = 20;
      assert.ok((await app.request(app.buyPath())).text.includes('Choose from 1 to 20.'));
    } finally {
      await app.close();
    }
  });

  it('serves public product pages with revalidation, so stock changes are never hidden by a cache', async () => {
    const app = await setup();
    try {
      const page = await app.request(`/s/${app.shop.slug}/p/${app.product.id}`);
      assert.equal(page.headers.get('cache-control'), 'no-cache');
      app.product.stock = 0;
      assert.ok((await app.request(`/s/${app.shop.slug}/p/${app.product.id}`)).text.includes(EN.soldOut));
    } finally {
      await app.close();
    }
  });
});
describe('10 minute reservation', () => {
  const MINUTE = 60_000;

  it('gives a new order a deadline exactly 10 minutes after creation and shows the server countdown, also after a refresh', async () => {
    const app = await setup();
    try {
      const token = await app.place();
      const [order] = app.orderRepo.orders;
      assert.equal(Date.parse(order.expiresAt) - Date.parse(order.createdAt), 10 * MINUTE);
      assert.match((await app.status(token)).text, /data-seconds-left="600"/);
      app.orderClock.now += 3 * MINUTE;
      const refreshed = await app.status(token);
      assert.match(refreshed.text, /data-seconds-left="420"/);
      assert.ok(refreshed.text.includes('07:00'));
      assert.ok(refreshed.text.includes(EN.timeLeftLabel));
      assert.ok(refreshed.text.includes('/js/countdown.js'));
    } finally {
      await app.close();
    }
  });

  it('a UTR before the deadline stops the countdown and keeps the stock reserved without a second decrement', async () => {
    const app = await setup();
    try {
      const token = await app.place();
      assert.equal(app.product.stock, 3);
      app.orderClock.now += 9 * MINUTE;
      assert.equal((await app.postTo(token, 'utr', { utr: UTR1 })).status, 303);
      app.orderClock.now += 3 * 60 * MINUTE;
      const page = await app.status(token);
      assert.equal(page.text.includes('data-countdown'), false);
      assert.ok(page.text.includes(EN.statusPaymentSubmitted));
      assert.ok(page.text.includes(EN.reservationHeld));
      await app.owner('/orders');
      assert.equal(app.orderRepo.orders[0].status, 'payment_submitted');
      assert.equal(app.product.stock, 3);
      await app.ownerPost(token, 'paid');
      assert.equal(app.product.stock, 3);
    } finally {
      await app.close();
    }
  });

  it('rejects a UTR after the deadline, explains the release, restores the stock once and hides the UTR form', async () => {
    const app = await setup();
    try {
      const token = await app.place();
      app.orderClock.now += 10 * MINUTE;
      const late = await app.postTo(token, 'utr', { utr: UTR1 });
      assert.equal(late.status, 409);
      assert.ok(late.text.includes(EN.errOrderExpired));
      assert.equal(app.product.stock, 5);
      const page = await app.status(token);
      assert.ok(page.text.includes(EN.reservationReleased));
      assert.equal(page.text.includes('name="utr"'), false);
      assert.equal(page.text.includes('data-countdown'), false);
      assert.equal(app.product.stock, 5);
      assert.equal(app.orderRepo.orders[0].attempts.length, 0);
    } finally {
      await app.close();
    }
  });

  it('does not accept a late UTR or offer the form even when the sweep has not run (the deadline, not the sweep, decides)', async () => {
    const app = await setup();
    try {
      const token = await app.place();
      app.orderClock.now += 11 * MINUTE;
      app.orderRepo.expireOverdue = async () => 0;
      const page = await app.status(token);
      assert.ok(page.text.includes(EN.reservationReleased));
      assert.equal(page.text.includes('name="utr"'), false);
      assert.equal(page.text.includes('upi://'), false);
      assert.equal((await app.postTo(token, 'utr', { utr: UTR1 })).status, 409);
      assert.equal(app.orderRepo.orders[0].attempts.length, 0);
    } finally {
      await app.close();
    }
  });

  it('shows the released reservation in Gujarati and Hindi', async () => {
    const app = await setup();
    try {
      const token = await app.place();
      app.orderClock.now += 11 * MINUTE;
      for (const lang of ['gu', 'hi']) {
        const res = await app.request(`/o/${token}?lang=${lang}`);
        assert.ok(res.text.includes(PUBLIC_STRINGS[lang].reservationReleased), lang);
      }
    } finally {
      await app.close();
    }
  });

  it('releases an abandoned last unit so the checkout page is not shown as sold out', async () => {
    const app = await setup();
    try {
      app.product.stock = 1;
      await app.place({ ...FORM, quantity: '1' });
      assert.equal(app.product.stock, 0);
      app.orderClock.now += 10 * MINUTE;
      const checkout = await app.request(app.buyPath());
      assert.equal(checkout.status, 200);
      assert.equal(checkout.text.includes(EN.soldOut), false);
      assert.equal(app.product.stock, 1);
    } finally {
      await app.close();
    }
  });

  it('keeps the longer window for a payment marked not received', async () => {
    const app = await setup();
    try {
      const token = await app.place();
      await app.postTo(token, 'utr', { utr: UTR1 });
      await app.ownerPost(token, 'not-received');
      const [order] = app.orderRepo.orders;
      assert.equal(Date.parse(order.expiresAt) - app.orderClock.now, 60 * MINUTE);
    } finally {
      await app.close();
    }
  });

  it('shows the quantity beside the available stock on checkout and mentions the 10 minute hold', async () => {
    const app = await setup();
    try {
      const page = await app.request(app.buyPath());
      assert.ok(page.text.includes('Available: 5'));
      assert.ok(page.text.includes('10 minutes'));
      assert.match(page.text, /name="quantity" form="checkout-form"/);
      assert.match(page.text, /id="checkout-form"/);
    } finally {
      await app.close();
    }
  });
});

describe('owner orders table', () => {
  it('lists reference, customer, formatted phone, date, items, total, status and a View order action', async () => {
    const app = await setup();
    try {
      const token = await app.place();
      const page = await app.owner('/orders');
      for (const header of ['Reference', 'Customer', 'Phone', 'Date and time', 'Items', 'Total', 'Status']) assert.ok(page.text.includes(`>${header}</th>`), header);
      assert.ok(page.text.includes('+91 98765 43210'));
      assert.ok(page.text.includes('Clay diya'));
      assert.ok(page.text.includes('₹500.00'));
      assert.ok(page.text.includes(`href="/orders/${app.orderIdOf(token)}"`));
      assert.ok(page.text.includes('View order'));
      assert.ok(page.text.includes('/js/order-search.js'));
      const detail = await app.owner(`/orders/${app.orderIdOf(token)}`);
      for (const section of ['Customer', 'Items', 'Payment', 'Actions']) assert.ok(detail.text.includes(`>${section}</h2>`), section);
      assert.ok(detail.text.includes('data-confirm="Cancel this order?'));
    } finally {
      await app.close();
    }
  });
});
