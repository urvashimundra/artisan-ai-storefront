const LETTER_OR_MARK = /[\p{L}\p{M}]/u;
const GUJARATI = /[઀-૿]/u;
const DEVANAGARI = /[ऀ-ॿ]/u;
const LATIN = /[A-Za-z]/u;

/** Share of a language's letters that must be in its own script, across title, description and alt text. */
export const MIN_SCRIPT_RATIO = 0.5;

const SCRIPT_PATTERNS = Object.freeze({ en: LATIN, gu: GUJARATI, hi: DEVANAGARI });
const FIELDS = Object.freeze(['title', 'description', 'alt_text']);

function countMatching(text, pattern) {
  let count = 0;
  for (const character of text) if (pattern.test(character)) count += 1;
  return count;
}

function languageUsesScript(translation, pattern) {
  const texts = FIELDS.map((name) => translation[name]);
  if (!texts.every((text) => countMatching(text, pattern) > 0)) return false;
  const letters = texts.reduce((sum, text) => sum + countMatching(text, LETTER_OR_MARK), 0);
  const inScript = texts.reduce((sum, text) => sum + countMatching(text, pattern), 0);
  return letters > 0 && inScript / letters >= MIN_SCRIPT_RATIO;
}

/**
 * Checks that each translation is written in its own script: Gujarati U+0A80-U+0AFF, Devanagari U+0900-U+097F,
 * Latin letters for English. Every field needs at least one character of the script and the language as a whole
 * needs at least half of its letters in it (so a brand name in Latin letters is fine). A failure means the
 * result must be flagged for owner review, never silently accepted.
 * @param {Record<'en'|'gu'|'hi', {title: string, description: string, alt_text: string}>} translations
 * @returns {{ en: boolean, gu: boolean, hi: boolean, needsReview: boolean }}
 */
export function checkListingScripts(translations) {
  const flags = {};
  for (const [language, pattern] of Object.entries(SCRIPT_PATTERNS)) {
    flags[language] = languageUsesScript(translations[language], pattern);
  }
  return { ...flags, needsReview: !(flags.en && flags.gu && flags.hi) };
}

/** Share of a reply's letters that must be in the page language's script (names and product titles may stay in Latin letters). */
export const MIN_REPLY_SCRIPT_RATIO = 0.3;

/**
 * Checks that a free-text reply is written in the page language's script: Gujarati, Devanagari or Latin letters.
 * @param {string} text
 * @param {'en'|'gu'|'hi'} language
 * @returns {boolean} False when the text has no letters in that script, or too small a share of its letters.
 */
export function textUsesScript(text, language) {
  const pattern = SCRIPT_PATTERNS[language];
  if (!pattern) return true;
  const letters = countMatching(text, LETTER_OR_MARK);
  const inScript = countMatching(text, pattern);
  return inScript > 0 && inScript / letters >= MIN_REPLY_SCRIPT_RATIO;
}

const ENGLISH_LABEL_WORDS = /(?<![A-Za-z])(?:unit price|sub-?total|total|discount|in stock|sold out)(?![A-Za-z])/i;

const escapeForRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The text with every product title or name the tools returned removed: a label word inside the shop's own title ("Total Glow Candle") is not a model-typed label. */
const withoutNames = (text, names) => names.filter((name) => name.trim() !== '').reduce((rest, name) => rest.replace(new RegExp(escapeForRegExp(name.trim()), 'giu'), ' '), text);

/**
 * True when a Gujarati or Hindi reply carries one of the English labels the server supplies in the customer's language (unit price, subtotal,
 * discount, total, in stock, sold out): the model must use the label placeholders instead. Occurrences inside a product title or name the
 * tools returned (`names`) are the shop's own wording and are not flagged.
 * @param {string} text Reply text with the money and label placeholders already removed. @param {'en'|'gu'|'hi'} language
 * @param {string[]} [names] Product titles and names the model was shown. @returns {boolean}
 */
export const hasEnglishLabelWords = (text, language, names = []) => language !== 'en' && ENGLISH_LABEL_WORDS.test(withoutNames(text, names));

/**
 * The Indic script a customer's message is mostly written in, so a customer who writes Gujarati or Hindi is answered in it whatever language
 * the page happened to be in. Latin text says nothing (English, or Hindi typed in Latin letters), so it returns null and the page language stays.
 * @param {string} text
 * @returns {'gu' | 'hi' | null}
 */
export function detectIndicLanguage(text) {
  const letters = countMatching(text, LETTER_OR_MARK);
  const gujarati = countMatching(text, GUJARATI);
  const devanagari = countMatching(text, DEVANAGARI);
  if (letters === 0 || Math.max(gujarati, devanagari) / letters < MIN_REPLY_SCRIPT_RATIO) return null;
  return gujarati >= devanagari ? 'gu' : 'hi';
}

const REQUEST_PATTERNS = Object.freeze({
  en: /(?<![A-Za-z])in english(?![A-Za-z])|અંગ્રેજીમાં|अंग्रेज़ी में|अंग्रेजी में|अँग्रेजी में/giu,
  gu: /(?<![A-Za-z])in gujarati(?![A-Za-z])|ગુજરાતીમાં|गुजराती में/giu,
  hi: /(?<![A-Za-z])in hindi(?![A-Za-z])|હિન્દીમાં|हिंदी में|हिन्दी में/giu,
});

/** The language the customer explicitly asked for ("in Gujarati", "ગુજરાતીમાં", "हिंदी में"); the last request in the message wins. */
function requestedLanguage(text) {
  let found = null;
  let foundAt = -1;
  for (const [language, pattern] of Object.entries(REQUEST_PATTERNS)) {
    for (const match of text.matchAll(pattern)) if (match.index > foundAt) [found, foundAt] = [language, match.index];
  }
  return found;
}

/**
 * The language the reply must be written in, decided by the server and never by the model: an explicit request in the customer's latest
 * message first, else the script that message is mostly written in, else the page language.
 * @param {string} latestMessage @param {'en'|'gu'|'hi'} pageLanguage @returns {'en'|'gu'|'hi'}
 */
export const requiredReplyLanguage = (latestMessage, pageLanguage) => requestedLanguage(latestMessage) ?? detectIndicLanguage(latestMessage) ?? pageLanguage;
