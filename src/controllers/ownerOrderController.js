import { MAX_UTR_SUBMISSIONS, ORDER_STATUSES, lastAttemptUsed } from '../domain/orderRules.js';
import { AppError } from '../lib/errors.js';
import { formatInr } from '../lib/money.js';
import { MAX_LISTED_ORDERS } from '../repositories/orderRepository.js';

const SEE_OTHER = 303;
const HTTP_NOT_FOUND = 404;
const INDIA_TIME_ZONE = 'Asia/Kolkata';
const DONE_NOTICES = Object.freeze({ paid: 'Marked as paid.', not_received: 'Marked as payment not received. The customer can send a new UTR.', cancelled: 'Order cancelled.',
  cancelled_utr: `Marked as payment not received. This was attempt ${MAX_UTR_SUBMISSIONS} of ${MAX_UTR_SUBMISSIONS}, so the order was cancelled and the customer was told.`,
});
const OWNER_STATUS_LABELS = Object.freeze({
  awaiting_payment: 'Awaiting payment',
  payment_submitted: 'Payment submitted: check your bank',
  paid: 'Paid',
  not_received: 'Payment not received',
  cancelled: 'Cancelled',
});
/** Compact labels for the list badges (the detail page keeps the full wording). */
const LIST_STATUS_LABELS = Object.freeze({ ...OWNER_STATUS_LABELS, payment_submitted: 'Payment submitted' });
const CANCEL_REASON_LABELS = Object.freeze({
  expired: 'Expired (no payment in time)',
  customer: 'Cancelled by the customer',
  owner: 'Cancelled by you',
  utr_attempts_exhausted: `Cancelled: payment not verified after ${MAX_UTR_SUBMISSIONS} attempts`,
});
const STATE_ERROR = 'state';
const COUNTRY_PREFIX = '91';
const PHONE_SPLIT = 5;

/**
 * @param {string} phone Stored as 91 followed by ten digits.
 * @returns {string} For example "+91 98765 43210"; anything unexpected is returned unchanged.
 */
export function formatPhone(phone) {
  const local = phone.startsWith(COUNTRY_PREFIX) ? phone.slice(COUNTRY_PREFIX.length) : null;
  return local?.length === PHONE_SPLIT * 2 ? `+${COUNTRY_PREFIX} ${local.slice(0, PHONE_SPLIT)} ${local.slice(PHONE_SPLIT)}` : phone;
}

/**
 * @param {{ title: string, quantity: number }[]} items
 * @returns {{ first: string, quantity: number, more: number, units: number }} The first line, how many further lines, total units.
 */
export function summarizeItems(items) {
  const [first] = items;
  return { first: first?.title ?? '', quantity: first?.quantity ?? 0, more: Math.max(0, items.length - 1), units: items.reduce((sum, item) => sum + item.quantity, 0) };
}

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
  phone: formatPhone(order.customerPhone),
  items: summarizeItems(order.items ?? []),
  total: formatInr(order.totalPaise),
  status: order.status,
  statusLabel: LIST_STATUS_LABELS[order.status],
});

/** Counts per status over ALL of the store's orders; only called when the list is complete (fewer than the list limit). */
function statusSummary(rows) {
  return ORDER_STATUSES.map((value) => ({ value, label: LIST_STATUS_LABELS[value], count: rows.filter((row) => row.status === value).length }));
}

/**
 * Owner Orders pages. The store always comes from the session (`req.store`); an order id from the URL is only ever looked
 * up inside that store. State changes redirect back to the detail page (POST, redirect, GET).
 * @param {{ orders: ReturnType<import('../services/orderService.js').createOrderService> }} deps
 */
export function createOwnerOrderController({ orders }) {
  const detailPath = (id, query = '') => `/orders/${id}${query}`;

  async function change(req, res, action, done) {
    let outcome;
    try {
      outcome = await action(req.store, req.params.id);
    } catch (error) {
      if (error instanceof AppError && error.code === 'ORDER_STATE') return res.redirect(SEE_OTHER, detailPath(req.params.id, `?error=${STATE_ERROR}`));
      throw error;
    }
    return res.redirect(SEE_OTHER, detailPath(req.params.id, `?done=${outcome?.cancelled ? 'cancelled_utr' : done}`));
  }

  return {
    async list(req, res) {
      const status = typeof req.query?.status === 'string' ? req.query.status : null;
      const { filter, orders: rows } = await orders.listForOwner(req.store.id, status);
      const statuses = ORDER_STATUSES.map((value) => ({ value, label: OWNER_STATUS_LABELS[value], selected: value === filter }));
      const summary = filter || rows.length >= MAX_LISTED_ORDERS ? null : statusSummary(rows);
      return res.render('orders', { title: 'Orders', wide: true, rows: rows.map(toRow), statuses, filter, summary });
    },

    async detail(req, res) {
      const found = await orders.getForOwner(req.store, req.params.id);
      if (!found) return res.status(HTTP_NOT_FOUND).render('error', { title: 'Page not found', status: HTTP_NOT_FOUND, message: 'Order not found', correlationId: req.correlationId });
      const { order, actions, whatsappUrl } = found;
      const done = DONE_NOTICES[req.query?.done] ?? null;
      const stateError = req.query?.error === STATE_ERROR;
      const view = {
        title: `Order ${order.reference}`,
        wide: true,
        order: {
          ...order,
          createdAt: formatIst(order.createdAt),
          expiresAt: formatIst(order.expiresAt),
          paidAt: formatIst(order.paidAt),
          submittedAt: order.utr ? formatIst(order.attempts.at(-1)?.createdAt) : '',
          total: formatInr(order.totalPaise),
          phone: formatPhone(order.customerPhone),
          units: summarizeItems(order.items).units,
          statusLabel: OWNER_STATUS_LABELS[order.status],
          cancelReasonLabel: CANCEL_REASON_LABELS[order.cancelReason] ?? null,
          items: order.items.map((item) => ({ ...item, unitPrice: formatInr(item.unitPricePaise), lineTotal: formatInr(item.lineTotalPaise) })),
          attempts: order.attempts.map((attempt) => ({ utr: attempt.utr, at: formatIst(attempt.createdAt) })),
        },
        actions,
        lastAttempt: lastAttemptUsed(order),
        maxAttempts: MAX_UTR_SUBMISSIONS,
        whatsappUrl,
        done,
        stateError,
      };
      return res.render('order-detail', view);
    },

    markPaid: (req, res) => change(req, res, (store, id) => orders.resolvePayment(store, id, 'paid'), 'paid'),
    markNotReceived: (req, res) => change(req, res, (store, id) => orders.resolvePayment(store, id, 'not_received'), 'not_received'),

    /** "Cancel this order?" confirmation. No side effects; an order that cannot be cancelled goes back to its detail page. */
    async confirmCancel(req, res) {
      const found = await orders.getForOwner(req.store, req.params.id);
      if (!found) return res.status(HTTP_NOT_FOUND).render('error', { title: 'Page not found', status: HTTP_NOT_FOUND, message: 'Order not found', correlationId: req.correlationId });
      if (!found.actions.canCancel) return res.redirect(SEE_OTHER, detailPath(req.params.id));
      return res.render('order-cancel-confirm', { title: `Cancel order ${found.order.reference}`, order: found.order });
    },
    cancel: (req, res) => change(req, res, (store, id) => orders.cancelByOwner(store, id), 'cancelled'),
  };
}
