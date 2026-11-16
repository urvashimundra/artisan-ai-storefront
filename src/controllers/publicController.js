import { LANGUAGE_COOKIE_MAX_AGE_SECONDS, LANGUAGE_COOKIE_NAME } from '../domain/language.js';
import { buildRobotsTxt } from '../domain/seo.js';
import { parseCookies, serializeCookie } from '../lib/cookies.js';
import { AppError } from '../lib/errors.js';
import { buildNoticePage, isProductId, normalizeSlug } from '../services/publicShopService.js';
import { checkoutPath } from './orderController.js';

const HTTP_MOVED_PERMANENTLY = 301;
const HTTP_FOUND = 302;
const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL_ERROR = 500;
const IMAGE_CACHE_CONTROL = 'private, max-age=60';
const ROBOTS_CACHE_CONTROL = 'public, max-age=3600';
const SITEMAP_CACHE_CONTROL = 'public, max-age=600';
const SHOP_PATH_PREFIX = /^\/s\/[^/?#]+/i;

/**
 * HTTP layer for the public storefront. Reads only the `lang` cookie (never the session cookie), validates URL
 * parameters before anything reaches a service, and renders pure view models. Unknown shops, drafts, other shops'
 * products, invalid ids and reserved slugs all produce the same generic 404.
 * @param {{ publicShop: ReturnType<import('../services/publicShopService.js').createPublicShopService>,
 *   orders?: { canBuy: (slug: string, productId: string, prefs: object) => Promise<boolean> }, cookieSecure: boolean, baseUrl: string }} deps
 */
export function createPublicController({ publicShop, orders, cookieSecure, baseUrl }) {
  const preferences = (req) => ({
    query: req.query?.lang,
    cookie: parseCookies(req.get('cookie'))[LANGUAGE_COOKIE_NAME],
    acceptLanguage: req.get('accept-language'),
  });

  function sendNotice(req, res, { status, template, titleKey, bodyKey }) {
    const language = publicShop.noticeLanguage(preferences(req));
    res.set('Cache-Control', 'no-store').set('Content-Language', language);
    return res.status(status).render(template, buildNoticePage({ language, titleKey, bodyKey }));
  }

  const notFound = (req, res) =>
    sendNotice(req, res, { status: HTTP_NOT_FOUND, template: 'public/not-found', titleKey: 'notFoundTitle', bodyKey: 'notFoundBody' });

  /** Lowercase redirect target, keeping the rest of the path and the query string. */
  const lowercaseLocation = (req, slug) => req.originalUrl.replace(SHOP_PATH_PREFIX, `/s/${slug}`);

  function sendPage(req, res, template, { language, fromQuery, view }) {
    if (fromQuery) res.append('Set-Cookie', serializeCookie({ name: LANGUAGE_COOKIE_NAME, secure: cookieSecure }, language, LANGUAGE_COOKIE_MAX_AGE_SECONDS));
    res.vary('Accept-Language').vary('Cookie');
    res.set('Cache-Control', 'no-cache').set('Content-Language', language);
    req.log?.info('public page', { template, slug: req.params.slug, language });
    return res.render(template, view);
  }

  /** Validates the slug; answers 404 or a 301 itself and returns null when the request is finished. */
  function acceptSlug(req, res) {
    const parsed = normalizeSlug(req.params.slug);
    if (!parsed) return notFound(req, res), null;
    if (parsed.needsRedirect) return res.redirect(HTTP_MOVED_PERMANENTLY, lowercaseLocation(req, parsed.slug)), null;
    return parsed.slug;
  }

  return {
    async shop(req, res) {
      const slug = acceptSlug(req, res);
      if (!slug) return undefined;
      const page = await publicShop.getShopPage(slug, preferences(req));
      return page ? sendPage(req, res, 'public/shop', page) : notFound(req, res);
    },

    async product(req, res) {
      const slug = acceptSlug(req, res);
      if (!slug) return undefined;
      if (!isProductId(req.params.productId)) return notFound(req, res);
      const page = await publicShop.getProductPage(slug, req.params.productId, preferences(req));
      if (!page) return notFound(req, res);
      const canBuy = orders ? await orders.canBuy(slug, req.params.productId, preferences(req)) : false;
      if (canBuy) page.view.buyHref = checkoutPath(slug, req.params.productId, page.language);
      return sendPage(req, res, 'public/product', page);
    },

    async image(req, res) {
      const slug = acceptSlug(req, res);
      if (!slug) return undefined;
      if (!isProductId(req.params.productId)) return notFound(req, res);
      const url = await publicShop.getProductImageUrl(slug, req.params.productId);
      if (!url) return notFound(req, res);
      res.set('Cache-Control', IMAGE_CACHE_CONTROL);
      return res.redirect(HTTP_FOUND, url);
    },

    robots(_req, res) {
      res.type('text/plain').set('Cache-Control', ROBOTS_CACHE_CONTROL).send(buildRobotsTxt(baseUrl));
    },

    async sitemap(_req, res) {
      const xml = await publicShop.getSitemapXml();
      res.type('application/xml').set('Cache-Control', SITEMAP_CACHE_CONTROL).send(xml);
    },

    /** Error handler for the public router only: a friendly page in the visitor's language, never provider details. */
    handleError(logger) {
      return (error, req, res, next) => {
        if (res.headersSent) return next(error);
        const known = error instanceof AppError;
        const status = known ? error.httpStatus : HTTP_INTERNAL_ERROR;
        const log = req.log ?? logger;
        log[status >= HTTP_INTERNAL_ERROR ? 'error' : 'warn']('request failed', {
          correlationId: req.correlationId,
          code: known ? error.code : 'INTERNAL_ERROR',
          status,
          err: known ? undefined : error,
        });
        return sendNotice(req, res, { status, template: 'public/error', titleKey: 'errorTitle', bodyKey: 'errorBody' });
      };
    },
  };
}
