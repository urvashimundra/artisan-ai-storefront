import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import { MAX_CUSTOMER_NAME_LENGTH } from './orderRules.js';
import { personNameField } from './personName.js';
import { cleanLine, codePointLength, normalizeParagraph } from './productRules.js';
import { normalizeWhatsappNumber } from './whatsapp.js';

/** Limits. Mirrored in db/migrations/013_conversations.sql (a unit test compares them). Counted in code points. */
export const CUSTOMER_DAILY_QUESTION_LIMIT = 6;
export const STORE_DAILY_AI_ANSWER_LIMIT = 200;
export const MAX_CONVERSATION_MESSAGES = 200;
export const SELLER_MESSAGE_HEADROOM = 10;
export const MAX_CONTEXT_MESSAGES = 8;
export const MAX_MESSAGE_LENGTH = 500;
export const MAX_SELLER_MESSAGE_LENGTH = 1000;
export const MAX_ASSISTANT_MESSAGE_LENGTH = 3000;
export const MAX_NAME_LENGTH = MAX_CUSTOMER_NAME_LENGTH;
export const MAX_PREVIEW_LENGTH = 160;
export const RETENTION_MONTHS = 12;
/** A run still in flight after this long is treated as failed (the agent's own wall clock is 40 s). */
export const STALE_RUN_MS = 120_000;
/** How often the page asks for new messages while the customer waits for the assistant. */
export const POLL_INTERVAL_MS = 3000;
export const MAX_LISTED_CONVERSATIONS = 100;

const RAW_FIELD_FACTOR = 4;
const MAX_PHONE_INPUT_LENGTH = 40;
const MAX_PRODUCT_ID_INPUT_LENGTH = 40;
const MAX_TRAP_LENGTH = 200;
const HTTP = Object.freeze({ BAD_REQUEST: 400, NOT_FOUND: 404, CONFLICT: 409, TOO_MANY: 429, UNAVAILABLE: 503 });

export const CONVERSATION_STATUS = Object.freeze({ OPEN: 'open', NEEDS_YOU: 'needs_you', HANDLED: 'handled' });
export const CONVERSATION_STATUSES = Object.freeze(Object.values(CONVERSATION_STATUS));
export const MESSAGE_ROLES = Object.freeze(['customer', 'assistant', 'seller']);
export const MESSAGE_KINDS = Object.freeze(['text', 'escalation', 'notice', 'conflict']);
export const INBOX_FILTERS = Object.freeze(['needs_you', 'unanswered', 'handled']);

/** Why a conversation went to the seller. Mirrors conversations_flag_reason_check. */
export const FLAG_REASONS = Object.freeze([
  'not_in_document', 'source_conflict', 'budget', 'store_limit', 'provider_limit', 'provider_error', 'timeout', 'network',
  'invalid_output', 'refused', 'too_complex', 'unverified_amount', 'knowledge_too_long', 'unavailable',
]);

/**
 * How each flag reason is told to the customer and recorded. `kind` is the stored message kind; `result` is what finish_run is told
 * ('escalated': the assistant could not answer from its sources; 'failed': the assistant itself was unavailable). Both reach the seller.
 */
export const REASON_OUTCOMES = Object.freeze({
  not_in_document: { kind: 'escalation', result: 'escalated' },
  source_conflict: { kind: 'conflict', result: 'escalated' },
  store_limit: { kind: 'escalation', result: 'escalated' },
  unverified_amount: { kind: 'escalation', result: 'escalated' },
  too_complex: { kind: 'escalation', result: 'escalated' },
  knowledge_too_long: { kind: 'escalation', result: 'escalated' },
  budget: { kind: 'notice', result: 'failed' },
  provider_limit: { kind: 'notice', result: 'failed' },
  provider_error: { kind: 'notice', result: 'failed' },
  timeout: { kind: 'notice', result: 'failed' },
  network: { kind: 'notice', result: 'failed' },
  invalid_output: { kind: 'notice', result: 'failed' },
  refused: { kind: 'escalation', result: 'escalated' },
  unavailable: { kind: 'notice', result: 'failed' },
});

/**
 * Every distinct customer-facing outcome. `saved` says whether the customer's message was persisted: only persistence failures, rejected
 * input and refused posts (busy, full, customer limit) are NOT saved, and the page must never say "sent" for those.
 */
