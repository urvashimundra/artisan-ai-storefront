import { z } from 'zod';
import { productReviewSchema } from './productRules.js';
import { LANGUAGES } from './storeRules.js';

/** Highest stock count an owner can enter. */
export const MAX_STOCK = 1_000_000;
const MAX_STOCK_INPUT_LENGTH = 7;
const STOCK_DIGITS = /^\d+$/;
const CHECKBOX_ON = 'on';
const PAISE_PER_RUPEE = 100;
const PAISE_DIGITS = 2;

export const REVIEW_INTENTS = Object.freeze({ save: 'save', publish: 'publish' });

/** Optional stock from a form: blank means "not tracked" (null); otherwise a whole number from 0 to MAX_STOCK. */
export const stockInputSchema = z
  .string()
  .max(MAX_STOCK_INPUT_LENGTH)
  .transform((value) => value.trim())
  .refine((value) => value === '' || (STOCK_DIGITS.test(value) && Number(value) <= MAX_STOCK))
  .transform((value) => (value === '' ? null : Number(value)));

const languageFields = (language) => ({
  [`title_${language}`]: z.string(),
  [`description_${language}`]: z.string(),
  [`alt_text_${language}`]: z.string(),
  [`approved_${language}`]: z.literal(CHECKBOX_ON).optional(),
});

/** The flat form exactly as the browser posts it. Strict: any other key (store_id, status, ...) is rejected. */
const flatReviewFormSchema = z
  .object({
    story: z.string(),
    price: z.string(),
    stock: z.string(),
    intent: z.enum([REVIEW_INTENTS.save, REVIEW_INTENTS.publish]),
    ...Object.assign({}, ...LANGUAGES.map(languageFields)),
  })
  .strict();

function toReviewInput(form) {
  const translations = {};
  for (const language of LANGUAGES) {
    translations[language] = {
      title: form[`title_${language}`],
      description: form[`description_${language}`],
      alt_text: form[`alt_text_${language}`],
    };
  }
  return {
    review: {
      story: form.story,
      price: form.price,
      translations,
      approvedLanguages: LANGUAGES.filter((language) => form[`approved_${language}`] === CHECKBOX_ON),
      publish: form.intent === REVIEW_INTENTS.publish,
    },
    stock: form.stock,
  };
}

/** Flat form -> validated `{ review, stock }`. Issue paths start with `review` or `stock`. */
export const reviewFormSchema = flatReviewFormSchema
  .transform(toReviewInput)
  .pipe(z.object({ review: productReviewSchema, stock: stockInputSchema }).strict());

/**
 * Validates the posted review form. Price becomes integer paise, stock a number or null.
 * @param {unknown} body Parsed urlencoded body.
 * @returns {{ review: z.infer<typeof productReviewSchema>, stock: number | null }}
 * @throws {import('zod').ZodError}
 */
export function parseReviewForm(body) {
  return reviewFormSchema.parse(body ?? {});
}

/**
 * Integer paise as the text of a price input: "499" or "499.50". Null gives an empty string.
 * @param {number | null} paise
 * @returns {string}
 */
export function formatPriceInput(paise) {
  if (paise === null || paise === undefined) return '';
  const rupees = Math.floor(paise / PAISE_PER_RUPEE);
  const remainder = paise % PAISE_PER_RUPEE;
  return remainder === 0 ? String(rupees) : `${rupees}.${String(remainder).padStart(PAISE_DIGITS, '0')}`;
}
