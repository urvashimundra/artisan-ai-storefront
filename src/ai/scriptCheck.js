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
