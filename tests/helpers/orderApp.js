import assert from 'node:assert/strict';
import { hashStatusToken } from '../../src/lib/statusToken.js';
import { STORE_FORM, signupAndLogin } from './appHarness.js';
import { startOrderApp } from './orderFakes.js';

/** A valid checkout form. */
export const FORM = { quantity: '2', name: 'Test Buyer', phone: '98765 43210', email: 'buyer@example.test', address: '12 Test Lane, Ahmedabad' };

/** An app with one owner (logged in), one shop with a UPI ID and WhatsApp, and one product (stock 5, Rs 250). */
export async function setup(options = {}) {
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
