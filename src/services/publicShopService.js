import { RESERVED_SLUGS, SLUG_PATTERN } from '../domain/dbConstraints.js';
import { isOwnedImagePath } from '../domain/imageUpload.js';
import { LANGUAGE_NAMES, pickField, resolveLanguage } from '../domain/language.js';
import { themeClass } from '../domain/palette.js';
import { fillTemplate, stringsFor } from '../domain/publicStrings.js';
import {
  MAX_MAKER_EXCERPT_LENGTH,
  absoluteUrl,
  buildMeta,
  productImagePath,
  productPath,
  shopPath,
  truncateText,
  withLang,
} from '../domain/seo.js';
import { LANGUAGES } from '../domain/storeRules.js';
import { instagramUrl } from '../domain/shopSettings.js';
import { buildWhatsappLink } from '../domain/whatsapp.js';
import { formatInr } from '../lib/money.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CASE_INSENSITIVE_SLUG = new RegExp(SLUG_PATTERN.source, 'i');
const EAGER_IMAGE_COUNT = 2;

/**
 * Validates a slug taken from the URL, case-insensitively, against the stored format and the reserved list.
 * @param {unknown} raw
 * @returns {{ slug: string, needsRedirect: boolean } | null} null for anything that must never reach the repository.
 */
export function normalizeSlug(raw) {
  if (typeof raw !== 'string' || !CASE_INSENSITIVE_SLUG.test(raw)) return null;
  const slug = raw.toLowerCase();
  if (!SLUG_PATTERN.test(slug) || RESERVED_SLUGS.includes(slug)) return null;
  return { slug, needsRedirect: slug !== raw };
}

/** @param {unknown} value @returns {boolean} */
export const isProductId = (value) => typeof value === 'string' && UUID.test(value);

/** Explicit ?lang= links, so a visitor can always switch back to the shop default despite the cookie. */
function languageLinks(pathFor, current) {
  return LANGUAGES.map((lang) => ({
    lang,
    name: LANGUAGE_NAMES[lang],
    href: `${pathFor()}?lang=${lang}`,
    current: lang === current,
  }));
}

const priceText = (pricePaise) => (pricePaise === null ? null : formatInr(pricePaise, { omitZeroFraction: true }));

/** Shared view fields: language, strings, theme and contact links. The WhatsApp number never leaves this function. */
function baseView({ shop, language, baseUrl, pagePath, pathFor, templateKey, values }) {
  const strings = stringsFor(language);
  const pageUrl = absoluteUrl(baseUrl, pagePath);
  const message = fillTemplate(strings[templateKey], { shop: shop.name, url: pageUrl, ...values });
  const whatsappUrl = shop.whatsappEnabled && shop.whatsappNumber ? buildWhatsappLink(shop.whatsappNumber, message) : null;
  return {
    language,
    strings,
    themeClass: themeClass(shop.accentKey),
    shop: { name: shop.name, tagline: shop.tagline, story: shop.story, lang: shop.defaultLanguage },
    shopHref: withLang(shopPath(shop.slug), language, shop.defaultLanguage),
    instagramUrl: shop.instagramHandle ? instagramUrl(shop.instagramHandle) : null,
    whatsappUrl,
    languageLinks: languageLinks(pathFor, language),
    pageUrl,
  };
}

function buildCard(product, { shop, language, index }) {
  const translations = product.translations;
  const title = pickField(translations, 'title', language, shop.defaultLanguage);
  if (!title) return null;
  const alt = pickField(translations, 'altText', language, shop.defaultLanguage) ?? title;
  return {
    id: product.id,
    href: withLang(productPath(shop.slug, product.id), language, shop.defaultLanguage),
    imageSrc: productImagePath(shop.slug, product.id),
    title,
    alt,
    price: priceText(product.pricePaise),
    soldOut: product.stock === 0,
    eager: index < EAGER_IMAGE_COUNT,
  };
}

/**
 * Pure view-model builder for the shop page. Products without a displayable approved translation are left out and
 * reported in `skippedIds` so the caller can log them.
 * @param {{ shop: object, products: object[], language: string, baseUrl: string }} input
 * @returns {{ view: object, skippedIds: string[] }}
 */
export function buildShopPage({ shop, products, language, baseUrl }) {
  const cards = [];
  const skippedIds = [];
  for (const product of products) {
    const card = buildCard(product, { shop, language, index: cards.length });
    if (card) cards.push(card);
    else skippedIds.push(product.id);
  }
  const pagePath = withLang(shopPath(shop.slug), language, shop.defaultLanguage);
  const base = baseView({
    shop,
    language,
    baseUrl,
    pagePath,
    pathFor: () => shopPath(shop.slug),
    templateKey: 'whatsappShopMessage',
    values: {},
  });
  const summary = [shop.tagline, shop.story].filter(Boolean).join(' | ');
  const meta = buildMeta({
    title: shop.name,
    description: summary,
    path: pagePath,
    imagePath: cards[0]?.imageSrc ?? null,
    language,
    baseUrl,
    type: 'website',
    indexable: cards.length > 0,
    siteName: shop.name,
  });
  return { view: { ...base, kind: 'shop', products: cards, meta }, skippedIds };
}

