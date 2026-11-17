import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import { MAX_CUSTOMER_NAME_LENGTH } from './orderRules.js';
import { cleanLine, codePointLength, normalizeParagraph } from './productRules.js';
import { normalizeWhatsappNumber } from './whatsapp.js';

/** Limits. Mirrored in db/migrations/012_assistant.sql (a unit test compares them). Counted in code points. */
export const MAX_QUESTION_LENGTH = 500;
export const MAX_REPLY_LENGTH = 1000;
export const MAX_ANSWER_LENGTH = 3000;
export const MAX_TRACE_ITEMS = 12;
export const MAX_TRACE_ITEM_LENGTH = 160;
export const MAX_ENQUIRY_NAME_LENGTH = MAX_CUSTOMER_NAME_LENGTH;
/** Enquiries one phone number may send to one shop per rolling day (counted from the enquiries table, that shop only). */
export const PHONE_DAILY_LIMIT = 5;
/** Enquiries per shop per India day that the assistant may answer; beyond it the enquiry goes straight to the seller. */
export const STORE_AI_DAILY_CAP = 30;
/** An answering enquiry older than this is treated as needing the seller. */
export const STUCK_AFTER_MS = 120_000;
/** Wall-clock limit for the whole assistant run, kept well under the 60 s platform limit. */
export const AGENT_WALL_CLOCK_MS = 40_000;
export const MAX_MODEL_CALLS = 6;
const RAW_FIELD_FACTOR = 4;
const MAX_PHONE_INPUT_LENGTH = 40;
const MAX_PRODUCT_ID_INPUT_LENGTH = 40;
const MAX_TRAP_LENGTH = 200;
const HTTP_TOO_MANY_REQUESTS = 429;
const MS_PER_DAY = 86_400_000;
const INDIA_OFFSET_MS = 19_800_000;

export const ENQUIRY_STATUS = Object.freeze({ PENDING: 'pending', ANSWERING: 'answering', ANSWERED: 'answered', NEEDS_YOU: 'needs_you', HANDLED: 'handled' });
export const ENQUIRY_STATUSES = Object.freeze(Object.values(ENQUIRY_STATUS));
export const FLAG_REASONS = Object.freeze(['not_in_document', 'budget', 'error', 'too_complex', 'unverified_amount', 'daily_cap']);
/** Statuses the seller can filter by. */
export const INBOX_FILTERS = Object.freeze([ENQUIRY_STATUS.NEEDS_YOU, ENQUIRY_STATUS.ANSWERED, ENQUIRY_STATUS.HANDLED]);

const withinLength = (max) => (value) => value.length > 0 && codePointLength(value) <= max;
const line = (max) => z.string().max(max * RAW_FIELD_FACTOR).transform(cleanLine).refine(withinLength(max));
const paragraph = (max) => z.string().max(max * RAW_FIELD_FACTOR).transform(normalizeParagraph).refine(withinLength(max));

/** The customer's ask form. Strict. `website` is the hidden trap field: a person leaves it empty. The shop comes from the URL. */
export const askSchema = z
  .object({
    name: line(MAX_ENQUIRY_NAME_LENGTH),
    phone: z.string().max(MAX_PHONE_INPUT_LENGTH).transform(normalizeWhatsappNumber).refine((value) => value !== null),
    question: paragraph(MAX_QUESTION_LENGTH),
    productId: z.string().max(MAX_PRODUCT_ID_INPUT_LENGTH).optional(),
    website: z.string().max(MAX_TRAP_LENGTH).optional(),
  })
  .strict();

/** The seller's reply form. Strict. */
export const replySchema = z.object({ reply: paragraph(MAX_REPLY_LENGTH) }).strict();

/** @param {number} nowMs @returns {number} Epoch ms of the start of the current India day (UTC+5:30, no daylight saving). */
export function indiaDayStartMs(nowMs) {
  return Math.floor((nowMs + INDIA_OFFSET_MS) / MS_PER_DAY) * MS_PER_DAY - INDIA_OFFSET_MS;
}

/** @param {number} nowMs @returns {number} Epoch ms one day earlier. */
export const dayAgoMs = (nowMs) => nowMs - MS_PER_DAY;

/** @param {{ status: string, claimedAt: string | null }} enquiry @param {number} nowMs @returns {boolean} */
export function isStuck(enquiry, nowMs) {
  return enquiry.status === ENQUIRY_STATUS.ANSWERING && enquiry.claimedAt !== null && nowMs - Date.parse(enquiry.claimedAt) > STUCK_AFTER_MS;
}

/** @param {unknown} status @returns {string | null} The status when it is a valid inbox filter, otherwise null. */
export const inboxFilter = (status) => (INBOX_FILTERS.includes(status) ? status : null);

/** The error for a phone number that reached its daily limit at this shop. */
export const enquiryLimitError = () => new AppError('ENQUIRY_LIMIT', HTTP_TOO_MANY_REQUESTS, 'Too many questions today');
