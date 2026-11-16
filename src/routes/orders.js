import { Router } from 'express';
import { createOrderController, privacyHeaders } from '../controllers/orderController.js';
import { originCheck } from '../middleware/originCheck.js';
import { createRateLimiter } from '../middleware/rateLimit.js';

const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 3_600_000;
/** Per client IP, per process (in memory: reset on restart, not shared between instances). */
export const ORDER_LIMITS = Object.freeze({
  page: Object.freeze({ windowMs: ONE_MINUTE_MS, limit: 60 }),
  create: Object.freeze({ windowMs: ONE_HOUR_MS, limit: 10 }),
  utr: Object.freeze({ windowMs: ONE_HOUR_MS, limit: 20 }),
  status: Object.freeze({ windowMs: ONE_MINUTE_MS, limit: 60 }),
});

/**
 * Customer order routes: checkout, the private status page, UTR submission and cancel. No session and no owner code. Mounted
 * BEFORE the global limiter with its own per-IP limiters (order creation, UTR submission and status lookup are counted
 * separately). Every POST passes the Origin check BEFORE the limiter and the handler. Every response carries the privacy
 * headers (no-store, noindex, Referrer-Policy same-origin).
 * @param {{ config: { allowedOrigins: string[] }, orders: object, logger: object,
 *   rateLimits?: { page?: object, create?: object, utr?: object, status?: object } }} deps
 * @returns {import('express').Router}
 */
export function createOrderRouter({ config, orders, logger, rateLimits = {} }) {
  const router = Router();
  const controller = createOrderController({ orders });
  const sameOrigin = originCheck(config.allowedOrigins);
  const limit = (name) => createRateLimiter(rateLimits[name] ?? ORDER_LIMITS[name]);
  const [page, create, utr, status] = ['page', 'create', 'utr', 'status'].map(limit);

  router.get('/s/:slug/p/:productId/buy', privacyHeaders, page, controller.showCheckout);
  router.post('/s/:slug/p/:productId/buy', privacyHeaders, sameOrigin, create, controller.postCheckout);
  router.get('/o/:token', privacyHeaders, status, controller.showStatus);
  router.post('/o/:token/utr', privacyHeaders, sameOrigin, utr, controller.postUtr);
  router.post('/o/:token/cancel', privacyHeaders, sameOrigin, utr, controller.postCancel);
  router.use(controller.handleError(logger));
  return router;
}
