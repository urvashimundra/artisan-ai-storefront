import { ORDER_STATUSES } from '../domain/orderRules.js';
import { AppError } from '../lib/errors.js';
import { formatInr } from '../lib/money.js';

const SEE_OTHER = 303;
const HTTP_NOT_FOUND = 404;
const INDIA_TIME_ZONE = 'Asia/Kolkata';
const DONE_NOTICES = Object.freeze({ paid: 'Marked as paid.', not_received: 'Marked as payment not received. The customer can send a new UTR.', cancelled: 'Order cancelled.' });
const OWNER_STATUS_LABELS = Object.freeze({
  awaiting_payment: 'Awaiting payment',
  payment_submitted: 'Payment submitted: check your bank',
  paid: 'Paid',
  not_received: 'Payment not received',
  cancelled: 'Cancelled',
});
const CANCEL_REASON_LABELS = Object.freeze({ expired: 'Expired (no payment in time)', customer: 'Cancelled by the customer', owner: 'Cancelled by you' });
const STATE_ERROR = 'state';

/** @param {string | null} iso @returns {string} Date and time in India time, e.g. "16 Nov 2026, 3:05 pm". */
export function formatIst(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-IN', { timeZone: INDIA_TIME_ZONE, dateStyle: 'medium', timeStyle: 'short' });
}

const toRow = (order) => ({
  id: order.id,
  reference: order.reference,
  createdAt: formatIst(order.createdAt),
  customerName: order.customerName,
  total: formatInr(order.totalPaise),
  statusLabel: OWNER_STATUS_LABELS[order.status],
});

/**
 * Owner Orders pages. The store always comes from the session (`req.store`); an order id from the URL is only ever looked
 * up inside that store. State changes redirect back to the detail page (POST, redirect, GET).
 * @param {{ orders: ReturnType<import('../services/orderService.js').createOrderService> }} deps
 */
export function createOwnerOrderController({ orders }) {
  const detailPath = (id, query = '') => `/orders/${id}${query}`;

  async function change(req, res, action, done) {
    try {
      await action(req.store, req.params.id);
    } catch (error) {
      if (error instanceof AppError && error.code === 'ORDER_STATE') return res.redirect(SEE_OTHER, detailPath(req.params.id, `?error=${STATE_ERROR}`));
      throw error;
    }
    return res.redirect(SEE_OTHER, detailPath(req.params.id, `?done=${done}`));
  }

  return {
    async list(req, res) {
      const status = typeof req.query?.status === 'string' ? req.query.status : null;
      const { filter, orders: rows } = await orders.listForOwner(req.store.id, status);
      const statuses = ORDER_STATUSES.map((value) => ({ value, label: OWNER_STATUS_LABELS[value], selected: value === filter }));
      return res.render('orders', { title: 'Orders', rows: rows.map(toRow), statuses, filter });
    },

    async detail(req, res) {
      const found = await orders.getForOwner(req.store, req.params.id);
      if (!found) return res.status(HTTP_NOT_FOUND).render('error', { title: 'Page not found', status: HTTP_NOT_FOUND, message: 'Order not found', correlationId: req.correlationId });
      const { order, actions, whatsappUrl } = found;
      const done = DONE_NOTICES[req.query?.done] ?? null;
      const stateError = req.query?.error === STATE_ERROR;
      const view = {
        title: `Order ${order.reference}`,
        order: {
          ...order,
          createdAt: formatIst(order.createdAt),
          expiresAt: formatIst(order.expiresAt),
          paidAt: formatIst(order.paidAt),
          total: formatInr(order.totalPaise),
          statusLabel: OWNER_STATUS_LABELS[order.status],
          cancelReasonLabel: CANCEL_REASON_LABELS[order.cancelReason] ?? null,
          items: order.items.map((item) => ({ ...item, unitPrice: formatInr(item.unitPricePaise), lineTotal: formatInr(item.lineTotalPaise) })),
          attempts: order.attempts.map((attempt) => ({ utr: attempt.utr, at: formatIst(attempt.createdAt) })),
        },
        actions,
        whatsappUrl,
        done,
        stateError,
      };
      return res.render('order-detail', view);
    },

    markPaid: (req, res) => change(req, res, (store, id) => orders.resolvePayment(store, id, 'paid'), 'paid'),
    markNotReceived: (req, res) => change(req, res, (store, id) => orders.resolvePayment(store, id, 'not_received'), 'not_received'),
    cancel: (req, res) => change(req, res, (store, id) => orders.cancelByOwner(store, id), 'cancelled'),
  };
}
