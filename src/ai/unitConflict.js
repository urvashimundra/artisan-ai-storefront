import { codePointLength } from '../domain/productRules.js';
import { toAsciiDigits } from './moneyPlaceholders.js';

/*
 * A deterministic check on a finished answer: does it state a measurement (for example "350 ml") about a product while the sources the
 * assistant read disagree about that measurement (the title says 300 ml, the seller notes say 350 ml)? The model must never pick a side,
 * so the server turns such an answer into a source conflict. The check compares CLAUSES, and only when the clauses are about the same
 * product (they share the product-type word of a product title the assistant was shown), measure the same unit, and talk about the same
 * attribute (they share a word like "holds", or one of them says nothing but the figure, as a title does). Delivery days and burn hours,
 * or the figures of two different products in one list, therefore never collide. English unit words only.
 */

const UNIT_ALIASES = Object.freeze({
  ml: ['ml', 'millilitre', 'millilitres', 'milliliter', 'milliliters', 'મિલીલીટર', 'મિલી', 'मिलीलीटर', 'मिली'],
  l: ['l', 'litre', 'litres', 'liter', 'liters', 'લિટર', 'लीटर'],
  g: ['g', 'gram', 'grams', 'ગ્રામ', 'ग्राम'],
  kg: ['kg', 'kilogram', 'kilograms', 'કિલોગ્રામ', 'કિલો', 'किलोग्राम', 'किलो'],
  cm: ['cm', 'સેન્ટિમીટર', 'સેમી', 'सेंटीमीटर', 'सेमी'],
  mm: ['mm', 'મિમી', 'मिमी'],
  inch: ['inch', 'inches', 'ઇંચ', 'इंच'],
  hours: ['hour', 'hours', 'hr', 'hrs', 'કલાક', 'घंटे', 'घंटा'],
  days: ['day', 'days', 'દિવસ', 'दिन'],
  pieces: ['piece', 'pieces', 'pc', 'pcs', 'નંગ', 'ટુકડા', 'पीस', 'नग', 'टुकड़े'],
});
/** Units that are the same quantity at another scale are compared in the smaller one: 0.5 l equals 500 ml. */
const SCALE_TO_BASE = Object.freeze({ l: ['ml', 1000], kg: ['g', 1000], cm: ['mm', 10] });
const UNIT_BY_WORD = new Map(Object.entries(UNIT_ALIASES).flatMap(([unit, words]) => words.map((word) => [word, unit])));
const NUMBER = '(\\d+(?:\\.\\d+)?)';
const MEASUREMENT = new RegExp(`(?<![\\p{L}\\p{N}.])${NUMBER}(?:\\s*(?:-|–|to)\\s*${NUMBER})?\\s*(${[...UNIT_BY_WORD.keys()].join('|')})(?![\\p{L}\\p{M}\\p{N}])`, 'giu');
/** A full stop between digits is a decimal point, not the end of a sentence. */
const SENTENCE_BREAK = /(?<!\d)\.(?!\d)|[!?\n;\u0964]+/gu;
const CLAUSE_BOUNDARY = /,|\band\b/giu;
const WORD = /[\p{L}\p{M}]+/gu;
const MIN_WORD_LENGTH = 3;
const MAX_SNIPPET_LENGTH = 300;
const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'its', 'are', 'was', 'has', 'have', 'about', 'around', 'each', 'per', 'approximately', 'approx', 'roughly', 'only', 'can', 'our', 'your', 'one', 'also', 'but', 'not', 'from', 'than', 'more', 'less']);
/** Words that name the same attribute, so "holds 350 ml" and "capacity 300 ml" are about one thing. */
const ATTRIBUTE_GROUPS = Object.freeze([
  ['holds', 'hold', 'holding', 'capacity', 'volume', 'fits', 'fit', 'size', 'contains', 'contain'],
  ['burns', 'burn', 'burning', 'lasts', 'last', 'lasting', 'duration'],
  ['weighs', 'weigh', 'weight'],
  ['measures', 'measure', 'height', 'width', 'length', 'diameter', 'tall', 'wide', 'long'],
]);
const GROUP_OF = new Map(ATTRIBUTE_GROUPS.flatMap((group) => group.map((word) => [word, group[0]])));

const wordsOf = (text) => (text.match(WORD) ?? []).map((word) => word.toLowerCase());
const isContentWord = (word) => codePointLength(word) >= MIN_WORD_LENGTH && !STOPWORDS.has(word) && !UNIT_BY_WORD.has(word);

