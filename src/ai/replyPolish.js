import { MAX_EXCERPT_LENGTH, normalizeForMatch } from './knowledgeSources.js';
import { sharesWordRun } from './wordRuns.js';

/*
 * Small deterministic clean-ups of a finished reply, all in the reply language: no second estimate line, no "stock:" in front of a stock
 * figure that already says "in stock", and a "Based on" source for the product descriptions the reply really used.
 */

const TRAILING_PUNCTUATION = /[\s.!?।:;,]+$/u;
const MIN_DESCRIPTION_OVERLAP_WORDS = 3;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const closing = (text) => normalizeForMatch(text).replace(TRAILING_PUNCTUATION, '');

/**
 * Appends the "estimate" sentence to a quote unless the reply already ends with it (compared without case, spacing or end punctuation).
 * @param {string} text @param {string} note
 * @returns {string}
 */
export function withEstimateLine(text, note) {
  return closing(text).endsWith(closing(note)) ? text : `${text}\n\n${note}`;
}

/**
 * Removes a "stock:" lead-in right before a stock figure that already carries its own wording ("Stock: 38 in stock" becomes "38 in stock").
 * @param {string} text @param {{ stockWord: string, inStock: string }} words The localised word for stock and the localised "in stock" label.
 * @returns {string}
 */
export function removeStockLeadIn(text, { stockWord, inStock }) {
  const lead = new RegExp(`(?<![\\p{L}\\p{M}])${escapeRegExp(stockWord)}\\s*[:\\-–]?\\s*(?=[0-9\\u0966-\\u096F\\u0AE6-\\u0AEF]+\\s*${escapeRegExp(inStock)})`, 'giu');
  return text.replace(lead, '');
}

/**
 * Adds the product-description source when the reply reuses a run of words from a description the assistant read and did not cite one.
 * @param {{ label: string, excerpt?: string }[]} sources The verified sources.
 * @param {string} reply @param {string[]} descriptions The approved descriptions read this run.
 * @returns {{ label: string, excerpt?: string }[]}
 */
export function withDescriptionSource(sources, reply, descriptions) {
  if (sources.some((source) => source.label === 'product_description')) return sources;
  const used = descriptions.find((description) => sharesWordRun(reply, description, MIN_DESCRIPTION_OVERLAP_WORDS));
  return used ? [...sources, { label: 'product_description', excerpt: Array.from(used).slice(0, MAX_EXCERPT_LENGTH).join('') }] : sources;
}
