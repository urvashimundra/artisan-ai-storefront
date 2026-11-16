import { estimateMaxCostMicroUsd } from '../domain/aiCost.js';
import { codePointLength } from '../domain/productRules.js';
import { INDIC_TOKENS_PER_CHARACTER } from './listingCost.js';

/**
 * Hard cap on output tokens for one translation call: two languages, each up to 2,000 + 120 characters, Indic scripts
 * being token-hungry. Longer output is truncated and treated as invalid output.
 */
export const TRANSLATION_MAX_OUTPUT_TOKENS = 6_000;

/** Tokens reserved for the system prompt, the tool definition and message framing. */
export const TRANSLATION_PROMPT_TOKEN_ALLOWANCE = 1_000;

/**
 * Micro-USD to reserve before a translation call: worst case (estimated input, full output cap) with the safety margin
 * from aiCost.
 * @param {{ tagline: string, story: string }} source
 * @returns {number}
 */
export function estimateTranslationReservationMicroUsd({ tagline, story }) {
  const characters = codePointLength(tagline) + codePointLength(story);
  return estimateMaxCostMicroUsd({
    inputTokens: TRANSLATION_PROMPT_TOKEN_ALLOWANCE + characters * INDIC_TOKENS_PER_CHARACTER,
    maxOutputTokens: TRANSLATION_MAX_OUTPUT_TOKENS,
  });
}
