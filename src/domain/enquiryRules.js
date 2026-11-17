import { z } from 'zod';
import { MAX_CUSTOMER_NAME_LENGTH } from './orderRules.js';
import { codePointLength, normalizeParagraph } from './productRules.js';

/** Limits. Mirrored in db/migrations/012_assistant.sql (a unit test compares them). Counted in code points. */
export const MAX_QUESTION_LENGTH = 500;
export const MAX_REPLY_LENGTH = 1000;
export const MAX_ANSWER_LENGTH = 3000;
export const MAX_TRACE_ITEMS = 12;
export const MAX_TRACE_ITEM_LENGTH = 160;
/** Server label of the trace entry that carries the assistant's note about an incidental source conflict. Shown in the seller inbox only. */
export const SELLER_NOTICE_PREFIX = 'Assistant note for you: ';
export const MAX_ENQUIRY_NAME_LENGTH = MAX_CUSTOMER_NAME_LENGTH;
/** An answering enquiry older than this is treated as needing the seller. */
export const STUCK_AFTER_MS = 120_000;
/** Wall-clock limit for the whole assistant run, kept well under the 60 s platform limit. */
export const AGENT_WALL_CLOCK_MS = 40_000;
export const MAX_MODEL_CALLS = 6;
const RAW_FIELD_FACTOR = 4;

export const ENQUIRY_STATUS = Object.freeze({ PENDING: 'pending', ANSWERING: 'answering', ANSWERED: 'answered', NEEDS_YOU: 'needs_you', HANDLED: 'handled' });
export const ENQUIRY_STATUSES = Object.freeze(Object.values(ENQUIRY_STATUS));
export const FLAG_REASONS = Object.freeze(['not_in_document', 'budget', 'error', 'too_complex', 'unverified_amount', 'daily_cap']);
/** Statuses the seller can filter by. */
export const INBOX_FILTERS = Object.freeze([ENQUIRY_STATUS.NEEDS_YOU, ENQUIRY_STATUS.ANSWERED, ENQUIRY_STATUS.HANDLED]);

const withinLength = (max) => (value) => value.length > 0 && codePointLength(value) <= max;
const paragraph = (max) => z.string().max(max * RAW_FIELD_FACTOR).transform(normalizeParagraph).refine(withinLength(max));

/** The seller's reply form. Strict. */
export const replySchema = z.object({ reply: paragraph(MAX_REPLY_LENGTH) }).strict();

/** @param {{ status: string, claimedAt: string | null }} enquiry @param {number} nowMs @returns {boolean} */
export function isStuck(enquiry, nowMs) {
  return enquiry.status === ENQUIRY_STATUS.ANSWERING && enquiry.claimedAt !== null && nowMs - Date.parse(enquiry.claimedAt) > STUCK_AFTER_MS;
}

/** @param {unknown} status @returns {string | null} The status when it is a valid inbox filter, otherwise null. */
export const inboxFilter = (status) => (INBOX_FILTERS.includes(status) ? status : null);

