import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import { cleanLine, codePointLength, normalizeParagraph } from './productRules.js';

/** Limits. Mirrored in db/migrations/008_orders.sql (a unit test compares them). */
export const MIN_QUANTITY = 1;
export const MAX_QUANTITY = 20;
export const ORDER_EXPIRY_MINUTES = 60;
export const MAX_UTR_SUBMISSIONS = 3;
export const MAX_CUSTOMER_NAME_LENGTH = 80;
export const MAX_ADDRESS_LENGTH = 300;
export const MAX_EMAIL_LENGTH = 254;
export const UTR_PATTERN = /^[0-9]{12}$/;
export const REFERENCE_PATTERN = /^AS[0-9]{4,9}$/;
export const ORDER_LANGUAGES = Object.freeze(['en', 'gu', 'hi']);

export const STATUS = Object.freeze({
  AWAITING_PAYMENT: 'awaiting_payment',
  PAYMENT_SUBMITTED: 'payment_submitted',
  PAID: 'paid',
  NOT_RECEIVED: 'not_received',
  CANCELLED: 'cancelled',
});
export const ORDER_STATUSES = Object.freeze(Object.values(STATUS));
export const CANCEL_REASONS = Object.freeze(['expired', 'customer', 'owner']);
export const ACTORS = Object.freeze({ CUSTOMER: 'customer', OWNER: 'owner', SYSTEM: 'system' });

const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const RAW_FIELD_FACTOR = 4;
const INDIA_COUNTRY_CODE = '91';
const LEADING_PLUS = /^\+/;
const COUNTRY_CODE_LENGTH = 12;
const TRUNK_ZERO_LENGTH = 11;
const LOCAL_MOBILE = /^[6-9]\d{9}$/;
const PHONE_SEPARATORS = /[\s\-().]/g;
const PHONE_SHAPE = /^\+?\d{10,13}$/;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const FORM_QUANTITY = /^\d{1,2}$/;

const { AWAITING_PAYMENT, PAYMENT_SUBMITTED, PAID, NOT_RECEIVED, CANCELLED } = STATUS;

/** Allowed transitions per actor. Everything else is rejected. Customers can never reach `paid` or `not_received`. */
const TRANSITIONS = Object.freeze({
  [ACTORS.CUSTOMER]: {
    [AWAITING_PAYMENT]: [PAYMENT_SUBMITTED, CANCELLED],
    [NOT_RECEIVED]: [PAYMENT_SUBMITTED, CANCELLED],
  },
  [ACTORS.OWNER]: {
    [AWAITING_PAYMENT]: [CANCELLED],
    [PAYMENT_SUBMITTED]: [PAID, NOT_RECEIVED, CANCELLED],
    [NOT_RECEIVED]: [CANCELLED],
  },
  [ACTORS.SYSTEM]: {
    [AWAITING_PAYMENT]: [CANCELLED],
    [NOT_RECEIVED]: [CANCELLED],
  },
});

/**
 * @param {string} actor customer | owner | system (expiry)
 * @param {string} from
 * @param {string} to
 * @returns {boolean} True when the actor may move an order from `from` to `to`. Paid and cancelled are terminal.
 */
export function canTransition(actor, from, to) {
  return TRANSITIONS[actor]?.[from]?.includes(to) ?? false;
}

/** @param {string} status @returns {{ canMarkPaid: boolean, canMarkNotReceived: boolean, canCancel: boolean }} */
export function ownerActions(status) {
  return {
    canMarkPaid: canTransition(ACTORS.OWNER, status, PAID),
    canMarkNotReceived: canTransition(ACTORS.OWNER, status, NOT_RECEIVED),
    canCancel: canTransition(ACTORS.OWNER, status, CANCELLED),
  };
}

/** @param {string} status @returns {{ canSubmitUtr: boolean, canCancel: boolean }} */
export function customerActions(status) {
  return {
    canSubmitUtr: canTransition(ACTORS.CUSTOMER, status, PAYMENT_SUBMITTED),
    canCancel: canTransition(ACTORS.CUSTOMER, status, CANCELLED),
  };
}

/**
 * Normalises an Indian mobile number typed by a customer. Accepts 10 digits, 91 plus 10, +91 plus 10, or 0 plus 10, with
 * spaces, dashes or brackets. The stored form is 91 followed by ten digits starting 6 to 9.
 * @param {unknown} input
 * @returns {string | null}
 */
export function normalizeIndianMobile(input) {
  if (typeof input !== 'string' || input.length > MAX_CUSTOMER_NAME_LENGTH) return null;
  const compact = input.replace(PHONE_SEPARATORS, '');
  if (!PHONE_SHAPE.test(compact)) return null;
  const digits = compact.replace(LEADING_PLUS, '');
  const hasCountryCode = digits.length === COUNTRY_CODE_LENGTH && digits.startsWith(INDIA_COUNTRY_CODE);
  const hasTrunkZero = digits.length === TRUNK_ZERO_LENGTH && digits.startsWith('0');
  const local = hasCountryCode ? digits.slice(INDIA_COUNTRY_CODE.length) : hasTrunkZero ? digits.slice(1) : digits;
  return LOCAL_MOBILE.test(local) ? `${INDIA_COUNTRY_CODE}${local}` : null;
}

