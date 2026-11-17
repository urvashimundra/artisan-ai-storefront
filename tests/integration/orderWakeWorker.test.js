import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FORM, setup } from '../helpers/orderApp.js';

const ONE_DAY_MS = 86_400_000;
const SEE_OTHER = 303;
const throwingKick = () => {
  throw new Error('worker unavailable');
};

describe('order changes wake the email worker once, after the change', () => {
  it('placing an order wakes the worker once', async () => {
    const app = await setup();
    try {
      await app.place();
      assert.equal(app.kicks.length, 1);
    } finally {
      await app.close();
    }
  });

  it('a refused checkout wakes nothing', async () => {
    const app = await setup();
    try {
      const res = await app.buy({ ...FORM, email: 'not-an-address' });
      assert.equal(res.status, 400);
      assert.equal(app.kicks.length, 0);
    } finally {
      await app.close();
    }
  });

  it('a customer cancel and an owner cancel each wake the worker once', async () => {
    const app = await setup();
    try {
      const byCustomer = await app.place();
      assert.equal((await app.postTo(byCustomer, 'cancel')).status, SEE_OTHER);
      assert.equal(app.kicks.length, 2);
      const byOwner = await app.place();
      assert.equal((await app.ownerPost(byOwner, 'cancel')).status, SEE_OTHER);
      assert.equal(app.kicks.length, 4);
    } finally {
      await app.close();
    }
  });

  it('an order that expires is noticed by a status visit, which wakes the worker for its order_expired email', async () => {
    const app = await setup();
    try {
      const token = await app.place();
      assert.equal(app.kicks.length, 1);
      app.orderClock.now += ONE_DAY_MS;
      await app.status(token);
      assert.equal(app.kicks.length, 2);
      assert.equal(app.outbox.rows.filter((row) => row.kind === 'order_expired').length, 1);
    } finally {
      await app.close();
    }
  });

  it('a kick that throws never fails the order', async () => {
    const app = await setup({ kick: throwingKick });
    try {
      const token = await app.place();
      assert.equal(app.orderRepo.orders.length, 1);
      assert.equal(app.orderRepo.orders[0].status, 'awaiting_payment');
      assert.ok(token.length > 0);
    } finally {
      await app.close();
    }
  });
});