/**
 * Pure view-model builder for a product page. Returns null when the product has no displayable approved title.
 * @param {{ shop: object, product: object, language: string, baseUrl: string }} input
 * @returns {object | null}
 */
export function buildProductPage({ shop, product, language, baseUrl }) {
  const card = buildCard(product, { shop, language, index: 0 });
  if (!card) return null;
  const description = pickField(product.translations, 'description', language, shop.defaultLanguage);
  const pagePath = withLang(productPath(shop.slug, product.id), language, shop.defaultLanguage);
  const base = baseView({
    shop,
    language,
    baseUrl,
    pagePath,
    pathFor: () => productPath(shop.slug, product.id),
    templateKey: 'whatsappProductMessage',
    values: { product: card.title.text },
  });
  const meta = buildMeta({
    title: `${card.title.text} | ${shop.name}`,
    description: description?.text ?? card.title.text,
    path: pagePath,
    imagePath: card.imageSrc,
    language,
    baseUrl,
    type: 'product',
    indexable: true,
    siteName: shop.name,
  });
  return {
    ...base,
    kind: 'product',
    product: { ...card, description },
    maker: { excerpt: truncateText(shop.story, MAX_MAKER_EXCERPT_LENGTH), lang: shop.defaultLanguage },
    meta,
  };
}

/**
 * Generic page (not found, error, coming soon) in the visitor's language.
 * @param {{ language: string, titleKey: string, bodyKey: string }} input
 * @returns {object}
 */
export function buildNoticePage({ language, titleKey, bodyKey }) {
  const strings = stringsFor(language);
  return {
    kind: 'notice',
    language,
    strings,
    themeClass: themeClass(null),
    notice: { title: strings[titleKey], body: strings[bodyKey] },
    meta: { title: strings[titleKey], robots: 'noindex' },
  };
}

/**
 * Public read path: resolves a slug to a shop, then reads only that shop's published products. Pure view-model builders
 * above; this factory only orchestrates repository calls. Never imports owner services or session code.
 * @param {{ shops: ReturnType<import('../repositories/publicShopRepository.js').createPublicShopRepository>,
 *   images: { createSignedUrl: (storeId: string, productId: string, path: string) => Promise<string> },
 *   logger: { warn: Function }, baseUrl: string }} deps
 */
export function createPublicShopService({ shops, images, logger, baseUrl }) {
  const pick = (prefs, shopDefault) => resolveLanguage({ ...prefs, shopDefault });

  return {
    /** Language for pages that have no shop (not found, errors): cookie, then Accept-Language, then English. */
    noticeLanguage: (prefs) => pick({ cookie: prefs.cookie, acceptLanguage: prefs.acceptLanguage }, 'en').language,

    /** @returns {Promise<{ language: string, fromQuery: boolean, view: object } | null>} null when the shop is unknown. */
    async getShopPage(slug, prefs) {
      const shop = await shops.findShopBySlug(slug);
      if (!shop) return null;
      const { language, fromQuery } = pick(prefs, shop.defaultLanguage);
      const products = await shops.listPublished(shop.id);
      const { view, skippedIds } = buildShopPage({ shop, products, language, baseUrl });
      for (const productId of skippedIds) {
        logger.warn('published product has no approved translation', { storeId: shop.id, productId });
      }
      return { language, fromQuery, view };
    },

    /** @returns {Promise<{ language: string, fromQuery: boolean, view: object } | null>} null unless published in this shop. */
    async getProductPage(slug, productId, prefs) {
      const shop = await shops.findShopBySlug(slug);
      if (!shop) return null;
      const product = await shops.findPublished(shop.id, productId);
      if (!product) return null;
      const { language, fromQuery } = pick(prefs, shop.defaultLanguage);
      const view = buildProductPage({ shop, product, language, baseUrl });
      if (!view) {
        logger.warn('published product has no approved translation', { storeId: shop.id, productId });
        return null;
      }
      return { language, fromQuery, view };
    },

    /**
     * Fresh signed URL for a PUBLISHED product photo of this shop, or null (unknown shop, draft, other shop's product,
     * missing or foreign image path). Storage failures propagate as STORAGE_ERROR.
     * @returns {Promise<string | null>}
     */
    async getProductImageUrl(slug, productId) {
      const shop = await shops.findShopBySlug(slug);
      if (!shop) return null;
      const image = await shops.findPublishedImage(shop.id, productId);
      if (!image) return null;
      if (!isOwnedImagePath(image.imagePath, shop.id, productId)) {
        logger.warn('published product has an unusable image path', { storeId: shop.id, productId });
        return null;
      }
      return images.createSignedUrl(shop.id, productId, image.imagePath);
    },
  };
}
