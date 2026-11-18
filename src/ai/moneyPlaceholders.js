import { codePointLength } from '../domain/productRules.js';
import { formatInr } from '../lib/money.js';

/*
 * MONEY IS NEVER TYPED BY THE MODEL. Tool results expose amounts only as placeholders such as {{q1.total}}. The model writes the
 * placeholder, the server checks it against the real tool results and substitutes the amount. Any other currency amount in the text
 * (a symbol, or a currency word next to digits, in Latin, Gujarati or Devanagari script) discards the whole answer.
 */

const PLACEHOLDER = /\{\{\s*([a-z]\d+\.[a-z_]+)\s*\}\}/g;
/** Label placeholders such as {{label.total}}: the server writes the word, in the customer's language, from its own strings. */
const LABEL = /\{\{\s*label\.([a-z_]+)\s*\}\}/g;
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
const BARE_NUMBER = /\d+(?:[,.]\d+)*/g;
/** A bare number with this many integer digits is read as a possible amount unless a tool result gave it. */
const MIN_AMOUNT_DIGITS = 3;
const MONEY_CONTEXT_WINDOW = 40;
/** Opening hours and clock times ("10 am", "7 pm", "10:00", "10 बजे", "10 વાગ્યે"): never an amount, so a money word nearby does not make them one. */
const CLOCK_TIME = new RegExp(`${DIGIT}{1,2}(?:[:.]${DIGIT}{2})?\\s*(?:[ap]\\.?m\\.?(?![A-Za-z])|बजे|वाजता|વાગ્યે|વાગે)|${DIGIT}{1,2}:${DIGIT}{2}(?!${DIGIT})`, 'giu');
const MONEY_WORDS = '(?:total|subtotal|sub-total|prices?|priced|costs?|amount|pay|payable|payment|charges?|charged|fees?|worth|bill|rate|mrp|discount|કુલ|કિંમત|ભાવ|રકમ|મૂલ્ય|ચાર્જ|ખર્ચ|कुल|कीमत|दाम|भाव|मूल्य|रकम|राशि|भुगतान|शुल्क)';
const MONEY_WORD_BEFORE = new RegExp(`${MONEY_WORDS}[^0-9.!?;\\n]*$`, 'iu');
const MONEY_WORD_AFTER = new RegExp(`^\\s*${MONEY_WORDS}`, 'iu');
/** A percentage is a discount claim when one of these words sits right beside it: "100% soy wax" is not one, "100% off" is. */
const DISCOUNT_WORDS = /(?<![A-Za-z])(?:discounts?|off|save[sd]?|savings?|sale|deals?|offers?|concession)(?![A-Za-z])|છૂટ|ડિસ્કાઉન્ટ|ઓફ|બચત|छूट|डिस्काउंट|ऑफ|बचत|रियायत/iu;
const DISCOUNT_WINDOW = 12;
/** How far back a tier statement may reach for its minimum quantity: "for 10 boxes the discount is 5%". */
const TIER_CLAUSE_WINDOW = 60;
/** The context of a percentage stops at the end of its clause, so "5% off, 100% soy wax" does not make the second figure a discount. */
const CLAUSE_BREAK = /[,;.!?:\n]/;

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

/**
 * Every percentage figure in the text with the few characters around it.
 * @param {string} ascii Text already passed through toAsciiDigits.
 * @returns {{ value: number, context: string, clause: string }[]} clause reaches further back, to the start of the sentence part.
 */
export function percentMentions(ascii) {
  return [...ascii.matchAll(PERCENT_AFTER_NUMBER), ...ascii.matchAll(PERCENT_BEFORE_NUMBER)].map((match) => {
    const before = ascii.slice(Math.max(0, match.index - DISCOUNT_WINDOW), match.index).split(CLAUSE_BREAK).at(-1);
    const after = ascii.slice(match.index + match[0].length, match.index + match[0].length + DISCOUNT_WINDOW).split(CLAUSE_BREAK)[0];
    const clauseBefore = ascii.slice(Math.max(0, match.index - TIER_CLAUSE_WINDOW), match.index).split(CLAUSE_BREAK).at(-1);
    return { value: Number(match[1]), context: `${before}${match[0]}${after}`, clause: `${clauseBefore}${match[0]}${after}` };
  });
}

/** @param {string} context @returns {boolean} True when a discount word sits in this stretch of text. */
export const isDiscountContext = (context) => DISCOUNT_WORDS.test(context);

/** @param {string} ascii Text already passed through toAsciiDigits. @returns {number[]} Every bare number in it. */
export const plainNumbers = (ascii) => [...ascii.matchAll(BARE_NUMBER)].map((match) => Number(match[0].replaceAll(',', '')));

/** @returns {boolean} True when a money word sits right beside the digits at [start, end). */
function besideMoneyWord(ascii, start, end) {
  const before = ascii.slice(Math.max(0, start - MONEY_CONTEXT_WINDOW), start);
  return MONEY_WORD_BEFORE.test(before) || MONEY_WORD_AFTER.test(ascii.slice(end, end + MONEY_CONTEXT_WINDOW));
}

