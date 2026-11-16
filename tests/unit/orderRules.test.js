import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateStatusToken, hashStatusToken, isWellFormedToken } from '../../src/lib/statusToken.js';
import {
  ACTORS, MAX_QUANTITY, ORDER_STATUSES, STATUS, canTransition, checkoutSchema, customerActions, normalizeIndianMobile, ownerActions, priceOrder, utrSchema,
} from '../../src/domain/orderRules.js';

const goodForm = { quantity: '2', name: ' Test  Buyer ', phone: '98765 43210', email: '', address: '' };
const product = (overrides = {}) => ({ id: 'p1', status: 'published', pricePaise: 25000, stock: null, ...overrides });

describe('phone normalisation', () => {
  it('turns the usual Indian formats into 91 plus ten digits', () => {
    for (const input of ['98765 43210', '+91 98765-43210', '09876543210', '919876543210', '(98765) 43210']) {
      assert.equal(normalizeIndianMobile(input), '919876543210', input);
    }
  });

  it('rejects numbers that are not Indian mobiles', () => {
    for (const bad of ['5876543210', '12345', '+44 7911 123456', 'abc', '', '98765432101234', 5, null]) {
      assert.equal(normalizeIndianMobile(bad), null, String(bad));
    }
  });
});

describe('checkoutSchema', () => {
  it('cleans and normalises a valid form', () => {
    assert.deepEqual(checkoutSchema.parse(goodForm), { quantity: 2, name: 'Test Buyer', phone: '919876543210', email: null, address: null });
  });

  it('enforces the quantity bounds 1 to 20 and whole numbers', () => {
    assert.equal(checkoutSchema.parse({ ...goodForm, quantity: String(MAX_QUANTITY) }).quantity, MAX_QUANTITY);
    for (const bad of ['0', '21', '-1', '1.5', '', 'abc', '100']) {
      assert.equal(checkoutSchema.safeParse({ ...goodForm, quantity: bad }).success, false, bad);
    }
  });

  it('rejects unknown keys (price, store_id, title, vpa, total, status, owner)', () => {
    for (const key of ['price', 'store_id', 'title', 'vpa', 'total', 'status', 'owner_id', 'productId']) {
      assert.equal(checkoutSchema.safeParse({ ...goodForm, [key]: 'x' }).success, false, key);
    }
  });

  it('validates name, phone, email and address', () => {
    assert.equal(checkoutSchema.safeParse({ ...goodForm, name: '   ' }).success, false);
    assert.equal(checkoutSchema.safeParse({ ...goodForm, name: 'x'.repeat(81) }).success, false);
    assert.equal(checkoutSchema.safeParse({ ...goodForm, phone: '123' }).success, false);
    assert.equal(checkoutSchema.safeParse({ ...goodForm, email: 'not-an-email' }).success, false);
    assert.equal(checkoutSchema.parse({ ...goodForm, email: 'a@b.co' }).email, 'a@b.co');
    assert.equal(checkoutSchema.safeParse({ ...goodForm, address: 'x'.repeat(301) }).success, false);
    assert.equal(checkoutSchema.parse({ ...goodForm, address: 'Line 1\nLine 2' }).address, 'Line 1\nLine 2');
  });
});

describe('utrSchema', () => {
  it('accepts exactly 12 digits', () => {
    assert.equal(utrSchema.parse({ utr: ' 123456789012 ' }).utr, '123456789012');
    for (const bad of ['12345678901', '1234567890123', '12345678901a', '']) {
      assert.equal(utrSchema.safeParse({ utr: bad }).success, false, bad);
    }
    assert.equal(utrSchema.safeParse({ utr: '123456789012', status: 'paid' }).success, false);
  });
});

