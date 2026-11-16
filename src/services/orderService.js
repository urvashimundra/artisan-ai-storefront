import { LANGUAGE_NAMES, pickField, resolveLanguage } from '../domain/language.js';
import {
  ACTORS, ORDER_EXPIRY_MINUTES, ORDER_STATUSES, STATUS, MAX_QUANTITY, MAX_UTR_SUBMISSIONS, checkoutSchema, customerActions, isPastDeadline, ownerActions, priceOrder,
  secondsUntil, utrSchema,
} from '../domain/orderRules.js';
import { themeClass } from '../domain/palette.js';
import { fillTemplate, stringsFor } from '../domain/publicStrings.js';
import { qrPath } from '../domain/qrMatrix.js';
import { productPath, shopPath, withLang } from '../domain/seo.js';
import { LANGUAGES } from '../domain/storeRules.js';
import { buildUpiUri, isValidVpa } from '../domain/upi.js';
import { buildWhatsappLink } from '../domain/whatsapp.js';
import { AppError, notFound } from '../lib/errors.js';
import { formatInr } from '../lib/money.js';
import { generateStatusToken, hashStatusToken, isWellFormedToken } from '../lib/statusToken.js';
import { isProductId, normalizeSlug } from './publicShopService.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const HTTP_INTERNAL_ERROR = 500;
const PAYABLE = new Set([STATUS.AWAITING_PAYMENT, STATUS.NOT_RECEIVED]);
const STATUS_STRING_KEYS = Object.freeze({
  awaiting_payment: 'statusAwaitingPayment',
  payment_submitted: 'statusPaymentSubmitted',
  paid: 'statusPaid',
  not_received: 'statusNotReceived',
  cancelled: 'statusCancelled',
});
const HELP_STRING_KEYS = Object.freeze({
  awaiting_payment: 'helpAwaitingPayment',
  payment_submitted: 'helpPaymentSubmitted',
  paid: 'helpPaid',
  not_received: 'helpNotReceived',
});
const LOCALES = Object.freeze({ en: 'en-IN', gu: 'gu-IN', hi: 'hi-IN' });
const INDIA_TIME_ZONE = 'Asia/Kolkata';
const CANCEL_STRING_KEYS = Object.freeze({ expired: 'cancelledExpired', customer: 'cancelledCustomer', owner: 'cancelledOwner' });

/** Failure reasons from the database functions, as AppErrors. Codes are stable; controllers map them to messages. */
const REASON_ERRORS = Object.freeze({
  not_found: () => notFound('Order not found'),
  invalid: () => new AppError('INVALID_ORDER', HTTP_BAD_REQUEST, 'Invalid order'),
  invalid_transition: () => new AppError('ORDER_STATE', HTTP_CONFLICT, 'This order cannot be changed that way'),
  expired: () => new AppError('ORDER_EXPIRED', HTTP_CONFLICT, 'This order has expired'),
  attempt_limit: () => new AppError('UTR_ATTEMPT_LIMIT', HTTP_CONFLICT, 'Too many payment references'),
  utr_in_use: () => new AppError('UTR_IN_USE', HTTP_CONFLICT, 'This payment reference was already used'),
  product_unavailable: () => new AppError('PRODUCT_UNAVAILABLE', HTTP_CONFLICT, 'This product is not available'),
  price_changed: () => new AppError('PRICE_CHANGED', HTTP_CONFLICT, 'The price changed'),
  insufficient_stock: () => new AppError('OUT_OF_STOCK', HTTP_CONFLICT, 'Not enough stock'),
  payee_changed: () => new AppError('PAYMENT_UNAVAILABLE', HTTP_CONFLICT, 'Payment is not available right now'),
  store_not_found: () => notFound('Order not found'),
});

/**
 * Throws the AppError for a failed database-function result; returns the result when it succeeded.
 * @param {{ ok: boolean, reason: string | null }} result
 * @returns {object}
 */
export function ensureOk(result) {
  if (result.ok) return result;
  const make = REASON_ERRORS[result.reason];
  throw make ? make() : new AppError('INTERNAL_ERROR', HTTP_INTERNAL_ERROR, 'Something went wrong', { reason: result.reason });
}

const amountText = (paise) => formatInr(paise, { omitZeroFraction: false });

/** @param {string | null} iso @param {string} language @returns {string | null} Date and time in India time, in the page language. */
export function formatExpiry(iso, language) {
  return iso ? new Date(iso).toLocaleString(LOCALES[language] ?? LOCALES.en, { timeZone: INDIA_TIME_ZONE, dateStyle: 'medium', timeStyle: 'short' }) : null;
}

function whatsappLinkFor(shop, message) {
  return shop.whatsappEnabled && shop.whatsappNumber ? buildWhatsappLink(shop.whatsappNumber, message) : null;
}

