import { estimateMaxCostMicroUsd } from '../domain/aiCost.js';
import { codePointLength } from '../domain/productRules.js';

/** Hard cap on output tokens for one listing call. Three languages with Indic scripts are token-hungry. */
export const LISTING_MAX_OUTPUT_TOKENS = 3_500;

/**
 * Tokens reserved for the photo. The browser now resizes to 1200 px on the longest side, but photos uploaded earlier are
 * up to 1568 px, which the API prices at roughly width x height / 750 (about 3,300 tokens for a 1568 px square, the worst
 * case). Rounded up, so this allowance is unchanged.
 */
export const IMAGE_TOKEN_ALLOWANCE = 4_000;

/** Tokens reserved for the system prompt, the tool definition and message framing. Rounded up from measurement. */
export const PROMPT_TOKEN_ALLOWANCE = 1_500;

/**
 * Tokens per story character. Indic scripts tokenise at about one token per character and sometimes more, so
 * this is deliberately applied to every character regardless of script. It over-reserves for English; the unused
 * part is returned when the call settles on actual usage.
 */
export const INDIC_TOKENS_PER_CHARACTER = 2;

/**
 * Conservative input-token estimate for one listing request.
 * @param {string} story Normalized story text.
 * @returns {number}
 */
export function estimateListingInputTokens(story) {
  return IMAGE_TOKEN_ALLOWANCE + PROMPT_TOKEN_ALLOWANCE + codePointLength(story) * INDIC_TOKENS_PER_CHARACTER;
}

/**
 * Micro-USD to reserve before a listing call: worst case (estimated input, full output cap) with the
 * safety margin from aiCost.
 * @param {string} story Normalized story text.
 * @returns {number}
 */
export function estimateListingReservationMicroUsd(story) {
  return estimateMaxCostMicroUsd({
    inputTokens: estimateListingInputTokens(story),
    maxOutputTokens: LISTING_MAX_OUTPUT_TOKENS,
  });
}