describe('state machine', () => {
  const allowed = [
    ['customer', 'awaiting_payment', 'payment_submitted'], ['customer', 'awaiting_payment', 'cancelled'],
    ['customer', 'not_received', 'payment_submitted'], ['customer', 'not_received', 'cancelled'],
    ['owner', 'awaiting_payment', 'cancelled'], ['owner', 'payment_submitted', 'paid'], ['owner', 'payment_submitted', 'not_received'],
    ['owner', 'payment_submitted', 'cancelled'], ['owner', 'not_received', 'cancelled'],
    ['system', 'awaiting_payment', 'cancelled'], ['system', 'not_received', 'cancelled'],
  ];

  it('allows exactly the listed transitions and nothing else', () => {
    for (const actor of Object.values(ACTORS)) {
      for (const from of ORDER_STATUSES) {
        for (const to of ORDER_STATUSES) {
          const expected = allowed.some((entry) => entry[0] === actor && entry[1] === from && entry[2] === to);
          assert.equal(canTransition(actor, from, to), expected, `${actor} ${from} -> ${to}`);
        }
      }
    }
  });

  it('never lets a customer reach paid, and paid/cancelled are terminal', () => {
    for (const from of ORDER_STATUSES) assert.equal(canTransition('customer', from, STATUS.PAID), false);
    for (const actor of Object.values(ACTORS)) {
      for (const to of ORDER_STATUSES) {
        assert.equal(canTransition(actor, STATUS.PAID, to), false);
        assert.equal(canTransition(actor, STATUS.CANCELLED, to), false);
      }
    }
  });

  it('exposes which buttons each side may see', () => {
    assert.deepEqual(ownerActions('payment_submitted'), { canMarkPaid: true, canMarkNotReceived: true, canCancel: true });
    assert.deepEqual(ownerActions('awaiting_payment'), { canMarkPaid: false, canMarkNotReceived: false, canCancel: true });
    assert.deepEqual(ownerActions('paid'), { canMarkPaid: false, canMarkNotReceived: false, canCancel: false });
    assert.deepEqual(customerActions('awaiting_payment'), { canSubmitUtr: true, canCancel: true });
    assert.deepEqual(customerActions('payment_submitted'), { canSubmitUtr: false, canCancel: false });
    assert.deepEqual(customerActions('not_received'), { canSubmitUtr: true, canCancel: true });
  });
});

describe('priceOrder (integer paise)', () => {
  it('prices lines and the total without floats', () => {
    const lines = [{ productId: 'p1', quantity: 3 }, { productId: 'p2', quantity: 1 }];
    const result = priceOrder(lines, [product(), product({ id: 'p2', pricePaise: 5 })]);
    assert.deepEqual(result, {
      lines: [
        { productId: 'p1', quantity: 3, unitPricePaise: 25000, lineTotalPaise: 75000 },
        { productId: 'p2', quantity: 1, unitPricePaise: 5, lineTotalPaise: 5 },
      ],
      totalPaise: 75005,
    });
    assert.equal(priceOrder([{ productId: 'p1', quantity: 3 }], [product({ pricePaise: 10 })]).totalPaise, 30);
  });

  it('handles stock 0, stock exactly enough, and NULL (unlimited)', () => {
    assert.throws(() => priceOrder([{ productId: 'p1', quantity: 1 }], [product({ stock: 0 })]), { code: 'OUT_OF_STOCK' });
    assert.throws(() => priceOrder([{ productId: 'p1', quantity: 3 }], [product({ stock: 2 })]), { code: 'OUT_OF_STOCK' });
    assert.equal(priceOrder([{ productId: 'p1', quantity: 2 }], [product({ stock: 2 })]).totalPaise, 50000);
    assert.equal(priceOrder([{ productId: 'p1', quantity: MAX_QUANTITY }], [product({ stock: null })]).totalPaise, 500000);
  });

  it('rejects unavailable products, bad quantities and duplicate lines', () => {
    assert.throws(() => priceOrder([{ productId: 'p1', quantity: 1 }], []), { code: 'PRODUCT_UNAVAILABLE' });
    assert.throws(() => priceOrder([{ productId: 'p1', quantity: 1 }], [product({ status: 'draft' })]), { code: 'PRODUCT_UNAVAILABLE' });
    assert.throws(() => priceOrder([{ productId: 'p1', quantity: 1 }], [product({ pricePaise: null })]), { code: 'PRODUCT_UNAVAILABLE' });
    for (const quantity of [0, 21, 1.5, -1]) {
      assert.throws(() => priceOrder([{ productId: 'p1', quantity }], [product()]), { code: 'INVALID_ORDER' });
    }
    assert.throws(() => priceOrder([{ productId: 'p1', quantity: 1 }, { productId: 'p1', quantity: 1 }], [product()]), { code: 'INVALID_ORDER' });
    assert.throws(() => priceOrder([], [product()]), { code: 'INVALID_ORDER' });
  });
});

describe('status token', () => {
  it('is 32 random bytes as base64url and hashes to a 64-char hex SHA-256', () => {
    const token = generateStatusToken();
    assert.equal(isWellFormedToken(token), true);
    assert.equal(Buffer.from(token, 'base64url').length, 32);
    assert.match(hashStatusToken(token), /^[0-9a-f]{64}$/);
    assert.notEqual(generateStatusToken(), token);
    assert.equal(hashStatusToken('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('rejects malformed tokens before any lookup', () => {
    for (const bad of ['', 'short', 'a'.repeat(44), `${'a'.repeat(42)}!`, undefined, 5]) assert.equal(isWellFormedToken(bad), false, String(bad));
  });
});
