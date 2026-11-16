import { LANGUAGES } from './storeRules.js';

export const LANGUAGE_COOKIE_NAME = 'lang';
export const LANGUAGE_COOKIE_MAX_AGE_SECONDS = 31_536_000;
const MAX_ACCEPT_LANGUAGE_LENGTH = 300;
const MAX_ACCEPT_LANGUAGE_ENTRIES = 20;
const DEFAULT_QUALITY = 1;
const ENTRY_PATTERN = /^([A-Za-z]{1,8})(?:-[A-Za-z0-9]{1,8})*$/;
const QUALITY_PATTERN = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

/** Language names written in their own script, for the switcher. */
export const LANGUAGE_NAMES = Object.freeze({ en: 'English', gu: 'ગુજરાતી', hi: 'हिन्दी' });

/** Language names in English, for owner pages and AI prompts. */
export const LANGUAGE_NAMES_ENGLISH = Object.freeze({ en: 'English', gu: 'Gujarati', hi: 'Hindi' });

/**
 * @param {unknown} value
 * @returns {boolean} True only for the exact strings en, gu, hi.
 */
export const isSupportedLanguage = (value) => typeof value === 'string' && LANGUAGES.includes(value);

function parseEntry(part) {
  const [range, ...params] = part.trim().split(';');
  const match = ENTRY_PATTERN.exec(range.trim());
  if (!match) return null;
  let quality = DEFAULT_QUALITY;
  for (const param of params) {
    const [name, value] = param.split('=').map((piece) => piece.trim());
    if (name.toLowerCase() !== 'q') continue;
    if (!QUALITY_PATTERN.test(value ?? '')) return null;
    quality = Number(value);
  }
  return { language: match[1].toLowerCase(), quality };
}

/**
 * Parses an Accept-Language header into supported languages, best first. Unknown languages, q=0 and malformed
 * entries are dropped; equal q-values keep header order.
 * @param {unknown} header
 * @returns {string[]}
 */
export function parseAcceptLanguage(header) {
  if (typeof header !== 'string' || header.length > MAX_ACCEPT_LANGUAGE_LENGTH) return [];
  const entries = header
    .split(',')
    .slice(0, MAX_ACCEPT_LANGUAGE_ENTRIES)
    .map(parseEntry)
    .filter((entry) => entry && entry.quality > 0 && isSupportedLanguage(entry.language))
    .map((entry, index) => ({ ...entry, index }));
  entries.sort((a, b) => b.quality - a.quality || a.index - b.index);
  return [...new Set(entries.map((entry) => entry.language))];
}

/**
 * Picks the page language: ?lang, then the lang cookie, then Accept-Language, then the shop default.
 * Invalid values at any step are ignored.
 * @param {{ query?: unknown, cookie?: unknown, acceptLanguage?: unknown, shopDefault: string }} input
 * @returns {{ language: string, fromQuery: boolean }} fromQuery is true when a valid ?lang was used (set the cookie).
 */
export function resolveLanguage({ query, cookie, acceptLanguage, shopDefault }) {
  if (isSupportedLanguage(query)) return { language: query, fromQuery: true };
  if (isSupportedLanguage(cookie)) return { language: cookie, fromQuery: false };
  const [fromHeader] = parseAcceptLanguage(acceptLanguage);
  return { language: fromHeader ?? shopDefault, fromQuery: false };
}

const hasText = (value) => typeof value === 'string' && value.trim().length > 0;

/**
 * Chooses one translated field. The visitor's language is used only when that translation is approved and the field
 * is non-empty; otherwise the shop default is used. Returns the language actually used so the template can mark
 * fallback text with its own lang attribute.
 * @param {Record<string, { approved?: boolean } & Record<string, unknown>>} translations Keyed by language.
 * @param {string} field
 * @param {string} language
 * @param {string} defaultLanguage
 * @returns {{ text: string, lang: string } | null} null when neither language has approved text.
 */
export function pickField(translations, field, language, defaultLanguage) {
  for (const lang of [language, defaultLanguage]) {
    const entry = translations?.[lang];
    if (entry?.approved === true && hasText(entry[field])) return { text: entry[field], lang };
  }
  return null;
}
