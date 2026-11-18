import { randomUUID } from 'node:crypto';
import { EMAIL_KINDS } from '../../src/domain/emailRules.js';
import { CANCEL_REASON_UTR_EXHAUSTED, MAX_UTR_SUBMISSIONS, ORDER_EXPIRY_MINUTES, ORDER_RESUBMIT_MINUTES, STATUS, canTransition } from '../../src/domain/orderRules.js';
import { requireStoreId } from '../../src/repositories/requireStoreId.js';
import { createOrderService } from '../../src/services/orderService.js';
import { createLogCollector } from './productFakes.js';
import { createFakeOutbox } from './emailFakes.js';
import { createLinkCipher } from '../../src/lib/linkCipher.js';
import { createFakePublicRepo, startPublicApp } from './publicFakes.js';

const MS_PER_MINUTE = 60_000;
const fail = (reason) => ({ ok: false, reason, already: false, orderId: null, reference: null, expiresAt: null });
const done = (extra = {}) => ({ ok: true, reason: null, already: false, orderId: null, reference: null, expiresAt: null, ...extra });

/**
 * In-memory order repository with the real repository's interface and the rules of the migration 008 functions (the SQL
 * itself is verified by db/test, not here). Every method needs the store id; a token hash is the only customer key.
 * Raw tokens are never seen: only hashes are stored.
 * When an `outbox` is given, every successful transition queues its email in the same step, exactly where the migration 010
 * functions do (and a refused transition queues nothing). `ownerEmailOf(storeId)` is the owner's ACCOUNT email.
 * @param {{ publicRepo: ReturnType<typeof createFakePublicRepo>, ownsStore: (storeId: string, ownerId: string) => boolean,
 *   clock: { now: number }, outbox?: ReturnType<import('./emailFakes.js').createFakeOutbox> | null,
 *   ownerEmailOf?: (storeId: string) => string | null }} deps
 */
