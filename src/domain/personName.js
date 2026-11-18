import { z } from 'zod';
import { cleanLine, codePointLength } from './productRules.js';

export const MIN_NAME_LENGTH = 2;
export const MIN_NAME_LETTERS = 2;
const RAW_FIELD_FACTOR = 4;
/** Unicode letters and combining marks (every Indic script), spaces, straight or curly apostrophes, hyphen and full stop. */
const NAME_CHARACTERS = /^[\p{L}\p{M}' ‘’.-]+$/u;
const LETTER = /\p{L}/gu;

/**
 * True for a person's name after cleaning: allowed characters only, 2 to `maxLength` code points, at least 2 letters. Digits and
 * other symbols are rejected.
 * @param {string} cleaned A name already trimmed and with spaces collapsed.
 * @param {number} maxLength
 * @returns {boolean}
 */
export function isValidPersonName(cleaned, maxLength) {
  const length = codePointLength(cleaned);
  if (length < MIN_NAME_LENGTH || length > maxLength || !NAME_CHARACTERS.test(cleaned)) return false;
  return (cleaned.match(LETTER) ?? []).length >= MIN_NAME_LETTERS;
}

/**
 * Zod field for a customer's name: trims, collapses spaces, then validates with isValidPersonName.
 * @param {number} maxLength Maximum code points after cleaning.
 * @param {string} [message] Issue message.
 */
export function personNameField(maxLength, message = 'invalid_name') {
  return z
    .string()
    .max(maxLength * RAW_FIELD_FACTOR)
    .transform(cleanLine)
    .refine((value) => isValidPersonName(value, maxLength), { message });
}