/** @returns {number} The value in its base unit (500 ml for 0.5 l), rounded so decimals compare exactly. */
function toBase(value, unit) {
  const [, factor] = SCALE_TO_BASE[unit] ?? [unit, 1];
  return Math.round(value * factor * 1000) / 1000;
}

/** The product-type word of each shown title (its last word): the sentences that name it are about that product. */
const typeWordsOf = (titles) => new Set(titles.flatMap((title) => wordsOf(title).filter(isContentWord).slice(-1)));

/** Every word of the shown titles, so product names and colours do not count as the attribute a clause talks about. */
const titleWordsOf = (titles) => new Set(titles.flatMap(wordsOf));

const wordSpans = (text) => [...text.matchAll(WORD)].map((match) => ({ word: match[0].toLowerCase(), start: match.index, end: match.index + match[0].length }));
const lastBefore = (text, pattern, position) => Math.max(-1, ...[...text.matchAll(pattern)].filter((match) => match.index < position).map((match) => match.index + match[0].length));

/** One measurement with the product it is about and the attribute words in its own clause, or null when no product precedes it. */
function describeMeasurement(sentence, match, { typeWords, titleWords }) {
  const unit = UNIT_BY_WORD.get(match[3].toLowerCase());
  const spans = wordSpans(sentence);
  const product = spans.filter((span) => typeWords.has(span.word) && span.end <= match.index).at(-1);
  if (!product) return null;
  const from = Math.max(product.end, lastBefore(sentence, CLAUSE_BOUNDARY, match.index));
  const attributes = spans.filter((span) => span.start >= from && span.end <= match.index && isContentWord(span.word) && !titleWords.has(span.word));
  return {
    unit: SCALE_TO_BASE[unit]?.[0] ?? unit,
    values: [match[1], match[2]].filter(Boolean).map((figure) => toBase(Number(figure), unit)),
    product: product.word,
    attributes: new Set(attributes.map((span) => GROUP_OF.get(span.word) ?? span.word)),
    snippet: sentence.trim(),
  };
}

/** Every measurement about a shown product in a text. */
function measurementsOf(text, context) {
  return toAsciiDigits(text).split(SENTENCE_BREAK).flatMap((sentence) => [...sentence.matchAll(MEASUREMENT)].map((match) => describeMeasurement(sentence, match, context)).filter(Boolean));
}

/** Same attribute when either clause says nothing but the figure (a title), or they share an attribute word. */
const sameAttribute = (a, b) => a.attributes.size === 0 || b.attributes.size === 0 || [...a.attributes].some((word) => b.attributes.has(word));
const sameValues = (a, b) => a.values.length === b.values.length && a.values.every((value, index) => value === b.values[index]);
const clip = (text) => Array.from(text).slice(0, MAX_SNIPPET_LENGTH).join('');

/**
 * Every measurement (number and unit) stated in a text, in base units: 0.5 l is 500 ml. English, Gujarati and Hindi unit words and digits.
 * @param {string} text
 * @returns {{ unit: string, value: number }[]}
 */
export function extractMeasurements(text) {
  return [...toAsciiDigits(text).matchAll(MEASUREMENT)].flatMap((match) => {
    const unit = UNIT_BY_WORD.get(match[3].toLowerCase());
    const base = SCALE_TO_BASE[unit]?.[0] ?? unit;
    return [match[1], match[2]].filter(Boolean).map((figure) => ({ unit: base, value: toBase(Number(figure), unit) }));
  });
}

/**
 * @param {string} answer The final answer text (money already substituted).
 * @param {{ label: string, text: string }[]} sources The texts the assistant read this run: product titles and descriptions (label product_description), the seller notes, the shop profile.
 * @param {string[]} titles The product titles the assistant was shown.
 * @returns {{ topic: string, claims: { label: string, excerpt: string }[] } | null} Two verbatim source sentences that give different values for what the answer states, or null.
 */
export function findUnitConflict(answer, sources, titles) {
  const context = { typeWords: typeWordsOf(titles), titleWords: titleWordsOf(titles) };
  const written = sources.flatMap((source) => measurementsOf(source.text, context).map((entry) => ({ ...entry, label: source.label })));
  for (const claim of measurementsOf(answer, context)) {
    const related = written.filter((entry) => entry.unit === claim.unit && entry.product === claim.product && sameAttribute(claim, entry));
    const first = related[0];
    const other = first ? related.find((entry) => !sameValues(first, entry)) : undefined;
    if (first && other) {
      return { topic: `${claim.unit} figure for ${claim.product}`, claims: [{ label: first.label, excerpt: clip(first.snippet) }, { label: other.label, excerpt: clip(other.snippet) }] };
    }
  }
  return null;
}
