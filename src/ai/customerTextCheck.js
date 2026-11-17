import { withoutNames } from './scriptCheck.js';

/*
 * Words that reveal how a customer-facing answer was produced: the placeholder mechanism, the tools, templates, live filling. Matched in
 * English, Gujarati and Hindi whatever the reply language is, because a model that leaks in one language leaks in all of them.
 * Gujarati and Hindi coverage is practical rather than complete: the seller's human review should extend it.
 */
const INTERNALS_PATTERN = new RegExp([
  String.raw`\b(?:placeholders?|templates?|tools?|tool results?|final_answer|search_products|check_product|calculate_quote|get_bulk_discounts|live_catalog)\b`,
  String.raw`filled (?:in )?live`,
  String.raw`\{\{`,
  'પ્લેસહોલ્ડર', 'ટેમ્પલેટ', 'ટૂલ', 'ટુલ', String.raw`લાઇવ[^.!?\n]{0,20}ભર`,
  'प्लेसहोल्डर', 'टेम्पलेट', 'टेम्प्लेट', 'टूल', String.raw`लाइव[^।.!?\n]{0,20}भर`,
].join('|'), 'iu');

/**
 * True when a customer-facing reply describes how it was produced (placeholders, tools, templates, filling in live). Product titles and
 * names the tools returned are removed first, so a shop's own "Tool Kit" is not flagged.
 * @param {string} text Reply text with the money placeholders already removed. @param {string[]} [names] Product titles and names shown to the model.
 * @returns {boolean}
 */
export const mentionsInternals = (text, names = []) => INTERNALS_PATTERN.test(withoutNames(text, names));