function languageLinks(path, current) {
  return LANGUAGES.map((lang) => ({ lang, name: LANGUAGE_NAMES[lang], href: `${path}?lang=${lang}`, current: lang === current }));
}

function lineView(item) {
  return { title: item.title, titleLang: item.titleLang, quantity: item.quantity, unitPrice: amountText(item.unitPricePaise), lineTotal: amountText(item.lineTotalPaise) };
}

/** The payment block (link, QR, VPA), present only while the order can still be paid. Link and QR share one string. */
function paymentView(order, shop, strings) {
  if (!PAYABLE.has(order.status) || !isValidVpa(order.payeeVpa)) return null;
  const upiUri = buildUpiUri({ vpa: order.payeeVpa, name: shop.name, amountPaise: order.totalPaise, orderRef: order.reference });
  const values = { amount: amountText(order.totalPaise), payee: shop.name, ref: order.reference };
  return {
    upiUri,
    qr: qrPath(upiUri),
    vpa: order.payeeVpa,
    qrDescription: fillTemplate(strings.qrDescription, values),
    instructions: fillTemplate(strings.payInstructions, values),
  };
}

/**
 * The deadline shown to the customer. Only an order still waiting for payment has one. The browser counts down from
 * `secondsLeft` (computed from the server clock) and reloads the page at zero; the server alone decides what happens then.
 */
function countdownView(order, nowMs) {
  const waiting = PAYABLE.has(order.status) && order.expiresAt;
  return waiting ? { expiresAt: order.expiresAt, serverNow: new Date(nowMs).toISOString(), secondsLeft: secondsUntil(order.expiresAt, nowMs) } : null;
}

/** An order past its deadline is shown as expired even if the sweep has not recorded it yet. */
const effectiveOrder = (order, nowMs) =>
  isPastDeadline(order, nowMs) ? { ...order, status: STATUS.CANCELLED, cancelReason: 'expired', expiresAt: null } : order;

function statusHelp(order, strings) {
  if (order.status === STATUS.CANCELLED) return strings[CANCEL_STRING_KEYS[order.cancelReason]];
  return strings[order.status === STATUS.PAYMENT_SUBMITTED ? 'reservationHeld' : HELP_STRING_KEYS[order.status]];
}

/**
 * Pure view model of the customer's private status page.
 * @param {{ order: object, language: string, statusPath: string, nowMs?: number }} input order comes from the repository
 *   (with `shop`). nowMs is the server clock; an order past its deadline is rendered as expired whatever its stored status.
 * @returns {object}
 */
export function buildStatusView({ order: stored, language, statusPath, nowMs = Date.now() }) {
  const order = effectiveOrder(stored, nowMs);
  const strings = stringsFor(language);
  const { shop } = order;
  const amount = amountText(order.totalPaise);
  const actions = customerActions(order.status);
  const message = fillTemplate(strings.orderWhatsappToSeller, { shop: shop.name, ref: order.reference, amount });
  const expired = order.status === STATUS.CANCELLED && order.cancelReason === 'expired';
  return {
    kind: 'order',
    language,
    strings,
    themeClass: themeClass(shop.accentKey),
    shop: { name: shop.name, lang: shop.defaultLanguage },
    shopHref: withLang(shopPath(shop.slug), language, shop.defaultLanguage),
    languageLinks: languageLinks(statusPath, language),
    meta: { title: fillTemplate(strings.orderPageTitle, { ref: order.reference }), robots: 'noindex, nofollow' },
    order: {
      reference: order.reference,
      status: order.status,
      statusLabel: strings[STATUS_STRING_KEYS[order.status]],
      help: statusHelp(order, strings),
      total: amount,
      items: order.items.map(lineView),
      expiresText: PAYABLE.has(order.status) ? formatExpiry(order.expiresAt, language) : null,
      countdown: countdownView(order, nowMs),
      reservationNote: fillTemplate(strings.reservationNote, { minutes: String(ORDER_EXPIRY_MINUTES) }),
      expired,
      attemptsText: fillTemplate(strings.attemptsLeft, { count: String(Math.max(0, MAX_UTR_SUBMISSIONS - order.utrSubmissions)) }),
      utr: order.utr,
      canSubmitUtr: actions.canSubmitUtr && order.utrSubmissions < MAX_UTR_SUBMISSIONS,
      canCancel: actions.canCancel,
    },
    paths: { status: statusPath, utr: `${statusPath}/utr`, cancel: `${statusPath}/cancel` },
    payment: paymentView(order, shop, strings),
    whatsappUrl: whatsappLinkFor(shop, message),
  };
}

/**
 * Owner-side prefilled WhatsApp link to the customer, written in the customer's language.
 * @param {object} order With customerPhone, reference, status, language.
 * @param {string} shopName
 * @returns {string}
 */
