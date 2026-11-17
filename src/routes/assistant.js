import { Router } from 'express';
import { createAssistantController } from '../controllers/assistantController.js';
import { originCheck } from '../middleware/originCheck.js';
import { createRateLimiter } from '../middleware/rateLimit.js';

const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 3_600_000;
/** Per client IP, per process (in memory: reset on restart, not shared between instances). The per-phone limit is in the database. */
export const ASSISTANT_LIMITS = Object.freeze({
  page: Object.freeze({ windowMs: ONE_MINUTE_MS, limit: 60 }),
  ask: Object.freeze({ windowMs: ONE_HOUR_MS, limit: 10 }),
  answer: Object.freeze({ windowMs: ONE_HOUR_MS, limit: 20 }),
});

/**
 * `same-origin`, not `no-referrer`: the private page holds a form, and with `no-referrer` Chrome and Firefox send `Origin: null` on that
 * page's own POST (decisions 38 and 52, seen in a real browser), which the Origin check correctly rejects. `same-origin` sends no Referer
 * to any other site, so the private link cannot leak; it only lets the page's own server see the Referer, and the logger redacts `/q/<token>`.
 */
export const PRIVATE_PAGE_REFERRER_POLICY = 'same-origin';

/**
 * Privacy headers for every private enquiry response: nothing may cache or index the link, and no Referer is sent to another site.
 * @type {import('express').RequestHandler}
 */
export function privacyHeaders(_req, res, next) {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': PRIVATE_PAGE_REFERRER_POLICY });
  res.vary('Cookie').vary('Accept-Language');
  next();
}

/**
 * Customer "ask the seller" routes. No session and no owner code. Mounted BEFORE the global limiter with their own per-IP limiters
 * (asking, answering and viewing are counted separately). Every POST passes the Origin check BEFORE the limiter and the handler.
 * Every response carries the privacy headers (no-store, noindex, Referrer-Policy same-origin). The Origin check is unchanged and is not
 * weakened to suit the referrer policy.
 * @param {{ config: { allowedOrigins: string[] }, assistant: object, logger: object,
 *   rateLimits?: { page?: object, ask?: object, answer?: object } }} deps
 * @returns {import('express').Router}
 */
export function createAssistantRouter({ config, assistant, logger, rateLimits = {} }) {
  const router = Router();
  const controller = createAssistantController({ assistant });
  const sameOrigin = originCheck(config.allowedOrigins);
  const limit = (name) => createRateLimiter(rateLimits[name] ?? ASSISTANT_LIMITS[name]);
  const [page, ask, answer] = ['page', 'ask', 'answer'].map(limit);

  router.post('/s/:slug/ask', privacyHeaders, sameOrigin, ask, controller.postAsk);
  router.get('/s/:slug/q/:token', privacyHeaders, page, controller.showEnquiry);
  router.post('/s/:slug/q/:token/answer', privacyHeaders, sameOrigin, answer, controller.postAnswer);
  router.use(controller.handleError(logger));
  return router;
}
