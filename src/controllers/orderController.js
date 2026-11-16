import { ZodError } from 'zod';
import { LANGUAGE_COOKIE_NAME, resolveLanguage } from '../domain/language.js';
import { stringsFor } from '../domain/publicStrings.js';
import { productPath } from '../domain/seo.js';
import { AppError } from '../lib/errors.js';
import { parseCookies } from '../lib/cookies.js';
import { buildNoticePage } from '../services/publicShopService.js';
import { echoValues, fieldErrors } from './formErrors.js';

const SEE_OTHER = 303;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_INTERNAL_ERROR = 500;
const MAX_ECHO_LENGTH = 1200;
const CHECKOUT_FIELDS = ['quantity', 'name', 'phone', 'email', 'address'];
const CHECKOUT_FIELD_STRINGS = { quantity: 'errQuantity', name: 'errName', phone: 'errPhone', email: 'errEmail', address: 'errAddress' };
/** Business failures that the customer can read and act on, as string keys. Anything else goes to the generic error page. */
const ERROR_STRING_KEYS = Object.freeze({
  OUT_OF_STOCK: 'errOutOfStock',
  PRODUCT_UNAVAILABLE: 'errUnavailable',
  PRICE_CHANGED: 'errPriceChanged',
  PAYMENT_UNAVAILABLE: 'errPaymentUnavailable',
  ORDER_EXPIRED: 'errOrderExpired',
  ORDER_STATE: 'errOrderState',
  UTR_IN_USE: 'errUtrInUse',
  UTR_ATTEMPT_LIMIT: 'errUtrLimit',
});

/**
 * `same-origin` sends no Referer to any other site (so the private status link cannot leak) while same-origin form POSTs
 * keep their real Origin header. `no-referrer` must not be used: Chrome then sends `Origin: null` on those POSTs, which
 * the Origin check rightly rejects.
 */
export const ORDER_REFERRER_POLICY = 'same-origin';

/**
 * Privacy headers for every order response. The status link is a private capability: nothing may cache it, index it, or
 * leak it through a Referer header.
 * @type {import('express').RequestHandler}
 */
export function privacyHeaders(_req, res, next) {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': ORDER_REFERRER_POLICY });
  res.vary('Cookie').vary('Accept-Language');
  next();
}

const messagesFor = (strings, map) => Object.fromEntries(Object.entries(map).map(([field, key]) => [field, strings[key]]));

/**
 * HTTP layer for the customer's order pages (checkout, private status page, UTR, cancel). Validates the token shape before
 * any lookup, never logs a body, token or contact detail, and answers every unknown or malformed token identically.
 * @param {{ orders: ReturnType<import('../services/orderService.js').createOrderService> }} deps
 */
