import { MAX_ALT_TEXT_LENGTH, MAX_DESCRIPTION_LENGTH, MAX_PRODUCT_STORY_LENGTH, MAX_TITLE_LENGTH } from '../domain/productRules.js';
import { LANGUAGES } from '../domain/storeRules.js';

const UNRECOGNIZED_KEYS = 'unrecognized_keys';
const REVIEW_SEGMENT = 'review';
const LANGUAGE_SUFFIX = /_(en|gu|hi)$/;

export const STORY_MESSAGE = `Write a few sentences about the product, up to ${MAX_PRODUCT_STORY_LENGTH} characters.`;
const MESSAGES = {
  price: 'Enter a price from 1 to 1,000,000 rupees, for example 499.50.',
  priceRequired: 'Enter a price before publishing.',
  stock: 'Enter a whole number from 0 to 1,000,000, or leave this blank.',
  story: STORY_MESSAGE,
  incomplete: 'To approve this language, fill in its title, description and photo description.',
  length: `Check the lengths: title up to ${MAX_TITLE_LENGTH}, description up to ${MAX_DESCRIPTION_LENGTH}, photo description up to ${MAX_ALT_TEXT_LENGTH} characters.`,
};

function targetOf(path) {
  const parts = path[0] === REVIEW_SEGMENT ? path.slice(1) : path;
  if (parts[0] === 'translations' && LANGUAGES.includes(parts[1])) return parts[1];
  const flatLanguage = LANGUAGE_SUFFIX.exec(String(parts[0]))?.[1];
  return flatLanguage ?? String(parts[0]);
}

function messageFor(target, issue) {
  if (LANGUAGES.includes(target)) return issue.message === 'incomplete_translation' ? MESSAGES.incomplete : MESSAGES.length;
  if (target === 'price') return issue.message === 'price_required' ? MESSAGES.priceRequired : MESSAGES.price;
  return MESSAGES[target];
}

/**
 * Maps a review-form ZodError to one message per field (`price`, `stock`, `story`) or per language (`en`, `gu`, `hi`).
 * An unknown key, a missing field or anything else a normal form cannot produce means a tampered request: the error is
 * rethrown so the central handler answers 400.
 * @param {import('zod').ZodError} zodError
 * @returns {Record<string, string>}
 */
export function reviewFormErrors(zodError) {
  if (zodError.issues.some((issue) => issue.code === UNRECOGNIZED_KEYS)) throw zodError;
  const errors = {};
  for (const issue of zodError.issues) {
    const target = targetOf(issue.path);
    const message = messageFor(target, issue);
    if (!message) throw zodError;
    errors[target] ??= message;
  }
  return errors;
}
