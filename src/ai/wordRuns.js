import { normalizeForMatch } from './knowledgeSources.js';

const WORD = /[\p{L}\p{N}]+/gu;

const wordsOf = (text) => normalizeForMatch(text).match(WORD) ?? [];

/**
 * True when the two texts share a run of at least `minWords` consecutive words (case and punctuation ignored).
 * @param {string} first @param {string} second @param {number} minWords
 * @returns {boolean}
 */
export function sharesWordRun(first, second, minWords) {
  const words = wordsOf(first);
  const runs = new Set(wordsOf(second).flatMap((_word, index, all) => (index + minWords <= all.length ? [all.slice(index, index + minWords).join(' ')] : [])));
  return words.some((_word, index) => runs.has(words.slice(index, index + minWords).join(' ')));
}
