import { RESERVED_SLUGS, SLUG_PATTERN } from '../domain/dbConstraints.js';
import { isOwnedImagePath } from '../domain/imageUpload.js';
import { LANGUAGE_NAMES, pickField, resolveLanguage } from '../domain/language.js';
import { themeClass } from '../domain/palette.js';
import { fillTemplate, stringsFor } from '../domain/publicStrings.js';
import {
  MAX_MAKER_EXCERPT_LENGTH,
  absoluteUrl,
  buildMeta,
  buildSitemapXml,
  productImagePath,
  productPath,
  shopPath,
  truncateText,
  withLang,
} from '../domain/seo.js';
import { LANGUAGES, MAX_PUBLIC_PRODUCTS } from '../domain/storeRules.js';
import { instagramUrl } from '../domain/shopSettings.js';
import { buildWhatsappLink } from '../domain/whatsapp.js';
import { formatInr } from '../lib/money.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CASE_INSENSITIVE_SLUG = new RegExp(SLUG_PATTERN.source, 'i');
const EAGER_IMAGE_COUNT = 2;
export const SITEMAP_MAX_URLS = 5000;
export const SITEMAP_TTL_MS = 600_000;

/** Plain module variable (no ttlCache): the memoised sitemap XML and when it expires. */
let sitemapCache = null;

/** Clears the memoised sitemap. For tests. */
export function resetSitemapCache() {
  sitemapCache = null;
}

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

/**
 * Per-field choice of the shop tagline and story. A language other than the shop default is used only when its
 * translation is approved and the field is non-empty; otherwise the shop default is used, and the returned `lang` says
 * which. The default language always comes from the stores row, never from a translation row. The shop NAME is never
 * translated and is not handled here.
 * @param {{ defaultLanguage: string, tagline: string, story: string, translations?: object }} shop
 * @param {string} language
 * @returns {{ tagline: { text: string, lang: string } | null, story: { text: string, lang: string } | null }}
 */
export function pickShopTexts(shop, language) {
  const texts = { ...shop.translations, [shop.defaultLanguage]: { tagline: shop.tagline, story: shop.story, approved: true } };
  return {
    tagline: pickField(texts, 'tagline', language, shop.defaultLanguage),
    story: pickField(texts, 'story', language, shop.defaultLanguage),
  };
}

/** Shared view fields: language, strings, theme and contact links. The WhatsApp number never leaves this function. */
function baseView({ shop, texts, language, baseUrl, pagePath, pathFor, templateKey, values }) {
  const strings = stringsFor(language);
  const pageUrl = absoluteUrl(baseUrl, pagePath);
  const message = fillTemplate(strings[templateKey], { shop: shop.name, url: pageUrl, ...values });
  const whatsappUrl = shop.whatsappEnabled && shop.whatsappNumber ? buildWhatsappLink(shop.whatsappNumber, message) : null;
  return {
    language,
    strings,
    themeClass: themeClass(shop.accentKey),
    shop: { name: shop.name, lang: shop.defaultLanguage, tagline: texts.tagline, story: texts.story },
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
  const texts = pickShopTexts(shop, language);
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
    texts,
    language,
    baseUrl,
    pagePath,
    pathFor: () => shopPath(shop.slug),
    templateKey: 'whatsappShopMessage',
    values: {},
  });
  const summary = [texts.tagline?.text, texts.story?.text].filter(Boolean).join(' | ');
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
  const shown = cards.slice(0, MAX_PUBLIC_PRODUCTS);
  return { view: { ...base, kind: 'shop', products: shown, hasMore: cards.length > MAX_PUBLIC_PRODUCTS, meta }, skippedIds };
}

/**
 * Pure view-model builder for a product page. Returns null when the product has no displayable approved title.
 * @param {{ shop: object, product: object, language: string, baseUrl: string }} input
 * @returns {object | null}
 */