export function createOrderController({ orders }) {
  const preferences = (req) => ({
    query: req.query?.lang,
    cookie: parseCookies(req.get('cookie'))[LANGUAGE_COOKIE_NAME],
    acceptLanguage: req.get('accept-language'),
  });

  function sendNotice(req, res, { status, template, titleKey, bodyKey }) {
    const language = resolveLanguage({ ...preferences(req), shopDefault: 'en' }).language;
    res.set('Content-Language', language);
    return res.status(status).render(template, buildNoticePage({ language, titleKey, bodyKey }));
  }

  const notFound = (req, res) =>
    sendNotice(req, res, { status: HTTP_NOT_FOUND, template: 'public/not-found', titleKey: 'notFoundTitle', bodyKey: 'notFoundBody' });

  const sendPage = (res, template, page, status = HTTP_OK, extra = {}) => {
    res.set('Content-Language', page.language);
    return res.status(status).render(template, { ...page.view, ...extra });
  };

  async function checkoutFailure(req, res, error) {
    const key = error instanceof AppError ? ERROR_STRING_KEYS[error.code] : null;
    if (!key && !(error instanceof ZodError)) throw error;
    const values = echoValues(req.body, CHECKOUT_FIELDS, MAX_ECHO_LENGTH);
    const page = await orders.getCheckoutPageWithErrors(req.params.slug, req.params.productId, preferences(req), values, {});
    if (!page) return notFound(req, res);
    const strings = stringsFor(page.language);
    const errors = key ? {} : fieldErrors(error, messagesFor(strings, CHECKOUT_FIELD_STRINGS));
    const checkout = { ...page.view.checkout, errors, formError: key ? strings[key] : null };
    return sendPage(res, 'public/checkout', { ...page, view: { ...page.view, checkout } }, key ? HTTP_CONFLICT : HTTP_BAD_REQUEST);
  }

  async function statusFailure(req, res, error) {
    const key = error instanceof AppError ? ERROR_STRING_KEYS[error.code] : null;
    const isUtrForm = error instanceof ZodError && !error.issues.some((issue) => issue.code === 'unrecognized_keys');
    if (!key && !isUtrForm) throw error;
    const page = await orders.getStatusPage(req.params.token, preferences(req));
    if (!page) return notFound(req, res);
    const formError = stringsFor(page.language)[key ?? 'errUtr'];
    return sendPage(res, 'public/order', page, key ? HTTP_CONFLICT : HTTP_BAD_REQUEST, { formError });
  }

  const redirectToStatus = (req, res) => res.redirect(SEE_OTHER, `/o/${req.params.token}`);

  return {
    async showCheckout(req, res) {
      const page = await orders.getCheckoutPage(req.params.slug, req.params.productId, preferences(req));
      return page ? sendPage(res, 'public/checkout', page) : notFound(req, res);
    },

    async postCheckout(req, res) {
      let placed;
      try {
        placed = await orders.placeOrder(req.params.slug, req.params.productId, preferences(req), req.body);
      } catch (error) {
        if (error instanceof AppError && error.httpStatus === HTTP_NOT_FOUND) return notFound(req, res);
        return checkoutFailure(req, res, error);
      }
      return res.redirect(SEE_OTHER, `/o/${placed.token}`);
    },

    async showStatus(req, res) {
      const page = await orders.getStatusPage(req.params.token, preferences(req));
      return page ? sendPage(res, 'public/order', page) : notFound(req, res);
    },

    async postUtr(req, res) {
      try {
        await orders.submitUtr(req.params.token, req.body);
      } catch (error) {
        if (error instanceof AppError && error.httpStatus === HTTP_NOT_FOUND) return notFound(req, res);
        return statusFailure(req, res, error);
      }
      return redirectToStatus(req, res);
    },

    async postCancel(req, res) {
      try {
        await orders.cancelByCustomer(req.params.token);
      } catch (error) {
        if (error instanceof AppError && error.httpStatus === HTTP_NOT_FOUND) return notFound(req, res);
        return statusFailure(req, res, error);
      }
      return redirectToStatus(req, res);
    },

    /** Error handler for the order router: a friendly page, never a stack trace, provider text, token or form content. */
    handleError(logger) {
      return (error, req, res, next) => {
        if (res.headersSent) return next(error);
        const known = error instanceof AppError;
        const status = known ? error.httpStatus : error instanceof ZodError ? HTTP_BAD_REQUEST : HTTP_INTERNAL_ERROR;
        if (status === HTTP_NOT_FOUND) return notFound(req, res);
        const log = req.log ?? logger;
        log[status >= HTTP_INTERNAL_ERROR ? 'error' : 'warn']('order request failed', {
          correlationId: req.correlationId,
          code: known ? error.code : error instanceof ZodError ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR',
          status,
          err: known || error instanceof ZodError ? undefined : error,
        });
        return sendNotice(req, res, { status, template: 'public/error', titleKey: 'errorTitle', bodyKey: 'errorBody' });
      };
    },
  };
}

/**
 * Path of the checkout page for a product, with the language query.
 * @param {string} slug @param {string} productId @param {string} language
 * @returns {string}
 */
export const checkoutPath = (slug, productId, language) => `${productPath(slug, productId)}/buy?lang=${language}`;
