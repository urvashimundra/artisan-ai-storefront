import { z } from 'zod';
import { toPaise } from '../lib/money.js';
import { LANGUAGES } from './storeRules.js';

/** Length limits. Mirrored in db/migrations/004_products.sql (a unit test compares them). Counted in code points. */
export const MAX_TITLE_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 1200;
export const MAX_ALT_TEXT_LENGTH = 250;
export const MAX_PRODUCT_STORY_LENGTH = 1500;

/** Price range in rupees; the database CHECK uses the paise equivalents. */
export const MIN_PRICE_RUPEES = 1;
export const MAX_PRICE_RUPEES = 1_000_000;
export const MIN_PRICE_PAISE = 100;
export const MAX_PRICE_PAISE = 100_000_000;
const MAX_PRICE_INPUT_LENGTH = 20;

// C0/C1 controls. Zero-width joiners (U+200C, U+200D) are format characters, not controls, so Indic text keeps them.
const CONTROL_CHARACTERS = /[\p{Cc}]/gu;
const CONTROL_EXCEPT_NEWLINE = /[^\P{Cc}\n]/gu;
const LINE_BREAKS = /\r\n?/g;

/** @param {string} text @returns {number} Length in Unicode code points, as PostgreSQL char_length counts it. */
export function codePointLength(text) {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/** Single-line text: NFKC is NOT applied (it can alter Indic text); controls, including newlines, are removed. */
export function cleanLine(text) {
  return text.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Story text: NFKC normalized, line breaks unified to \n, every other control character removed, trimmed.
 * @param {string} text
 * @returns {string}
 */
export function normalizeStory(text) {
  return text.normalize('NFKC').replace(LINE_BREAKS, '\n').replace(CONTROL_EXCEPT_NEWLINE, '').trim();
}

/** Multi-line text such as a description: line breaks unified, other controls removed. NFKC is not applied. */
export function normalizeParagraph(text) {
  return text.replace(LINE_BREAKS, '\n').replace(CONTROL_EXCEPT_NEWLINE, '').trim();
}

const maxCodePoints = (limit) => (value) => codePointLength(value) <= limit;

const storyBase = z.string().max(MAX_PRODUCT_STORY_LENGTH * 4).transform(normalizeStory).refine(maxCodePoints(MAX_PRODUCT_STORY_LENGTH));

/** Story as saved with a product: may be empty. */
export const storySchema = storyBase;

/** Story required to start AI generation: at least one character. */
export const generationStorySchema = storyBase.refine((value) => value.length > 0);

/** Parses rupees ("1", "499.50") into integer paise within range, or null when invalid. */
export function parsePriceRupees(text) {
  try {
    const paise = toPaise(text);
    return paise >= MIN_PRICE_PAISE && paise <= MAX_PRICE_PAISE ? paise : null;
  } catch {
    return null;
  }
}

/** Optional price from a form: blank means "no price yet" (null); otherwise integer paise in range. */
export const priceInputSchema = z
  .string()
  .max(MAX_PRICE_INPUT_LENGTH)
  .transform((value) => value.trim())
  .refine((value) => value === '' || parsePriceRupees(value) !== null)
  .transform((value) => (value === '' ? null : parsePriceRupees(value)));

const lineField = (limit) => z.string().max(limit * 4).transform(cleanLine).refine(maxCodePoints(limit));

/** One language of a product as submitted by the owner. Empty text is allowed while drafting. */
export const translationInputSchema = z
  .object({
    title: lineField(MAX_TITLE_LENGTH),
    description: z.string().max(MAX_DESCRIPTION_LENGTH * 4).transform(normalizeParagraph).refine(maxCodePoints(MAX_DESCRIPTION_LENGTH)),
    alt_text: lineField(MAX_ALT_TEXT_LENGTH),
  })
  .strict();

const isComplete = (t) => t.title.length > 0 && t.description.length > 0 && t.alt_text.length > 0;

/**
 * The review form after the controller has gathered it into one object. Strict: store_id, status, is_demo and
 * any other key is rejected. Approving a language requires all three of its fields.
 */
export const productReviewSchema = z
  .object({
    story: storySchema,
    price: priceInputSchema,
    translations: z.object({ en: translationInputSchema, gu: translationInputSchema, hi: translationInputSchema }).strict(),
    approvedLanguages: z.array(z.enum(LANGUAGES)).max(LANGUAGES.length).transform((langs) => [...new Set(langs)]),
    publish: z.boolean(),
  })
  .strict()
  .superRefine((review, ctx) => {
    for (const language of review.approvedLanguages) {
      if (!isComplete(review.translations[language])) {
        ctx.addIssue({ code: 'custom', path: ['translations', language], message: 'incomplete_translation' });
      }
    }
    if (review.publish && review.price === null) ctx.addIssue({ code: 'custom', path: ['price'], message: 'price_required' });
  });

/** Body of POST /products/:id/generate. */
export const generateRequestSchema = z.object({ story: generationStorySchema }).strict();

/** Route params for /products/:id/... */
export const productIdParamsSchema = z.object({ id: z.uuid() }).strict();
