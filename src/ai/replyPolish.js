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
  if (text.trim() === '') return note;
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

const SENTENCES = /((?<=[.!?।])[ \t]+|\n+)/u;
const ANY_DIGIT = /[0-9\u0966-\u096F\u0AE6-\u0AEF₹]/u;
const ESTIMATE_WORD = { en: /\b(?:estimates?|estimated|approximate(?:ly)?)\b/iu, gu: /અંદાજ|અનુમાન/u, hi: /अनुमान|अंदाज|अन्दाज/u };
const CONFIRM_WORD = { en: /\b(?:confirm\w*|final\w*|verif\w*)\b/iu, gu: /પુષ્ટિ|કન્ફર્મ|અંતિમ|ફાઇનલ/u, hi: /पुष्टि|कन्फ़र्म|कन्फर्म|अंतिम|फ़ाइनल|फाइनल/u };
const SELLER_WORD = { en: /\b(?:seller|shop ?owner|owner|shop|artisan)\b/iu, gu: /વિક્રેતા|દુકાનદાર|માલિક/u, hi: /विक्रेता|दुकानदार|मालिक/u };
const AMOUNT_WORD = {
  en: /\b(?:amounts?|price[sd]?|pricing|totals?|quotes?|quoted|costs?|charges?)\b/iu,
  gu: /રકમ|કિંમત|કુલ|ભાવ|ક્વોટ|ખર્ચ/u,
  hi: /राशि|रकम|कीमत|कुल|मूल्य|भाव|कोट|खर्च/u,
};
const TIMELINE_WORD = {
  en: /\b(?:deliver\w*|dispatch\w*|ship\w*|ready|production|timelines?|schedules?|dates?|days?|weeks?|times?|stock|availab\w*|made|make)\b/iu,
  gu: /ડિલિવરી|તારીખ|દિવસ|સમય|અઠવાડિ|સ્ટોક|ઉપલબ્ધ|મોકલ|તૈયાર|શિપ/u,
  hi: /डिलीवरी|तारीख|दिन|समय|सप्ताह|हफ़्ते|हफ्ते|स्टॉक|उपलब्ध|भेज|तैयार|शिप/u,
};
const MAX_ESTIMATE_SENTENCE_LENGTH = 140;
const MAX_BARE_ESTIMATE_WORDS = 6;
const MAX_BARE_CONFIRM_WORDS = 5;
const EN_BARE_CONFIRM = /^(?:the |our )?(?:seller|shop ?owner|owner|shop)\s+(?:will|shall|would)\s+(?:also\s+)?(?:confirm|finali[sz]e|verify)(?:\s+(?:it|this|that|the (?:final )?(?:amount|total|price|quote)|everything))?(?:\s+(?:later|soon|first|separately))?$/iu;
const wordCount = (text) => text.split(/\s+/u).filter(Boolean).length;

/** True when a sentence only says the amount is an estimate and/or the seller will confirm it: no figure, no other content (by meaning, not exact text). */
function isEstimateSentence(sentence, language) {
  const bare = sentence.trim().replace(/[\s.!?।,;:]+$/u, '');
  if (bare === '' || ANY_DIGIT.test(bare) || bare.length > MAX_ESTIMATE_SENTENCE_LENGTH || TIMELINE_WORD[language].test(bare)) return false;
  const estimate = ESTIMATE_WORD[language].test(bare);
  const confirm = CONFIRM_WORD[language].test(bare);
  const seller = SELLER_WORD[language].test(bare);
  if (estimate) return AMOUNT_WORD[language].test(bare) || (confirm && seller) || wordCount(bare) <= MAX_BARE_ESTIMATE_WORDS;
  return language === 'en' ? EN_BARE_CONFIRM.test(bare) : seller && confirm && wordCount(bare) <= MAX_BARE_CONFIRM_WORDS;
}

/**
 * Removes the model's own "this is an estimate / the seller will confirm" sentences (matched by meaning, in the reply language) so the server's
 * one estimate line is the only one. A sentence that carries an amount or any other content is kept.
 * @param {string} text @param {'en'|'gu'|'hi'} language
 * @returns {string} The remaining text; empty when the whole reply was only estimate wording.
 */
export function withoutEstimateSentences(text, language) {
  if (!ESTIMATE_WORD[language]) return text;
  const parts = text.split(SENTENCES);
  const kept = [];
  for (let index = 0; index < parts.length; index += 2) {
    if (!isEstimateSentence(parts[index], language)) kept.push(parts[index], parts[index + 1] ?? '');
  }
  return kept.join('').trim();
}

const QUOTED = /“[^”]*”|"[^"]*"|«[^»]*»|„[^“”]*[“”]/gu;
const PRIVATE_USE_START = 0xe100;
const MAX_PROTECTED = 500;
const REPEATED_WORD = /(?<![\p{L}\p{M}\p{N}])([\p{L}\p{M}]+)(?:[\s,;:-]+\1)+(?![\p{L}\p{M}\p{N}])/giu;

/**
 * Collapses an immediately repeated word (case and punctuation ignored, Latin, Gujarati and Hindi): "સ્ટોકમાં સ્ટોકમાં 38 છે" becomes "સ્ટોકમાં 38 છે".
 * Numbers are never collapsed, and product names (`names`) and quoted text are left exactly as written.
 * @param {string} text @param {string[]} [names] Product titles and names the tools returned.
 * @returns {string}
 */
export function collapseRepeatedWords(text, names = []) {
  const saved = [];
  const protect = (span) => (saved.length < MAX_PROTECTED ? String.fromCharCode(PRIVATE_USE_START + saved.push(span) - 1) : span);
  const named = names.filter((name) => name.trim() !== '').sort((a, b) => b.length - a.length).reduce((rest, name) => rest.replace(new RegExp(escapeRegExp(name.trim()), 'giu'), protect), text);
  const collapsed = named.replace(QUOTED, protect).replace(REPEATED_WORD, '$1');
  return collapsed.replace(/[\ue100-\ue2ff]/gu, (mark) => saved[mark.charCodeAt(0) - PRIVATE_USE_START] ?? mark);
}
