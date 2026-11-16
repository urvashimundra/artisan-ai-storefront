import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import { UniqueViolation, throwIfError } from './pgErrors.js';
import { requireStoreId } from './requireStoreId.js';

const HTTP_INTERNAL_ERROR = 500;
const HTTP_CONFLICT = 409;
/** The most orders the owner list returns (newest first). */
export const MAX_LISTED_ORDERS = 200;

/*
 * Explicit column allowlists. status_token_hash is never selected: the hash is only ever a lookup key, and the raw token
 * exists only in the customer's link. Customer name, phone, email and address are selected only for the owner views and
 * for the customer's own status page.
 */
const ORDER_COLUMNS =
  'id, store_id, reference, status, cancel_reason, payee_vpa, total_paise, customer_name, customer_phone, customer_email, delivery_address, language, utr, utr_submissions, expires_at, paid_at, created_at, updated_at';
const ITEM_COLUMNS = 'order_items(position, product_id, title, title_lang, unit_price_paise, quantity, line_total_paise)';
const ATTEMPT_COLUMNS = 'order_payment_attempts(utr, created_at)';
const SHOP_COLUMNS = 'stores(name, slug, default_language, accent_key, whatsapp_number, whatsapp_enabled)';
const PAYEE_COLUMNS = 'id, name, slug, default_language, accent_key, upi_id, whatsapp_number, whatsapp_enabled';

const language = z.enum(['en', 'gu', 'hi']);
const itemRow = z.object({
  position: z.number().int(),
  product_id: z.uuid(),
  title: z.string(),
  title_lang: language,
  unit_price_paise: z.number().int(),
  quantity: z.number().int(),
  line_total_paise: z.number().int(),
});
const attemptRow = z.object({ utr: z.string(), created_at: z.string() });
const orderRow = z.object({
  id: z.uuid(),
  store_id: z.uuid(),
  reference: z.string(),
  status: z.string(),
  cancel_reason: z.string().nullable(),
  payee_vpa: z.string(),
  total_paise: z.number().int(),
  customer_name: z.string(),
  customer_phone: z.string(),
  customer_email: z.string().nullable(),
  delivery_address: z.string().nullable(),
  language,
  utr: z.string().nullable(),
  utr_submissions: z.number().int(),
  expires_at: z.string().nullable(),
  paid_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  order_items: z.array(itemRow).optional(),
  order_payment_attempts: z.array(attemptRow).optional(),
  stores: z
    .object({ name: z.string(), slug: z.string(), default_language: language, accent_key: z.string(), whatsapp_number: z.string().nullable(), whatsapp_enabled: z.boolean() })
    .optional(),
});
const payeeRow = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  default_language: language,
  accent_key: z.string(),
  upi_id: z.string().nullable(),
  whatsapp_number: z.string().nullable(),
  whatsapp_enabled: z.boolean(),
});
const rpcResult = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
  already: z.boolean().optional(),
  order_id: z.uuid().optional(),
  reference: z.string().optional(),
  expires_at: z.string().optional(),
});

function unexpected(operation) {
  return new AppError('DATABASE_ERROR', HTTP_INTERNAL_ERROR, 'Something went wrong', { operation, reason: 'unexpected_result_shape' });
}

function parse(schema, value, operation) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw unexpected(operation);
  return parsed.data;
}

const toItem = (row) => ({
  position: row.position,
  productId: row.product_id,
  title: row.title,
  titleLang: row.title_lang,
  unitPricePaise: row.unit_price_paise,
  quantity: row.quantity,
  lineTotalPaise: row.line_total_paise,
});

const toOrder = (row) => ({
  id: row.id,
  storeId: row.store_id,
  reference: row.reference,
  status: row.status,
  cancelReason: row.cancel_reason,
  payeeVpa: row.payee_vpa,
  totalPaise: row.total_paise,
  customerName: row.customer_name,
  customerPhone: row.customer_phone,
  customerEmail: row.customer_email,
  deliveryAddress: row.delivery_address,
  language: row.language,
  utr: row.utr,
  utrSubmissions: row.utr_submissions,
  expiresAt: row.expires_at,
  paidAt: row.paid_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  items: [...(row.order_items ?? [])].sort((a, b) => a.position - b.position).map(toItem),
  attempts: [...(row.order_payment_attempts ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at)).map((a) => ({ utr: a.utr, createdAt: a.created_at })),
  shop: row.stores
    ? {
        name: row.stores.name,
        slug: row.stores.slug,
        defaultLanguage: row.stores.default_language,
        accentKey: row.stores.accent_key,
        whatsappNumber: row.stores.whatsapp_number,
        whatsappEnabled: row.stores.whatsapp_enabled,
      }
    : null,
});

const toResult = (data) => ({
  ok: data.ok,
  reason: data.reason ?? null,
  already: data.already === true,
  orderId: data.order_id ?? null,
  reference: data.reference ?? null,
  expiresAt: data.expires_at ?? null,
});

/**
 * Orders persistence. Every business change is ONE Postgres function (see migration 008), so each is atomic. Every method
 * takes storeId first and scopes its query by it. The single documented exception is findByTokenHash: the customer's
 * private link carries only a token, whose SHA-256 is the lookup key; the store id is read from the order it finds.
 * @param {{ client: any }} deps
 */
