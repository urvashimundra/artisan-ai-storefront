// Pure AI cost arithmetic. Money unit: integer micro-USD (1 USD = 1,000,000). BigInt internally, no floats.

// Source: Anthropic claude-haiku-5-5 pricing page, verified 15 Nov 2026 (matched by independent trackers).
// RE-VERIFY BEFORE THE DEMO. Rates are micro-USD per million tokens.
const MICRO_USD_PER_USD = 1_000_000n;
const TOKENS_PER_MILLION = 1_000_000n;
const LONG_PROMPT_THRESHOLD_TOKENS = 100_000;
const STANDARD_RATES = { inputPerMillion: 100_000n, outputPerMillion: 500_000n };
const LONG_PROMPT_RATES = { inputPerMillion: 500_000n, outputPerMillion: 2_500_000n };
const ESTIMATE_SAFETY_PERCENT = 130n;
const PERCENT_DIVISOR = 100n;
const MAX_USD_DECIMALS = 6;
const USD_PATTERN = new RegExp(`^(\\d+)(?:\\.(\\d{1,${MAX_USD_DECIMALS}}))?$`);

function assertTokenCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
}

function ceilDiv(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}

function ratesFor(inputTokens) {
  return inputTokens > LONG_PROMPT_THRESHOLD_TOKENS ? LONG_PROMPT_RATES : STANDARD_RATES;
}

function costBigInt(inputTokens, outputTokens) {
  assertTokenCount(inputTokens, 'inputTokens');
  assertTokenCount(outputTokens, 'outputTokens');
  const rates = ratesFor(inputTokens);
  const input = ceilDiv(BigInt(inputTokens) * rates.inputPerMillion, TOKENS_PER_MILLION);
  const output = ceilDiv(BigInt(outputTokens) * rates.outputPerMillion, TOKENS_PER_MILLION);
  return input + output;
}

function toSafeNumber(value) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Amount exceeds the safe integer range');
  return Number(value);
}

/**
 * Actual cost of a finished call, from the API response `usage` token counts. Rounds up per side.
 * The tier is chosen by input tokens: above the threshold the whole request uses the long-prompt rates.
 * @param {{ inputTokens: number, outputTokens: number }} usage
 * @returns {number} Integer micro-USD.
 */
export function actualCostMicroUsd({ inputTokens, outputTokens }) {
  return toSafeNumber(costBigInt(inputTokens, outputTokens));
}

/**
 * Worst-case cost to reserve before a call: the same formula using maxOutputTokens, times a 130% safety margin
 * (integer math, rounded up). The caller supplies the input token estimate.
 * @param {{ inputTokens: number, maxOutputTokens: number }} request
 * @returns {number} Integer micro-USD.
 */
export function estimateMaxCostMicroUsd({ inputTokens, maxOutputTokens }) {
  const base = costBigInt(inputTokens, maxOutputTokens);
  return toSafeNumber(ceilDiv(base * ESTIMATE_SAFETY_PERCENT, PERCENT_DIVISOR));
}

/**
 * Parses a decimal USD string ("1", "1.5", "0.000001") to integer micro-USD by string handling.
 * @param {string} text At most 6 decimals; no sign, exponent or whitespace.
 * @returns {number} Integer micro-USD.
 * @throws {RangeError} For anything else.
 */
export function parseUsdToMicroUsd(text) {
  const match = typeof text === 'string' ? USD_PATTERN.exec(text) : null;
  if (!match) throw new RangeError('Invalid USD amount');
  const fraction = (match[2] ?? '').padEnd(MAX_USD_DECIMALS, '0');
  return toSafeNumber(BigInt(match[1]) * MICRO_USD_PER_USD + BigInt(fraction));
}