export function buildOwnerWhatsappLink(order, shopName) {
  const strings = stringsFor(order.language);
  const message = fillTemplate(strings.orderWhatsappToBuyer, { shop: shopName, ref: order.reference, status: strings[STATUS_STRING_KEYS[order.status]] });
  return buildWhatsappLink(order.customerPhone, message);
}

/**
 * Orders: the customer side (checkout, private status page, UTR, cancel) and the owner side (list, detail, resolve, cancel).
 * The service validates and prices in the domain; the database functions execute every state change atomically. The
 * client sends only the product id, quantity and contact details: store, price, title, payee and totals are resolved here.
 * @param {{ orders: ReturnType<import('../repositories/orderRepository.js').createOrderRepository>,
 *   shops: { findShopBySlug: Function, findPublished: Function }, logger: { info: Function, warn: Function },
 *   newToken?: () => string, now?: () => number }} deps. `now` is the server clock (epoch ms), injectable for tests.
 */
export function createOrderService({ orders, shops, logger, newToken = generateStatusToken, now = Date.now }) {
  /** A product at stock 0 may only be held by overdue orders: release those first so it is not shown as sold out. */
  async function findFreshProduct(storeId, productId) {
    const product = await shops.findPublished(storeId, productId);
    if (!product || product.stock !== 0 || (await orders.expireOverdue(storeId, [productId])) === 0) return product;
    return shops.findPublished(storeId, productId);
  }

  async function checkoutContext(slug, productId, prefs) {
    const parsed = normalizeSlug(slug);
    if (!parsed || !isProductId(productId)) return null;
    const shop = await shops.findShopBySlug(parsed.slug);
    if (!shop) return null;
    const product = await findFreshProduct(shop.id, productId);
    const payee = product ? await orders.findPayee(shop.id) : null;
    if (!product || !payee || !isValidVpa(payee.upiId)) return null;
    const { language } = resolveLanguage({ ...prefs, shopDefault: shop.defaultLanguage });
    const title = pickField(product.translations, 'title', language, shop.defaultLanguage);
    return title ? { shop, payee, product, title, language } : null;
  }

  function checkoutView(context, values = {}, errors = {}) {
    const { shop, product, title, language } = context;
    const strings = stringsFor(language);
    const path = productPath(shop.slug, product.id);
    return {
      kind: 'checkout',
      language,
      strings,
      themeClass: themeClass(shop.accentKey),
      shop: { name: shop.name, lang: shop.defaultLanguage },
      shopHref: withLang(shopPath(shop.slug), language, shop.defaultLanguage),
      languageLinks: languageLinks(`${path}/buy`, language),
      meta: { title: fillTemplate(strings.checkoutPageTitle, { product: title.text }), robots: 'noindex, nofollow' },
      checkout: {
        title,
        price: amountText(product.pricePaise),
        soldOut: product.stock === 0,
        maxQuantity: product.stock === null ? MAX_QUANTITY : Math.min(MAX_QUANTITY, product.stock),
        stockLimited: product.stock !== null && product.stock < MAX_QUANTITY,
        stockText: product.stock === null ? null : fillTemplate(strings.stockAvailable, { count: String(product.stock) }),
        reservationNote: fillTemplate(strings.checkoutReservationNote, { minutes: String(ORDER_EXPIRY_MINUTES) }),
        productHref: withLang(path, language, shop.defaultLanguage),
        action: `${path}/buy?lang=${language}`,
        values,
        errors,
      },
    };
  }

  const sweep = (storeId) => orders.expireOverdue(storeId);

  /** Loads the customer's order, sweeping overdue orders first so an expired order is never shown as payable. */
  async function loadOrder(token) {
    if (!isWellFormedToken(token)) return null;
    const tokenHash = hashStatusToken(token);
    const order = await orders.findByTokenHash(tokenHash);
    if (!order) return null;
    if (!PAYABLE.has(order.status) || (await sweep(order.storeId)) === 0) return { order, tokenHash };
    return { order: (await orders.findByTokenHash(tokenHash)) ?? order, tokenHash };
  }

  async function requireOrder(token) {
    const loaded = await loadOrder(token);
    if (!loaded) throw notFound('Order not found');
    return loaded;
  }

  return {
    /** @returns {Promise<{ view: object, language: string } | null>} null when the shop or product is not buyable here. */
    async getCheckoutPage(slug, productId, prefs) {
      const context = await checkoutContext(slug, productId, prefs);
      return context ? { language: context.language, view: checkoutView(context) } : null;
    },

    /** @returns {Promise<boolean>} True when "Buy now" may be shown: valid payee VPA and in stock. */
    async canBuy(slug, productId, prefs) {
      const context = await checkoutContext(slug, productId, prefs);
      return Boolean(context) && context.product.stock !== 0;
    },

    /** The checkout page again after a validation or business error, with the typed values (never contains a token). */
    async getCheckoutPageWithErrors(slug, productId, prefs, values, errors) {
      const context = await checkoutContext(slug, productId, prefs);
      return context ? { language: context.language, view: checkoutView(context, values, errors) } : null;
    },

    /**
     * Places an order for one product. Throws ZodError for a bad form and AppError for business failures.
     * @returns {Promise<{ token: string, reference: string }>} The raw token is returned ONCE, for the redirect.
     */
    async placeOrder(slug, productId, prefs, body) {
      const form = checkoutSchema.parse(body ?? {});
      const context = await checkoutContext(slug, productId, prefs);
      if (!context) throw notFound('Product not found');
      const { shop, payee, product, title, language } = context;
      const { lines, totalPaise } = priceOrder([{ productId: product.id, quantity: form.quantity }], [{ ...product, status: 'published' }]);
      const token = newToken();
      const result = ensureOk(
        await orders.placeOrder(shop.id, {
          tokenHash: hashStatusToken(token),
          payeeVpa: payee.upiId,
          customerName: form.name,
          customerPhone: form.phone,
          customerEmail: form.email,
          deliveryAddress: form.address,
          language,
          totalPaise,
          lines: lines.map((line) => ({ ...line, title: title.text, titleLang: title.lang })),
        }),
      );
      logger.info('order placed', { storeId: shop.id, orderId: result.orderId, reference: result.reference });
      return { token, reference: result.reference };
    },

    /** @returns {Promise<{ view: object, language: string } | null>} null for any unknown or malformed token. */
    async getStatusPage(token, prefs) {
      const loaded = await loadOrder(token);
      if (!loaded) return null;
      const { language } = resolveLanguage({ ...prefs, shopDefault: loaded.order.language });
      return { language, view: buildStatusView({ order: loaded.order, language, statusPath: `/o/${token}`, nowMs: now() }) };
    },

    /** Records the customer's UTR (12 digits). Throws ZodError, or AppError for state, limit and reuse problems. */
    async submitUtr(token, body) {
      const { order, tokenHash } = await requireOrder(token);
      const { utr } = utrSchema.parse(body ?? {});
      if (order.status === STATUS.CANCELLED && order.cancelReason === 'expired') throw REASON_ERRORS.expired();
      ensureOk(await orders.submitPaymentReference(order.storeId, tokenHash, utr));
      logger.info('payment reference submitted', { storeId: order.storeId, orderId: order.id });
    },

    /** The customer cancels (only while awaiting payment or not received). Repeating it is harmless. */
    async cancelByCustomer(token) {
      const { order, tokenHash } = await requireOrder(token);
      ensureOk(await orders.cancelOrder(order.storeId, { orderId: order.id, actor: ACTORS.CUSTOMER, tokenHash }));
      logger.info('order cancelled', { storeId: order.storeId, orderId: order.id, actor: ACTORS.CUSTOMER });
    },

    /** @param {string} storeId From the session. @param {string | null} status Optional filter. */
    async listForOwner(storeId, status) {
      const filter = ORDER_STATUSES.includes(status) ? status : null;
      await sweep(storeId);
      return { filter, orders: await orders.listForOwner(storeId, { status: filter }) };
    },

    /** @returns {Promise<{ order: object, actions: object, whatsappUrl: string | null } | null>} */
    async getForOwner(store, orderId) {
      if (!isProductId(orderId)) return null;
      await sweep(store.id);
      const order = await orders.findForOwner(store.id, orderId);
      if (!order) return null;
      return { order, actions: ownerActions(order.status), whatsappUrl: buildOwnerWhatsappLink(order, store.name) };
    },

    /** Owner marks a submitted payment as received or not received. */
    async resolvePayment(store, orderId, outcome) {
      if (!isProductId(orderId)) throw notFound('Order not found');
      ensureOk(await orders.resolvePayment(store.id, store.ownerId, orderId, outcome));
      logger.info('payment resolved', { storeId: store.id, orderId, outcome });
    },

    async cancelByOwner(store, orderId) {
      if (!isProductId(orderId)) throw notFound('Order not found');
      ensureOk(await orders.cancelOrder(store.id, { orderId, actor: ACTORS.OWNER, ownerId: store.ownerId }));
      logger.info('order cancelled', { storeId: store.id, orderId, actor: ACTORS.OWNER });
    },

    /** @returns {Promise<number>} Orders waiting for the owner to check a payment (the dashboard badge). */
    pendingCount: (storeId) => orders.countByStatus(storeId, STATUS.PAYMENT_SUBMITTED),
  };
}
