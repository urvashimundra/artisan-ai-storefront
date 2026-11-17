import { z } from 'zod';
import { codePointLength, normalizeParagraph } from './productRules.js';

/** Limits. Mirrored in db/migrations/012_assistant.sql (a unit test compares them). Counted in code points. */
export const MAX_KNOWLEDGE_LENGTH = 20_000;
export const MAX_BULK_TIERS = 5;
export const MIN_TIER_QUANTITY = 2;
export const MAX_TIER_QUANTITY = 1000;
export const MIN_TIER_PERCENT = 1;
export const MAX_TIER_PERCENT = 50;
const RAW_FIELD_FACTOR = 4;
const PERCENT_DIVISOR = 100;
const MAX_FORM_NUMBER_LENGTH = 10;
const TIER_ROWS = Array.from({ length: MAX_BULK_TIERS }, (_, index) => index + 1);

const tierSchema = z
  .object({
    minQty: z.number().int().min(MIN_TIER_QUANTITY).max(MAX_TIER_QUANTITY),
    percentOff: z.number().int().min(MIN_TIER_PERCENT).max(MAX_TIER_PERCENT),
  })
  .strict();

const isStrictlyIncreasing = (tiers) => tiers.every((tier, index) => index === 0 || tier.minQty > tiers[index - 1].minQty);

/** The confirmed bulk tiers: at most five, strictly increasing quantity. */
export const tiersSchema = z.array(tierSchema).max(MAX_BULK_TIERS).refine(isStrictlyIncreasing);

/** The knowledge document form. Strict: a store id (or anything else) in the body is rejected. */
export const knowledgeSchema = z
  .object({
    content: z
      .string()
      .max(MAX_KNOWLEDGE_LENGTH * RAW_FIELD_FACTOR)
      .transform(normalizeParagraph)
      .refine((value) => codePointLength(value) <= MAX_KNOWLEDGE_LENGTH),
  })
  .strict();

const ROW_FIELDS = TIER_ROWS.flatMap((row) => [`minQty${row}`, `percentOff${row}`]);
const rulesFormSchema = z.object(Object.fromEntries(ROW_FIELDS.map((field) => [field, z.string().max(MAX_FORM_NUMBER_LENGTH).optional()]))).strict();

/**
 * Turns the owner's tier form (minQty1..5, percentOff1..5; a row with both boxes empty is skipped) into confirmed tiers.
 * Unknown keys are rejected. Throws ZodError for any value outside the limits.
 * @param {unknown} body
 * @returns {{ minQty: number, percentOff: number }[]}
 */
export function parseRulesForm(body) {
  const form = rulesFormSchema.parse(body ?? {});
  const rows = TIER_ROWS.map((row) => ({ min: (form[`minQty${row}`] ?? '').trim(), percent: (form[`percentOff${row}`] ?? '').trim() }));
  const filled = rows.filter((row) => row.min !== '' || row.percent !== '');
  return tiersSchema.parse(filled.map((row) => ({ minQty: Number(row.min || Number.NaN), percentOff: Number(row.percent || Number.NaN) })));
}

/** @param {{ minQty: number, percentOff: number }[]} tiers @returns {Record<string, string>} Form values for the tier editor. */
export function rulesFormValues(tiers) {
  return Object.fromEntries(tiers.flatMap((tier, index) => [[`minQty${index + 1}`, String(tier.minQty)], [`percentOff${index + 1}`, String(tier.percentOff)]]));
}

/** @returns {number[]} The row numbers the tier editor always shows. */
export const tierRowNumbers = () => [...TIER_ROWS];

/** @returns {{ minQty: number, percentOff: number } | null} The highest tier whose minimum the quantity reaches. */
export function bestTier(tiers, quantity) {
  return tiers.filter((tier) => tier.minQty <= quantity).at(-1) ?? null;
}

/** @returns {{ minQty: number, percentOff: number } | null} The first tier above the quantity (what buying more would unlock). */
export function nextTier(tiers, quantity) {
  return tiers.find((tier) => tier.minQty > quantity) ?? null;
}

/**
 * Integer-paise quote. Only the CONFIRMED tiers apply; the discount is rounded DOWN to whole paise.
 * @param {{ unitPricePaise: number, quantity: number, tiers: { minQty: number, percentOff: number }[], stock: number | null }} input
 * @returns {{ unitPricePaise: number, quantity: number, subtotalPaise: number, discountPercent: number, discountPaise: number,
 *   totalPaise: number, stockCovers: boolean, nextTier: object | null }}
 */
export function calculateQuote({ unitPricePaise, quantity, tiers, stock }) {
  if (!Number.isSafeInteger(unitPricePaise) || unitPricePaise < 0) throw new RangeError('unitPricePaise must be a non-negative integer');
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_TIER_QUANTITY) throw new RangeError('quantity out of range');
  const subtotalPaise = unitPricePaise * quantity;
  const tier = bestTier(tiers, quantity);
  const discountPercent = tier?.percentOff ?? 0;
  const scaled = subtotalPaise * discountPercent;
  const discountPaise = (scaled - (scaled % PERCENT_DIVISOR)) / PERCENT_DIVISOR;
  return {
    unitPricePaise,
    quantity,
    subtotalPaise,
    discountPercent,
    discountPaise,
    totalPaise: subtotalPaise - discountPaise,
    stockCovers: stock === null || stock >= quantity,
    nextTier: nextTier(tiers, quantity),
  };
}
