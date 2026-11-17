import { Router } from 'express';
import { createAssistantController } from '../controllers/assistantController.js';
import { privacyHeaders } from '../controllers/orderController.js';
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
 * Customer "ask the seller" routes. No session and no owner code. Mounted BEFORE the global limiter with their own per-IP limiters
 * (asking, answering and viewing are counted separately). Every POST passes the Origin check BEFORE the limiter and the handler.
 * Every response carries the privacy headers (no-store, noindex, Referrer-Policy same-origin: `no-referrer` would make browsers send
 * `Origin: null` on the page's own form post, which the Origin check rightly rejects).
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