export function createOrderRepository({ client }) {
  async function callRpc(operation, args) {
    const { data, error } = await client.rpc(operation, args);
    try {
      throwIfError(error);
    } catch (thrown) {
      if (thrown instanceof UniqueViolation) throw new AppError('ORDER_CONFLICT', HTTP_CONFLICT, 'Please try again', { operation, constraint: thrown.constraint });
      throw thrown;
    }
    return data;
  }

  const rpcOutcome = async (operation, args) => toResult(parse(rpcResult, await callRpc(operation, args), operation));
  const ordersOf = (storeId, columns) => client.from('orders').select(columns).eq('store_id', requireStoreId(storeId));

  return {
    /** The payee and shop display fields of a store, resolved server-side. @returns {Promise<object | null>} */
    async findPayee(storeId) {
      requireStoreId(storeId);
      const { data, error } = await client.from('stores').select(PAYEE_COLUMNS).eq('id', storeId).maybeSingle();
      throwIfError(error);
      if (!data) return null;
      const row = parse(payeeRow, data, 'orders.findPayee');
      return {
        id: row.id, name: row.name, slug: row.slug, defaultLanguage: row.default_language, accentKey: row.accent_key,
        upiId: row.upi_id, whatsappNumber: row.whatsapp_number, whatsappEnabled: row.whatsapp_enabled,
      };
    },

    /** place_order: all-or-nothing. @returns {Promise<{ ok: boolean, reason: string | null, orderId: string | null, reference: string | null, expiresAt: string | null }>} */
    placeOrder(storeId, order) {
      return rpcOutcome('place_order', {
        p_store_id: requireStoreId(storeId),
        p_token_hash: order.tokenHash,
        p_payee_vpa: order.payeeVpa,
        p_customer_name: order.customerName,
        p_customer_phone: order.customerPhone,
        p_customer_email: order.customerEmail,
        p_delivery_address: order.deliveryAddress,
        p_language: order.language,
        p_expected_total: order.totalPaise,
        p_items: order.lines.map((line) => ({
          product_id: line.productId,
          quantity: line.quantity,
          expected_price_paise: line.unitPricePaise,
          title: line.title,
          title_lang: line.titleLang,
        })),
      });
    },

    /** The customer's UTR, scoped by the status-token hash. */
    submitPaymentReference(storeId, tokenHash, utr) {
      return rpcOutcome('submit_payment_reference', { p_store_id: requireStoreId(storeId), p_token_hash: tokenHash, p_utr: utr });
    },

    /** Owner only: outcome is paid or not_received. The owner id must own the store (checked inside the function). */
    resolvePayment(storeId, ownerId, orderId, outcome) {
      return rpcOutcome('resolve_payment', { p_store_id: requireStoreId(storeId), p_owner_id: ownerId, p_order_id: orderId, p_outcome: outcome });
    },

    /** Cancels as the owner (ownerId) or as the customer (tokenHash). */
    cancelOrder(storeId, { orderId, actor, ownerId = null, tokenHash = null }) {
      const args = { p_store_id: requireStoreId(storeId), p_order_id: orderId, p_actor: actor, p_owner_id: ownerId, p_token_hash: tokenHash };
      return rpcOutcome('cancel_order', args);
    },

    /** Sweeps this store's overdue orders (database time). @returns {Promise<number>} how many were expired. */
    async expireOverdue(storeId, productIds = null) {
      const data = await callRpc('expire_overdue_orders', { p_store_id: requireStoreId(storeId), p_product_ids: productIds });
      return parse(z.number().int(), data, 'expire_overdue_orders');
    },

    /**
     * The one non-store-scoped lookup: the customer's order by the SHA-256 of the status token, with items and shop display
     * fields. @param {string} tokenHash @returns {Promise<object | null>}
     */
    async findByTokenHash(tokenHash) {
      const columns = `${ORDER_COLUMNS}, ${ITEM_COLUMNS}, ${SHOP_COLUMNS}`;
      const { data, error } = await client.from('orders').select(columns).eq('status_token_hash', tokenHash).maybeSingle();
      throwIfError(error);
      return data ? toOrder(parse(orderRow, data, 'orders.findByTokenHash')) : null;
    },

    /** Newest first, at most 200, with their lines; optional status filter. @returns {Promise<object[]>} */
    async listForOwner(storeId, { status = null } = {}) {
      let query = ordersOf(storeId, `${ORDER_COLUMNS}, ${ITEM_COLUMNS}`).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(MAX_LISTED_ORDERS);
      if (status) query = query.eq('status', status);
      const { data, error } = await query;
      throwIfError(error);
      return (data ?? []).map((row) => toOrder(parse(orderRow, row, 'orders.listForOwner')));
    },

    /** One order of this store with items and payment attempts. @returns {Promise<object | null>} */
    async findForOwner(storeId, orderId) {
      const { data, error } = await ordersOf(storeId, `${ORDER_COLUMNS}, ${ITEM_COLUMNS}, ${ATTEMPT_COLUMNS}`).eq('id', orderId).maybeSingle();
      throwIfError(error);
      return data ? toOrder(parse(orderRow, data, 'orders.findForOwner')) : null;
    },

    /** Number of this store's orders in a status (the dashboard badge). @returns {Promise<number>} */
    async countByStatus(storeId, status) {
      const { count, error } = await client.from('orders').select('id', { count: 'exact', head: true }).eq('store_id', requireStoreId(storeId)).eq('status', status);
      throwIfError(error);
      return count ?? 0;
    },
  };
}