export function createFakeOrderRepo({ publicRepo, ownsStore, clock, outbox = null, ownerEmailOf = () => null }) {
  const orders = [];
  const counters = new Map();
  const calls = [];
  const inStore = (storeId) => orders.filter((order) => order.storeId === requireStoreId(storeId));
  const attemptsInStore = (storeId, utr) => orders.some((o) => o.storeId === storeId && o.attempts.some((a) => a.utr === utr));
  const productOf = (storeId, id) => publicRepo.products.find((p) => p.id === id && p.storeId === storeId);
  const windowEnd = (minutes = ORDER_EXPIRY_MINUTES) => new Date(clock.now + minutes * MS_PER_MINUTE).toISOString();
  const isOverdue = (order) => order.expiresAt !== null && Date.parse(order.expiresAt) <= clock.now;

  function queueEmail(order, kind, { suffix = null } = {}) {
    const shop = publicRepo.shops.find((s) => s.id === order.storeId);
    outbox?.enqueueForOrder({ order, shop, ownerEmail: ownerEmailOf(order.storeId), kind, suffix });
  }

  function cancelLocked(order, reason) {
    if (order.stockRestoredAt || [STATUS.PAID, STATUS.CANCELLED].includes(order.status)) return false;
    Object.assign(order, { status: STATUS.CANCELLED, cancelReason: reason, expiresAt: null, stockRestoredAt: new Date(clock.now).toISOString() });
    for (const item of order.items.filter((line) => line.stockReserved)) {
      const product = productOf(order.storeId, item.productId);
      if (product && product.stock !== null) product.stock += item.quantity;
    }
    queueEmail(order, reason === 'expired' ? EMAIL_KINDS.ORDER_EXPIRED : EMAIL_KINDS.ORDER_CANCELLED);
    return true;
  }

  const sweep = (storeId, productIds = null) => {
    const overdue = inStore(storeId).filter((o) => [STATUS.AWAITING_PAYMENT, STATUS.NOT_RECEIVED].includes(o.status) && isOverdue(o)
      && (!productIds || o.items.some((i) => productIds.includes(i.productId))));
    return overdue.filter((order) => cancelLocked(order, 'expired')).length;
  };

  const toView = (order, { withShop = false } = {}) => {
    const shop = publicRepo.shops.find((s) => s.id === order.storeId);
    const { tokenHash: _hash, ...rest } = order;
    return { ...structuredClone(rest), shop: withShop && shop
      ? { name: shop.name, slug: shop.slug, defaultLanguage: shop.defaultLanguage, accentKey: shop.accentKey, whatsappNumber: shop.whatsappNumber, whatsappEnabled: shop.whatsappEnabled }
      : null };
  };

  return {
    orders,
    calls,
    async findPayee(storeId) {
      const shop = publicRepo.shops.find((s) => s.id === requireStoreId(storeId));
      return shop ? { id: shop.id, name: shop.name, slug: shop.slug, defaultLanguage: shop.defaultLanguage, accentKey: shop.accentKey, upiId: shop.upiId, whatsappNumber: shop.whatsappNumber, whatsappEnabled: shop.whatsappEnabled } : null;
    },

    async placeOrder(storeId, input) {
      calls.push('placeOrder');
      requireStoreId(storeId);
      sweep(storeId, input.lines.map((line) => line.productId));
      const shop = publicRepo.shops.find((s) => s.id === storeId);
      if (!shop) return fail('store_not_found');
      if (shop.upiId !== input.payeeVpa) return fail('payee_changed');
      const products = input.lines.map((line) => productOf(storeId, line.productId));
      if (products.some((p) => !p || p.status !== 'published')) return fail('product_unavailable');
      if (products.some((p, i) => p.pricePaise !== input.lines[i].unitPricePaise)) return fail('price_changed');
      if (products.some((p, i) => p.stock !== null && p.stock < input.lines[i].quantity)) return fail('insufficient_stock');
      if (input.lines.reduce((sum, line) => sum + line.lineTotalPaise, 0) !== input.totalPaise) return fail('total_mismatch');
      const number = (counters.get(storeId) ?? 1000) + 1;
      counters.set(storeId, number);
      const order = {
        id: randomUUID(), storeId, reference: `AS${number}`, status: STATUS.AWAITING_PAYMENT, cancelReason: null, tokenHash: input.tokenHash, statusTokenEnc: input.statusTokenEnc ?? null,
        payeeVpa: input.payeeVpa, totalPaise: input.totalPaise, customerName: input.customerName, customerPhone: input.customerPhone,
        customerEmail: input.customerEmail, deliveryAddress: input.deliveryAddress, language: input.language, utr: null, utrSubmissions: 0,
        expiresAt: windowEnd(), stockRestoredAt: null, paidAt: null, createdAt: new Date(clock.now).toISOString(), updatedAt: new Date(clock.now).toISOString(),
        items: input.lines.map((line, index) => ({ position: index + 1, productId: line.productId, title: line.title, titleLang: line.titleLang,
          unitPricePaise: line.unitPricePaise, quantity: line.quantity, lineTotalPaise: line.lineTotalPaise, stockReserved: productOf(storeId, line.productId).stock !== null })),
        attempts: [],
      };
      for (const item of order.items.filter((line) => line.stockReserved)) productOf(storeId, item.productId).stock -= item.quantity;
      orders.push(order);
      queueEmail(order, EMAIL_KINDS.ORDER_PLACED);
      return done({ orderId: order.id, reference: order.reference, expiresAt: order.expiresAt });
    },

    async submitPaymentReference(storeId, tokenHash, utr) {
      calls.push('submitPaymentReference');
      const order = inStore(storeId).find((o) => o.tokenHash === tokenHash);
      if (!order) return fail('not_found');
      if (order.status === STATUS.PAYMENT_SUBMITTED && order.utr === utr) return done({ already: true });
      if (!canTransition('customer', order.status, STATUS.PAYMENT_SUBMITTED)) return fail('invalid_transition');
      if (isOverdue(order)) return cancelLocked(order, 'expired'), fail('expired');
      if (order.utrSubmissions >= MAX_UTR_SUBMISSIONS) return fail('attempt_limit');
      if (attemptsInStore(storeId, utr)) return fail('utr_in_use');
      order.attempts.push({ utr, createdAt: new Date(clock.now).toISOString() });
      Object.assign(order, { status: STATUS.PAYMENT_SUBMITTED, utr, utrSubmissions: order.utrSubmissions + 1, expiresAt: null });
      queueEmail(order, EMAIL_KINDS.ORDER_PAYMENT_RECEIVED, { suffix: order.utrSubmissions });
      queueEmail(order, EMAIL_KINDS.SELLER_PAYMENT_SUBMITTED, { suffix: order.utrSubmissions });
      return done();
    },

    async resolvePayment(storeId, ownerId, orderId, outcome) {
      calls.push('resolvePayment');
      const order = ownsStore(storeId, ownerId) ? inStore(storeId).find((o) => o.id === orderId) : null;
      if (!order) return fail('not_found');
      if (order.status === outcome) return done({ already: true });
      if (outcome === STATUS.NOT_RECEIVED && order.cancelReason === CANCEL_REASON_UTR_EXHAUSTED) return done({ already: true, cancelled: true });
      if (!canTransition('owner', order.status, outcome)) return fail('invalid_transition');
      if (outcome === STATUS.NOT_RECEIVED && order.utrSubmissions >= MAX_UTR_SUBMISSIONS) {
        cancelLocked(order, CANCEL_REASON_UTR_EXHAUSTED);
        return done({ cancelled: true });
      }
      Object.assign(order, outcome === STATUS.PAID
        ? { status: STATUS.PAID, paidAt: new Date(clock.now).toISOString(), expiresAt: null }
        : { status: STATUS.NOT_RECEIVED, expiresAt: windowEnd(ORDER_RESUBMIT_MINUTES) });
      if (outcome === STATUS.PAID) queueEmail(order, EMAIL_KINDS.ORDER_CONFIRMED);
      else queueEmail(order, EMAIL_KINDS.ORDER_PAYMENT_NOT_FOUND, { suffix: order.utrSubmissions });
      return done();
    },

    async cancelOrder(storeId, { orderId, actor, ownerId = null, tokenHash = null }) {
      calls.push('cancelOrder');
      const order = inStore(storeId).find((o) => o.id === orderId);
      const allowed = actor === 'owner' ? ownsStore(storeId, ownerId) : order?.tokenHash === tokenHash;
      if (!order || !allowed) return fail('not_found');
      if (order.status === STATUS.CANCELLED) return done({ already: true });
      if (!canTransition(actor, order.status, STATUS.CANCELLED)) return fail('invalid_transition');
      cancelLocked(order, actor);
      return done();
    },

    async expireOverdue(storeId, productIds = null) {
      calls.push('expireOverdue');
      return sweep(storeId, productIds);
    },

    async findByTokenHash(tokenHash) {
      const order = orders.find((o) => o.tokenHash === tokenHash);
      return order ? toView(order, { withShop: true }) : null;
    },

    async listForOwner(storeId, { status = null } = {}) {
      return inStore(storeId).filter((o) => !status || o.status === status).map((o) => toView(o)).reverse();
    },

    async findForOwner(storeId, orderId) {
      const order = inStore(storeId).find((o) => o.id === orderId);
      return order ? toView(order) : null;
    },

    async countByStatus(storeId, status) {
      return inStore(storeId).filter((o) => o.status === status).length;
    },
  };
}