export function buildProductPage({ shop, product, language, baseUrl }) {
  const card = buildCard(product, { shop, language, index: 0 });
  if (!card) return null;
  const texts = pickShopTexts(shop, language);
  const description = pickField(product.translations, 'description', language, shop.defaultLanguage);
  const pagePath = withLang(productPath(shop.slug, product.id), language, shop.defaultLanguage);
  const base = baseView({
    shop,
    texts,
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
    maker: {
      excerpt: truncateText(texts.story?.text ?? '', MAX_MAKER_EXCERPT_LENGTH),
      lang: texts.story?.lang ?? shop.defaultLanguage,
    },
    meta,
  };
}

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function isoOrNull(value) {
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/**
 * Pure: turns repository rows into sitemap entries. Shops sorted by slug, each followed by its products sorted by id;
 * at most maxUrls entries in total. Only public fields are read.
 * @param {{ productId: string, productUpdatedAt: string, slug: string, shopUpdatedAt: string }[]} rows
 * @param {string} baseUrl
 * @param {number} maxUrls
 * @returns {{ loc: string, lastmod: string | null }[]}
 */
export function buildSitemapEntries(rows, baseUrl, maxUrls) {
  const shops = new Map();
  for (const row of rows) {
    const shop = shops.get(row.slug) ?? { updatedAt: row.shopUpdatedAt, products: [] };
    shop.products.push(row);
    shops.set(row.slug, shop);
  }
  const entries = [];
  for (const slug of [...shops.keys()].sort(byText)) {
    const shop = shops.get(slug);
    entries.push({ loc: absoluteUrl(baseUrl, shopPath(slug)), lastmod: isoOrNull(shop.updatedAt) });
    for (const row of shop.products.sort((a, b) => byText(a.productId, b.productId))) {
      entries.push({ loc: absoluteUrl(baseUrl, productPath(slug, row.productId)), lastmod: isoOrNull(row.productUpdatedAt) });
    }
  }
  return entries.slice(0, maxUrls);
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
 *   logger: { warn: Function }, baseUrl: string, now?: () => number }} deps
 */
export function createPublicShopService({ shops, images, logger, baseUrl, now = Date.now }) {
  const pick = (prefs, shopDefault) => resolveLanguage({ ...prefs, shopDefault });

  /** The shop plus its approved translated text; the default language needs no translation rows, so none are read. */
  const withTranslations = async (shop, language) => ({
    ...shop,
    translations: language === shop.defaultLanguage ? {} : await shops.listStoreTranslations(shop.id),
  });

  return {
    /** Language for pages that have no shop (not found, errors): cookie, then Accept-Language, then English. */
    noticeLanguage: (prefs) => pick({ cookie: prefs.cookie, acceptLanguage: prefs.acceptLanguage }, 'en').language,

    /** sitemap.xml: shops with a published product plus those products. Memoised for 10 minutes. @returns {Promise<string>} */
    async getSitemapXml() {
      const time = now();
      if (sitemapCache && sitemapCache.baseUrl === baseUrl && sitemapCache.expiresAt > time) return sitemapCache.xml;
      const rows = await shops.listSitemapEntries(SITEMAP_MAX_URLS);
      const xml = buildSitemapXml(buildSitemapEntries(rows, baseUrl, SITEMAP_MAX_URLS));
      sitemapCache = { xml, baseUrl, expiresAt: time + SITEMAP_TTL_MS };
      return xml;
    },

    /** @returns {Promise<{ language: string, fromQuery: boolean, view: object } | null>} null when the shop is unknown. */
    async getShopPage(slug, prefs) {
      const shop = await shops.findShopBySlug(slug);
      if (!shop) return null;
      const { language, fromQuery } = pick(prefs, shop.defaultLanguage);
      const products = await shops.listPublished(shop.id);
      const { view, skippedIds } = buildShopPage({ shop: await withTranslations(shop, language), products, language, baseUrl });
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
      const view = buildProductPage({ shop: await withTranslations(shop, language), product, language, baseUrl });
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
