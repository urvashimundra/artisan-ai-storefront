import { isSupportedLanguage } from './language.js';

export const MAX_META_DESCRIPTION_LENGTH = 160;
export const MAX_MAKER_EXCERPT_LENGTH = 300;
const ELLIPSIS = '…';
const OG_LOCALES = Object.freeze({ en: 'en_IN', gu: 'gu_IN', hi: 'hi_IN' });

/** @param {string} language @returns {string} Open Graph locale, e.g. gu_IN. */
export const ogLocale = (language) => OG_LOCALES[language] ?? OG_LOCALES.en;

const codePointCount = (text) => Array.from(text).length;

/**
 * Cuts text to at most maxCodePoints code points INCLUDING the ellipsis, on a grapheme boundary so a Gujarati or Hindi
 * vowel sign is never separated from its consonant.
 * @param {string} text
 * @param {number} maxCodePoints
 * @returns {string}
 */
export function truncateText(text, maxCodePoints) {
  if (codePointCount(text) <= maxCodePoints) return text;
  const budget = maxCodePoints - codePointCount(ELLIPSIS);
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let used = 0;
  let out = '';
  for (const { segment } of segmenter.segment(text)) {
    used += codePointCount(segment);
    if (used > budget) break;
    out += segment;
  }
  return `${out.trimEnd()}${ELLIPSIS}`;
}

/**
 * Meta description: whitespace and newlines collapsed to single spaces, at most 160 code points.
 * @param {string} text
 * @returns {string}
 */
export function metaDescription(text) {
  return truncateText(String(text).replace(/\s+/g, ' ').trim(), MAX_META_DESCRIPTION_LENGTH);
}

/**
 * Appends ?lang= only when the page language differs from the shop default.
 * @param {string} path
 * @param {string} language
 * @param {string} defaultLanguage
 * @returns {string}
 */
export function withLang(path, language, defaultLanguage) {
  return isSupportedLanguage(language) && language !== defaultLanguage ? `${path}?lang=${language}` : path;
}

/** @param {string} slug @returns {string} */
export const shopPath = (slug) => `/s/${encodeURIComponent(slug)}`;
/** @param {string} slug @param {string} productId @returns {string} */
export const productPath = (slug, productId) => `${shopPath(slug)}/p/${encodeURIComponent(productId)}`;
/** @param {string} slug @param {string} productId @returns {string} Stable image route (never a signed URL). */
export const productImagePath = (slug, productId) => `${productPath(slug, productId)}/image`;

/**
 * Absolute URL for a path under BASE_URL.
 * @param {string} baseUrl
 * @param {string} path Starts with /.
 * @returns {string}
 */
export const absoluteUrl = (baseUrl, path) => new URL(path, baseUrl).toString();

/**
 * Head metadata for a public page. Everything is plain text; the template escapes it.
 * @param {{ title: string, description: string, path: string, imagePath?: string|null, language: string,
 *   baseUrl: string, type: 'website'|'product', indexable: boolean, siteName: string }} page
 * @returns {Record<string, string|null>}
 */
export function buildMeta({ title, description, path, imagePath, language, baseUrl, type, indexable, siteName }) {
  const url = absoluteUrl(baseUrl, path);
  const image = imagePath ? absoluteUrl(baseUrl, imagePath) : null;
  return {
    title,
    description: metaDescription(description),
    canonical: url,
    ogUrl: url,
    ogType: type === 'product' ? 'product' : 'website',
    ogLocale: ogLocale(language),
    ogSiteName: siteName,
    ogImage: image,
    twitterCard: image ? 'summary_large_image' : 'summary',
    robots: indexable ? null : 'noindex',
  };
}

const XML_ESCAPES = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' });

/** @param {string} text @returns {string} Text safe inside XML element content. */
export const escapeXml = (text) => String(text).replace(/[&<>"']/g, (char) => XML_ESCAPES[char]);

/** Paths crawlers must not fetch. Public shops live under /s/. */
export const ROBOTS_DISALLOWED_PATHS = Object.freeze(['/dashboard', '/products', '/store', '/login', '/signup', '/internal', '/enquiries', '/s/*/q/', '/s/*/c/', '/s/*/chat']);

/**
 * robots.txt: allow the public shops, disallow owner and internal areas, point at the absolute sitemap URL.
 * @param {string} baseUrl
 * @returns {string}
 */
export function buildRobotsTxt(baseUrl) {
  const lines = ['User-agent: *', 'Allow: /s/', ...ROBOTS_DISALLOWED_PATHS.map((path) => `Disallow: ${path}`)];
  return `${lines.join('\n')}\n\nSitemap: ${absoluteUrl(baseUrl, '/sitemap.xml')}\n`;
}

/**
 * sitemap.xml body.
 * @param {{ loc: string, lastmod: string | null }[]} entries
 * @returns {string}
 */
export function buildSitemapXml(entries) {
  const urls = entries.map(({ loc, lastmod }) => {
    const modified = lastmod ? `<lastmod>${escapeXml(lastmod)}</lastmod>` : '';
    return `<url><loc>${escapeXml(loc)}</loc>${modified}</url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}