export const OUTCOMES = Object.freeze({
  rejected: { saved: false, status: HTTP.BAD_REQUEST },
  saved: { saved: true, status: 200 },
  answered: { saved: true, status: 200 },
  seller: { saved: true, status: 200 },
  ai_unavailable: { saved: true, status: 200 },
  persistence_failed: { saved: false, status: HTTP.UNAVAILABLE },
  customer_limit: { saved: false, status: HTTP.TOO_MANY },
  store_limit: { saved: true, status: 200 },
  budget: { saved: true, status: 200 },
  provider_limit: { saved: true, status: 200 },
  timeout: { saved: true, status: 200 },
  network: { saved: true, status: 200 },
  busy: { saved: false, status: HTTP.CONFLICT },
  conversation_full: { saved: false, status: HTTP.CONFLICT },
});

const withinLength = (max) => (value) => value.length > 0 && codePointLength(value) <= max;
const line = (max) => z.string().max(max * RAW_FIELD_FACTOR).transform(cleanLine).refine(withinLength(max));
const paragraph = (max) => z.string().max(max * RAW_FIELD_FACTOR).transform(normalizeParagraph).refine(withinLength(max));
const messageText = paragraph(MAX_MESSAGE_LENGTH);

/** Starting a conversation. Strict. `startKey` and `messageId` are the idempotency keys; `website` is the hidden trap field. */
export const startSchema = z
  .object({
    name: personNameField(MAX_NAME_LENGTH),
    phone: z.string().max(MAX_PHONE_INPUT_LENGTH).transform(normalizeWhatsappNumber).refine((value) => value !== null),
    message: messageText,
    startKey: z.uuid(),
    messageId: z.uuid(),
    productId: z.string().max(MAX_PRODUCT_ID_INPUT_LENGTH).optional(),
    website: z.string().max(MAX_TRAP_LENGTH).optional(),
  })
  .strict();

/** A follow-up message. Strict. The conversation comes from the private link, never from the body. */
export const messageSchema = z.object({ message: messageText, messageId: z.uuid() }).strict();

/** The seller's reply. Strict. */
export const sellerReplySchema = z.object({ reply: paragraph(MAX_SELLER_MESSAGE_LENGTH), messageId: z.uuid() }).strict();

/** @param {unknown} status @returns {string | null} The filter when valid, otherwise null. */
export const inboxFilter = (status) => (INBOX_FILTERS.includes(status) ? status : null);

/** @param {{ aiRunStartedAt: string | null }} conversation @param {number} nowMs @returns {boolean} True when a run has been in flight too long. */
export function isStaleRun(conversation, nowMs) {
  return conversation.aiRunStartedAt !== null && nowMs - Date.parse(conversation.aiRunStartedAt) > STALE_RUN_MS;
}

/** @param {{ aiRunStartedAt: string | null }} conversation @returns {boolean} True while the assistant is working. */
export const isAiRunning = (conversation) => conversation.aiRunStartedAt !== null;

/** @param {{ status: string, lastMessageRole: string | null }} conversation @returns {boolean} A customer message nobody has answered yet. */
export const isUnanswered = (conversation) => conversation.lastMessageRole === 'customer';

/**
 * Maps a database refusal reason to the error the customer sees. Nothing here is "saved": the message was not stored.
 * @param {string} reason
 * @returns {AppError}
 */
export function refusalError(reason) {
  const table = {
    not_found: ['CONVERSATION_NOT_FOUND', HTTP.NOT_FOUND, 'Not found'],
    busy: ['CONVERSATION_BUSY', HTTP.CONFLICT, 'The assistant is still answering'],
    conversation_full: ['CONVERSATION_FULL', HTTP.CONFLICT, 'This conversation is full'],
    customer_limit: ['CUSTOMER_LIMIT', HTTP.TOO_MANY, 'Too many questions today'],
  };
  const [code, status, message] = table[reason] ?? ['CONVERSATION_FAILED', HTTP.UNAVAILABLE, 'Something went wrong'];
  return new AppError(code, status, message);
}

/** The error for a message that could not be stored at all (database down). The page must say it was NOT sent. */
export const persistenceError = () => new AppError('PERSISTENCE_FAILED', HTTP.UNAVAILABLE, 'Your message was not saved');