/** A fixed test key for the order link cipher (32 zero-ish bytes as base64url). */
export const TEST_LINK_KEY = 'A'.repeat(43);

/**
 * Starts the real app (public and order routes over the real order service) with in-memory repositories. Returns the app
 * helpers plus the fake order repository, the public fake repository and a mutable clock.
 */
export async function startOrderApp({ config = {}, appOptions = {}, tokens = null, kick = null } = {}) {
  const kicks = [];
  const linkCipher = createLinkCipher(TEST_LINK_KEY);
  const outbox = createFakeOutbox({ clock: { get now() { return clock.now; } } });
  const repo = createFakePublicRepo();
  const clock = { now: Date.parse('2026-11-16T10:00:00Z') };
  const logs = createLogCollector();
  let app;
  const ownsStore = (storeId, ownerId) => app.storesRepo.rows.some((row) => row.id === storeId && row.ownerId === ownerId);
  const ownerEmailOf = (storeId) => {
    const ownerId = app.storesRepo.rows.find((row) => row.id === storeId)?.ownerId;
    return app.ownersRepo.rows.find((row) => row.id === ownerId)?.email ?? null;
  };
  const orderRepo = createFakeOrderRepo({ publicRepo: repo, ownsStore, clock, outbox, ownerEmailOf });
  const wake = kick ?? (() => kicks.push(1));
  const orders = createOrderService({ orders: orderRepo, shops: repo, logger: logs, now: () => clock.now, linkCipher, kick: wake, ...(tokens ? { newToken: tokens } : {}) });
  app = await startPublicApp({ config, appOptions, repo, extraServices: { orders } });
  return { ...app, orderRepo, orders, orderClock: clock, orderLogs: logs, outbox, linkCipher, kicks };
}