/** @returns {boolean} True when the digits at [start, end) look like an amount: three or more integer digits, or a money word right beside them. */
function looksLikeAmount(ascii, start, end) {
  const integerDigits = ascii.slice(start, end).split('.')[0].replaceAll(',', '').length;
  return integerDigits >= MIN_AMOUNT_DIGITS || besideMoneyWord(ascii, start, end);
}

/**
 * Bare numbers (no currency marker) that nothing vouches for, such as "12 pieces, total 1200". Quantities, stock figures, tier minimums and
 * percentages that a tool returned are allowed anywhere. Figures the shop's own texts state ("200 g", "45 hours") are allowed too, but not
 * right beside a money word. Anything else is refused only when it looks like an amount.
 * @param {string} text @param {number[]} allowedNumbers @param {number[]} [descriptiveNumbers] @returns {boolean}
 */
export function hasUnverifiedNumber(text, allowedNumbers, descriptiveNumbers = []) {
  const ascii = toAsciiDigits(text).replace(CLOCK_TIME, (time) => BLANK.repeat(time.length));
  const allowed = new Set(allowedNumbers);
  const descriptive = new Set(descriptiveNumbers);
  return [...ascii.matchAll(BARE_NUMBER)].some((match) => {
    const value = Number(match[0].replaceAll(',', ''));
    const end = match.index + match[0].length;
    if (allowed.has(value) || (descriptive.has(value) && !besideMoneyWord(ascii, match.index, end))) return false;
    return looksLikeAmount(ascii, match.index, end);
  });
}

/** True when the mention is a confirmed tier percentage stated together with that tier's own minimum quantity ("10 boxes: 5%"), whatever quote came first. */
const statesConfirmedTier = (mention, tiers) =>
  tiers.some((tier) => tier.percentOff === mention.value && plainNumbers(mention.clause).includes(tier.minQty));

/** A percentage may be stated when it is a confirmed one, one a confirmed tier states beside its own quantity, or one the shop's texts state about a product ("100% soy wax") and it is not used as a discount here. */
const percentAllowed = (mention, { allowedPercents, descriptivePercents, tiers }) =>
  allowedPercents.includes(mention.value) || statesConfirmedTier(mention, tiers) || (descriptivePercents.includes(mention.value) && !isDiscountContext(mention.context));

const placeholderKeys = (text) => [...text.matchAll(PLACEHOLDER)].map((match) => match[1]);

/**
 * Validates the model's text and substitutes the money placeholders.
 * @param {string} text
 * @param {{ refs: Map<string, number>, allowedPercents: number[], allowedNumbers?: number[], descriptive?: { numbers: number[], percents: number[] },
 *   maxLength: number }} context refs maps a placeholder key (for example "q1.total") to integer paise that really came from a tool result;
 *   allowedPercents are the percentages that apply to the quoted quantities; allowedNumbers are the other plain numbers a tool returned
 *   (quantities, stock, tier minimums); descriptive holds the figures the shop's own texts state (see descriptiveFigures), never usable as a price or a discount;
 *   percentRefs maps a placeholder key such as "q1.discount_percent" to the whole percentage the server's quote applied; tiers are the confirmed bulk tiers
 *   (a tier's percentage may be stated beside its own minimum quantity, even when the quote asked for another quantity); labels maps a label key (for example "total") to the word in the customer's language.
 * @returns {{ ok: true, text: string, usedQuote: boolean } | { ok: false, reason: 'unverified_amount' | 'invalid_output' }}
 */
export function resolveMoney(text, { refs, percentRefs = new Map(), tiers = [], allowedPercents, allowedNumbers = [], descriptive = { numbers: [], percents: [] }, labels = {}, maxLength }) {
  const keys = placeholderKeys(text);
  if (keys.some((key) => !refs.has(key) && !percentRefs.has(key))) return { ok: false, reason: 'unverified_amount' };
  if ([...text.matchAll(LABEL)].some((match) => !Object.hasOwn(labels, match[1]))) return { ok: false, reason: 'invalid_output' };
  const bare = text.replace(PLACEHOLDER, BLANK).replace(LABEL, BLANK);
  if (ANY_BRACES.test(bare) || hasTypedAmount(bare)) return { ok: false, reason: 'unverified_amount' };
  if (percentMentions(toAsciiDigits(bare)).some((mention) => !percentAllowed(mention, { allowedPercents, descriptivePercents: descriptive.percents, tiers }))) return { ok: false, reason: 'unverified_amount' };
  if (hasUnverifiedNumber(bare, [...allowedNumbers, ...allowedPercents], descriptive.numbers)) return { ok: false, reason: 'unverified_amount' };
  const substituted = text.replace(PLACEHOLDER, (_whole, key) => (percentRefs.has(key) ? String(percentRefs.get(key)) : formatInr(refs.get(key)))).replace(LABEL, (_whole, key) => labels[key]).trim();
  if (substituted === '' || codePointLength(substituted) > maxLength) return { ok: false, reason: 'invalid_output' };
  return { ok: true, text: substituted, usedQuote: keys.some((key) => QUOTE_REF.test(key)) };
}