const rawLimit = (limit) => limit * RAW_FIELD_FACTOR;
const withinCodePoints = (limit) => (value) => codePointLength(value) <= limit;

const quantityField = z
  .string()
  .regex(FORM_QUANTITY)
  .transform(Number)
  .pipe(z.number().int().min(MIN_QUANTITY).max(MAX_QUANTITY));

const phoneField = z
  .string()
  .max(MAX_CUSTOMER_NAME_LENGTH)
  .transform((value, ctx) => {
    const normalized = normalizeIndianMobile(value.trim());
    if (!normalized) ctx.addIssue({ code: 'custom', message: 'invalid_phone' });
    return normalized;
  });

const emailField = z
  .string()
  .max(MAX_EMAIL_LENGTH)
  .transform((value) => value.trim())
  .refine((value) => value === '' || (value.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(value)), { message: 'invalid_email' })
  .transform((value) => (value === '' ? null : value));

const addressField = z
  .string()
  .max(rawLimit(MAX_ADDRESS_LENGTH))
  .transform(normalizeParagraph)
  .refine(withinCodePoints(MAX_ADDRESS_LENGTH), { message: 'invalid_address' })
  .transform((value) => (value === '' ? null : value));

/**
 * The checkout form. Strict: unknown keys (store_id, price, title, vpa, total, status, owner...) are rejected. Output is
 * camelCase and ready to use. The client sends no price and no product id here (the product comes from the URL).
 */
export const checkoutSchema = z
  .object({
    quantity: quantityField,
    name: z.string().max(rawLimit(MAX_CUSTOMER_NAME_LENGTH)).transform(cleanLine).refine((v) => v.length > 0 && withinCodePoints(MAX_CUSTOMER_NAME_LENGTH)(v), { message: 'invalid_name' }),
    phone: phoneField,
    email: emailField.optional().transform((value) => value ?? null),
    address: addressField.optional().transform((value) => value ?? null),
  })
  .strict();

/** The UTR form: exactly 12 digits (surrounding whitespace is ignored). Strict. */
export const utrSchema = z
  .object({ utr: z.string().max(MAX_CUSTOMER_NAME_LENGTH).transform((value) => value.trim()).pipe(z.string().regex(UTR_PATTERN)) })
  .strict();

const appError = (code, status, message) => new AppError(code, status, message);

/**
 * Prices a one-or-more-line order in integer paise. Pure: the caller read the products from the store already resolved
 * server-side. Rejects unpublished products, duplicates, bad quantities and insufficient stock (stock NULL = unlimited).
 * @param {{ productId: string, quantity: number }[]} requests
 * @param {{ id: string, status: string, pricePaise: number | null, stock: number | null }[]} products
 * @returns {{ lines: { productId: string, quantity: number, unitPricePaise: number, lineTotalPaise: number }[], totalPaise: number }}
 * @throws {AppError} INVALID_ORDER | PRODUCT_UNAVAILABLE | OUT_OF_STOCK
 */
export function priceOrder(requests, products) {
  const ids = requests.map((line) => line.productId);
  if (requests.length === 0 || new Set(ids).size !== ids.length) throw appError('INVALID_ORDER', HTTP_BAD_REQUEST, 'Invalid order');
  const lines = requests.map((request) => priceLine(request, products.find((product) => product.id === request.productId)));
  const totalPaise = lines.reduce((sum, line) => sum + line.lineTotalPaise, 0);
  if (!Number.isSafeInteger(totalPaise)) throw appError('INVALID_ORDER', HTTP_BAD_REQUEST, 'Invalid order');
  return { lines, totalPaise };
}

function priceLine({ productId, quantity }, product) {
  if (!Number.isInteger(quantity) || quantity < MIN_QUANTITY || quantity > MAX_QUANTITY) {
    throw appError('INVALID_ORDER', HTTP_BAD_REQUEST, 'Invalid quantity');
  }
  if (!product || product.status !== 'published' || !Number.isSafeInteger(product.pricePaise) || product.pricePaise <= 0) {
    throw appError('PRODUCT_UNAVAILABLE', HTTP_CONFLICT, 'This product is not available');
  }
  if (product.stock !== null && product.stock < quantity) throw appError('OUT_OF_STOCK', HTTP_CONFLICT, 'Not enough stock');
  const lineTotalPaise = product.pricePaise * quantity;
  if (!Number.isSafeInteger(lineTotalPaise)) throw appError('INVALID_ORDER', HTTP_BAD_REQUEST, 'Invalid order');
  return { productId, quantity, unitPricePaise: product.pricePaise, lineTotalPaise };
}
