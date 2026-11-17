import { codePointLength } from '../domain/productRules.js';
import { formatInr } from '../lib/money.js';

/*
 * MONEY IS NEVER TYPED BY THE MODEL. Tool results expose amounts only as placeholders such as {{q1.total}}. The model writes the
 * placeholder, the server checks it against the real tool results and substitutes the amount. Any other currency amount in the text
 * (a symbol, or a currency word next to digits, in Latin, Gujarati or Devanagari script) discards the whole answer.
 */

const PLACEHOLDER = /\{\{\s*([a-z]\d+\.[a-z_]+)\s*\}\}/g;
const ANY_BRACES = /\{\{|\}\}/;
const BLANK = ' ';
const DIGIT = '[0-9\\u0966-\\u096F\\u0AE6-\\u0AEF]';
const NUMBER_RUN = '[0-9\\u0966-\\u096F\\u0AE6-\\u0AEF,.\\s]*';
const LATIN_WORDS = '(?:rs|inr|usd|rupees?|rupiyas?|dollars?|bucks)';
/** Short forms (रु, રૂ) count only when no Indic letter follows, so रुमाल (handkerchief) or રૂમ (room) are not mistaken for money. */
const NOT_INDIC_LETTER = '(?![\u0900-\u0965\u0970-\u097F\u0A80-\u0AE5\u0AF0-\u0AFF])';
const INDIC_WORDS = `(?:रुपये|रुपया|रुपए|रूपये|रूपया|રૂપિયા|રૂપિયો|રુપિયા|(?:रु|रू|રૂ)${NOT_INDIC_LETTER})`;
const AMOUNT_WORDS_ANYWHERE = /(?<![A-Za-z])(?:rupees?|rupiyas?)(?![A-Za-z])|रुपये|रुपया|रुपए|रूपये|रूपया|રૂપિયા|રૂપિયો|રુપિયા/iu;
const CURRENCY_SYMBOL = /[₹$€£¥]/u;
const LATIN_BEFORE_DIGIT = new RegExp(`(?<![A-Za-z])${LATIN_WORDS}(?![A-Za-z])[\\s.:\\-]*${DIGIT}`, 'iu');
const LATIN_AFTER_DIGIT = new RegExp(`${DIGIT}${NUMBER_RUN}(?<![A-Za-z])${LATIN_WORDS}(?![A-Za-z])`, 'iu');
const INDIC_BEFORE_DIGIT = new RegExp(`${INDIC_WORDS}[\\s.:\\-]*${DIGIT}`, 'u');
const INDIC_AFTER_DIGIT = new RegExp(`${DIGIT}${NUMBER_RUN}${INDIC_WORDS}`, 'u');
const AMOUNT_PATTERNS = [CURRENCY_SYMBOL, AMOUNT_WORDS_ANYWHERE, LATIN_BEFORE_DIGIT, LATIN_AFTER_DIGIT, INDIC_BEFORE_DIGIT, INDIC_AFTER_DIGIT];
const PERCENT_WORDS = '(?:%|percent|per cent|टक्के|प्रतिशत|ટકા)';
const PERCENT_AFTER_NUMBER = new RegExp(`(${DIGIT}+(?:\\.${DIGIT}+)?)\\s*${PERCENT_WORDS}`, 'giu');
const PERCENT_BEFORE_NUMBER = new RegExp(`${PERCENT_WORDS}\\s*(${DIGIT}+(?:\\.${DIGIT}+)?)`, 'giu');
const DEVANAGARI_ZERO = 0x0966;
const GUJARATI_ZERO = 0x0ae6;
const QUOTE_REF = /^q\d+\./;

/** @param {string} text @returns {string} The text with Devanagari and Gujarati digits turned into ASCII digits. */
export function toAsciiDigits(text) {
  return text.replace(/[०-९૦-૯]/g, (digit) => {
    const code = digit.codePointAt(0);
    return String(code - (code >= GUJARATI_ZERO ? GUJARATI_ZERO : DEVANAGARI_ZERO));
  });
}

/** @param {string} text @returns {boolean} True when the text holds a currency amount the model typed itself. */
export function hasTypedAmount(text) {
  return AMOUNT_PATTERNS.some((pattern) => pattern.test(text));
}

/** @returns {number[]} Every percentage figure in the text, as numbers. */
function percentFigures(text) {
  const ascii = toAsciiDigits(text);
  return [...ascii.matchAll(PERCENT_AFTER_NUMBER), ...ascii.matchAll(PERCENT_BEFORE_NUMBER)].map((match) => Number(match[1]));
}

const placeholderKeys = (text) => [...text.matchAll(PLACEHOLDER)].map((match) => match[1]);

/**
 * Validates the model's text and substitutes the money placeholders.
 * @param {string} text
 * @param {{ refs: Map<string, number>, allowedPercents: number[], maxLength: number }} context refs maps a placeholder key
 *   (for example "q1.total") to integer paise that really came from a tool result; allowedPercents are the CONFIRMED tier percentages.
 * @returns {{ ok: true, text: string, usedQuote: boolean } | { ok: false, reason: 'unverified_amount' | 'invalid_output' }}
 */
export function resolveMoney(text, { refs, allowedPercents, maxLength }) {
  const keys = placeholderKeys(text);
  if (keys.some((key) => !refs.has(key))) return { ok: false, reason: 'unverified_amount' };
  const bare = text.replace(PLACEHOLDER, BLANK);
  if (ANY_BRACES.test(bare) || hasTypedAmount(bare)) return { ok: false, reason: 'unverified_amount' };
  if (percentFigures(bare).some((percent) => !allowedPercents.includes(percent))) return { ok: false, reason: 'unverified_amount' };
  const substituted = text.replace(PLACEHOLDER, (_whole, key) => formatInr(refs.get(key))).trim();
  if (substituted === '' || codePointLength(substituted) > maxLength) return { ok: false, reason: 'invalid_output' };
  return { ok: true, text: substituted, usedQuote: keys.some((key) => QUOTE_REF.test(key)) };
}
