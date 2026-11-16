import { AppError } from '../lib/errors.js';
import { UPI_PATTERN } from './shopFields.js';

const PAISE_PER_RUPEE = 100;
const PAISE_DIGITS = 2;
const HTTP_BAD_REQUEST = 400;
const CURRENCY = 'INR';
const MAX_NAME_LENGTH = 80;
const MAX_NOTE_LENGTH = 40;

/** @param {unknown} value @returns {boolean} True for a stored-form UPI ID (the same pattern as stores_upi_id_format_check). */
export const isValidVpa = (value) => typeof value === 'string' && value.length <= 100 && UPI_PATTERN.test(value);

/**
 * Integer paise to a UPI amount string with exactly two decimals ("0.05", "100.00", "1234567.89"). Integer math only.
 * @param {number} paise Positive safe integer.
 * @returns {string}
 */
export function upiAmount(paise) {
  if (!Number.isSafeInteger(paise) || paise <= 0) throw new AppError('INVALID_AMOUNT', HTTP_BAD_REQUEST, 'Invalid amount');
  const rupees = Math.floor(paise / PAISE_PER_RUPEE);
  const remainder = paise % PAISE_PER_RUPEE;
  return `${rupees}.${String(remainder).padStart(PAISE_DIGITS, '0')}`;
}

/**
 * Builds the `upi://pay` link used by both the "Pay with UPI" button and the QR code (one string, two uses).
 * Params: pa (payee VPA), pn (payee name), am (amount), cu=INR, tn (note: the order reference ONLY, no personal data).
 * `tr` (transaction reference) is omitted on purpose: personal VPAs can trigger app warnings when `tr` is present, and the
 * note is enough for the owner to reconcile by hand. Every value goes through encodeURIComponent.
 * @param {{ vpa: string, name: string, amountPaise: number, orderRef: string }} input
 * @returns {string}
 * @throws {AppError} INVALID_UPI when the VPA, name or reference is unusable.
 */
export function buildUpiUri({ vpa, name, amountPaise, orderRef }) {
  const usable = isValidVpa(vpa) && typeof name === 'string' && name.length > 0 && name.length <= MAX_NAME_LENGTH
    && typeof orderRef === 'string' && orderRef.length > 0 && orderRef.length <= MAX_NOTE_LENGTH;
  if (!usable) throw new AppError('INVALID_UPI', HTTP_BAD_REQUEST, 'Invalid payment details');
  const params = [['pa', vpa], ['pn', name], ['am', upiAmount(amountPaise)], ['cu', CURRENCY], ['tn', orderRef]];
  return `upi://pay?${params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`;
}
