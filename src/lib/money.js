import { AppError } from './errors.js';

const PAISE_PER_RUPEE = 100n;
const FRACTION_DIGITS = 2;
const RUPEE_PATTERN = /^(\d+)(?:\.(\d{1,2}))?$/;
const INR_SYMBOL = '₹';
const ZERO_FRACTION = '00';
const FIRST_GROUP_SIZE = 3;
const HTTP_BAD_REQUEST = 400;
const INDIAN_PAIR_GROUPS = /\B(?=(\d{2})+$)/g;

const invalidAmount = () => new AppError('INVALID_AMOUNT', HTTP_BAD_REQUEST, 'Invalid amount');

function normalizeInput(rupees) {
  if (typeof rupees === 'number') {
    if (!Number.isFinite(rupees)) throw invalidAmount();
    return String(rupees);
  }
  if (typeof rupees === 'string') return rupees.trim();
  throw invalidAmount();
}

/**
 * Converts a rupee amount to integer paise using decimal-string parsing (no float arithmetic).
 * @param {number|string} rupees Non-negative amount with at most 2 decimals.
 * @returns {number} Safe integer paise.
 * @throws {AppError} INVALID_AMOUNT for NaN, Infinity, negatives, >2 decimals or unsafe results.
 */
export function toPaise(rupees) {
  const match = RUPEE_PATTERN.exec(normalizeInput(rupees));
  if (!match) throw invalidAmount();
  const fraction = (match[2] ?? '').padEnd(FRACTION_DIGITS, '0');
  const paise = BigInt(match[1]) * PAISE_PER_RUPEE + BigInt(fraction);
  if (paise > BigInt(Number.MAX_SAFE_INTEGER)) throw invalidAmount();
  return Number(paise);
}

function groupIndian(rupeeDigits) {
  if (rupeeDigits.length <= FIRST_GROUP_SIZE) return rupeeDigits;
  const head = rupeeDigits.slice(0, -FIRST_GROUP_SIZE).replace(INDIAN_PAIR_GROUPS, ',');
  return `${head},${rupeeDigits.slice(-FIRST_GROUP_SIZE)}`;
}

/**
 * Formats integer paise as an INR string with Indian digit grouping, e.g. ₹1,23,456.78.
 * @param {number} paise Non-negative safe integer.
 * @param {{ omitZeroFraction?: boolean }} [options] omitZeroFraction drops ".00" for whole rupees (₹1,25,000).
 * @returns {string}
 * @throws {AppError} INVALID_AMOUNT if not a non-negative safe integer.
 */
export function formatInr(paise, { omitZeroFraction = false } = {}) {
  if (!Number.isSafeInteger(paise) || paise < 0) throw invalidAmount();
  const digits = String(paise).padStart(FRACTION_DIGITS + 1, '0');
  const rupees = digits.slice(0, -FRACTION_DIGITS);
  const fraction = digits.slice(-FRACTION_DIGITS);
  const grouped = `${INR_SYMBOL}${groupIndian(rupees)}`;
  return omitZeroFraction && fraction === ZERO_FRACTION ? grouped : `${grouped}.${fraction}`;
}
