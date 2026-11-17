import { Router } from 'express';
import { createPublicController } from '../controllers/publicController.js';
import { deriveCookieConfig } from '../lib/cookies.js';
import { createRateLimiter } from '../middleware/rateLimit.js';

const ONE_MINUTE_MS = 60_000;
/** Per client IP, per process (in memory: reset on restart, not shared between instances). */
export const PAGE_LIMITS = Object.freeze({ windowMs: ONE_MINUTE_MS, limit: 240 });
export const IMAGE_LIMITS = Object.freeze({ windowMs: ONE_MINUTE_MS, limit: 600 });

/**
 * Public storefront routes: GET only, no session, no owner code. Mounted BEFORE the global limiter and before any
 * session-loading route, with its own per-IP limiters (pages and the heavier image route are counted separately).
 * @param {{ config: { baseUrl: string }, publicShop: object, orders?: { canBuy: Function }, chat?: boolean, logger: object,
 *   rateLimits?: { pages?: object, image?: object } }} deps
 * @returns {import('express').Router}
 */
export function createPublicRouter({ config, publicShop, orders, chat = false, logger, rateLimits = {} }) {
  const router = Router();
  const controller = createPublicController({
    publicShop,
    orders,
    chat,
    cookieSecure: deriveCookieConfig(config.baseUrl).secure,
    baseUrl: config.baseUrl,
  });
  const pages = createRateLimiter(rateLimits.pages ?? PAGE_LIMITS);
  const image = createRateLimiter(rateLimits.image ?? IMAGE_LIMITS);

  router.get('/robots.txt', pages, controller.robots);
  router.get('/sitemap.xml', pages, controller.sitemap);
  router.get('/s/:slug', pages, controller.shop);
  router.get('/s/:slug/p/:productId', pages, controller.product);
  router.get('/s/:slug/p/:productId/image', image, controller.image);
  router.use(controller.handleError(logger));
  return router;
}
