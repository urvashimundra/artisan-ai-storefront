import { AppError } from '../lib/errors.js';

/** Stored form: digits only, country code included. Mirrored in stores_whatsapp_number_format_check. */
export const WHATSAPP_PATTERN = /^[0-9]{10,15}$/;
const INDIA_COUNTRY_CODE = '91';
const LOCAL_NUMBER_LENGTH = 10;
const MAX_RAW_LENGTH = 30;
const SEPARATORS = /[\s\-().]/g;
const RAW_PATTERN = /^\+?\d+$/;
const HTTP_BAD_REQUEST = 400;

/**
 * Normalises a phone number typed by the owner. `98765 43210` and `+91 98765 43210` both become `919876543210`.
 * Ten digits get the India prefix; anything else is taken as already including a country code.
 * @param {unknown} input
 * @returns {string | null} 10 to 15 digits, or null if the input is not a usable number.
 */
export function normalizeWhatsappNumber(input) {
  if (typeof input !== 'string' || input.length > MAX_RAW_LENGTH) return null;
  const compact = input.replace(SEPARATORS, '');
  if (!RAW_PATTERN.test(compact)) return null;
  const hasPlus = compact.startsWith('+');
  const digits = hasPlus ? compact.slice(1) : compact;
  const full = !hasPlus && digits.length === LOCAL_NUMBER_LENGTH ? `${INDIA_COUNTRY_CODE}${digits}` : digits;
  return WHATSAPP_PATTERN.test(full) ? full : null;
}

/**
 * Builds the click-to-chat link. The number appears only here, as the link destination.
 * @param {string} number Stored digits.
 * @param {string} message Plain text; percent-encoded here (Gujarati, Hindi, &, #, spaces are safe).
 * @returns {string}
 * @throws {AppError} INVALID_WHATSAPP_NUMBER when the number is not stored-form digits.
 */
export function buildWhatsappLink(number, message) {
  if (typeof number !== 'string' || !WHATSAPP_PATTERN.test(number)) {
    throw new AppError('INVALID_WHATSAPP_NUMBER', HTTP_BAD_REQUEST, 'Invalid WhatsApp number');
  }
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}
