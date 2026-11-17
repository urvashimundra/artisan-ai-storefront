/*
 * Pure product matching for the assistant's catalogue tools. No I/O. A customer (or the model on their behalf) rarely types a title exactly:
 * "Cashmere Jar Candles" must find "Cashmere Jar Candle", an English name must find a product whose page title is Gujarati, and
 * "scented candles as a gift" must still lead to the candles. Matching is by stemmed words across every approved title, then the description.
 */
const WORD = /[\p{L}\p{M}\p{N}]+/gu;
const MIN_WORD_LENGTH = 2;
const MIN_STEMMABLE_LENGTH = 4;
const LATIN_WORD = /^[a-z]+$/;
const ES_PLURAL = /(?:x|z|ch|sh|s)es$/;
const TITLE_WEIGHT = 3;
const DESCRIPTION_WEIGHT = 1;
const MIN_NAMED_WORDS = 2;
const MIN_NAMED_COVERAGE = 0.6;
/** How many products a message may be taken to name (a message that names more is a catalogue question, answered by search). */
export const MAX_NAMED_PRODUCTS = 3;

const FILLER_WORDS = new Set([
  'a', 'an', 'the', 'of', 'for', 'and', 'or', 'in', 'on', 'to', 'me', 'my', 'you', 'your', 'is', 'are', 'can', 'do', 'does', 'it', 'its', 'all', 'any',
  'some', 'show', 'tell', 'about', 'with', 'have', 'has', 'what', 'which', 'how', 'much', 'many', 'please', 'want', 'buy', 'looking', 'look', 'like',
  'need', 'get', 'as', 'at', 'be', 'by', 'from', 'this', 'that', 'there', 'available', 'right', 'now', 'price', 'prices', 'order', 'instead', 'im',
]);

/** Plain English plural stripping; other scripts are left alone. */
function stem(word) {
  if (word.length < MIN_STEMMABLE_LENGTH || !LATIN_WORD.test(word) || word.endsWith('ss')) return word;
  if (ES_PLURAL.test(word)) return word.slice(0, -2);
  return word.endsWith('s') ? word.slice(0, -1) : word;
}

/** @param {string} text @returns {string[]} The distinct meaningful, stemmed words of the text (lower case, NFC, no filler). */
export function termsOf(text) {
  const words = String(text ?? '').normalize('NFC').toLowerCase().match(WORD) ?? [];
  return [...new Set(words.filter((word) => word.length >= MIN_WORD_LENGTH && !FILLER_WORDS.has(word)).map(stem))];
}

const titleHits = (entry, term) => entry.titles.some((title) => termsOf(title).includes(term));

function scoreOf(entry, terms) {
  const descriptionTerms = termsOf(entry.description);
  return terms.reduce((sum, term) => sum + (titleHits(entry, term) ? TITLE_WEIGHT : descriptionTerms.includes(term) ? DESCRIPTION_WEIGHT : 0), 0);
}

/**
 * Ranks catalogue entries for a free-text query, best first (ties keep the catalogue order). With no usable words every entry matches.
 * @param {{ titles: string[], description: string }[]} entries One per product: every approved title it has, and the shown description.
 * @param {string | undefined} query
 * @returns {{ entries: object[], matched: boolean }} `entries` holds only the matches when there are any, otherwise the whole catalogue
 *   (so a miss never turns into "the shop has nothing"), and `matched` says which of the two it is.
 */
export function rankByQuery(entries, query) {
  const terms = termsOf(query);
  if (terms.length === 0) return { entries: [...entries], matched: true };
  const scored = entries.map((entry, index) => ({ entry, index, score: scoreOf(entry, terms) })).filter((item) => item.score > 0);
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.length > 0 ? { entries: scored.map((item) => item.entry), matched: true } : { entries: [...entries], matched: false };
}

function coverageOf(entry, messageTerms) {
  return Math.max(0, ...entry.titles.map((title) => {
    const words = termsOf(title);
    const hits = words.filter((word) => messageTerms.has(word)).length;
    const enough = words.length === 1 ? hits === 1 : hits >= MIN_NAMED_WORDS && hits / words.length >= MIN_NAMED_COVERAGE;
    return enough ? hits / words.length : 0;
  }));
}

/**
 * The products a conversation names: those whose title (in any language) is mostly present in the customer's messages. Used to put the
 * records of the products under discussion in front of the model, including for a follow-up that no longer names the product.
 * @param {{ titles: string[] }[]} entries @param {string[]} customerTexts
 * @returns {object[]} At most MAX_NAMED_PRODUCTS entries, best match first.
 */
export function namedEntries(entries, customerTexts) {
  const messageTerms = new Set(customerTexts.flatMap(termsOf));
  return entries
    .map((entry, index) => ({ entry, index, coverage: coverageOf(entry, messageTerms) }))
    .filter((item) => item.coverage > 0)
    .sort((a, b) => b.coverage - a.coverage || a.index - b.index)
    .slice(0, MAX_NAMED_PRODUCTS)
    .map((item) => item.entry);
}
