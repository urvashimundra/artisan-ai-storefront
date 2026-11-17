import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import { EMAIL_KIND_VALUES, EMAIL_STATUSES } from '../domain/emailRules.js';
import { throwIfError } from './pgErrors.js';

const HTTP_INTERNAL_ERROR = 500;
const ENQUEUE_RESULTS = Object.freeze(['queued', 'duplicate', 'limited_global', 'limited_recipient']);
const FINISH_RESULTS = Object.freeze([EMAIL_STATUSES.SENT, EMAIL_STATUSES.QUEUED, EMAIL_STATUSES.DEAD]);

const language = z.enum(['en', 'gu', 'hi']);
const claimedRow = z.object({
  id: z.uuid(),
  store_id: z.uuid().nullable(),
  kind: z.enum(EMAIL_KIND_VALUES),
  to_email: z.string(),
  language,
  subject: z.string(),
  body: z.string(),
  payload: z.record(z.string(), z.unknown()),
  reply_to: z.string().nullable(),
  attempts: z.number().int(),
});

function unexpected(operation) {
  return new AppError('DATABASE_ERROR', HTTP_INTERNAL_ERROR, 'Something went wrong', { operation, reason: 'unexpected_result_shape' });
}

function parse(schema, value, operation) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw unexpected(operation);
  return parsed.data;
}

const toClaimed = (row) => ({
  id: row.id,
  storeId: row.store_id,
  kind: row.kind,
  toEmail: row.to_email,
  language: row.language,
  subject: row.subject,
  body: row.body,
  payload: row.payload,
  replyTo: row.reply_to,
  attempts: row.attempts,
});

/**
 * The email outbox. SYSTEM-LEVEL by design (allowlisted by name in the tenancy scan): rows are claimed by the background
 * worker across all stores, so there is no store scope to apply. Every write goes through a Postgres function (migration 010):
 * email_enqueue applies the abuse limits, claim_due_emails and finish_email are atomic. Retention is one fixed DELETE.
 * @param {{ client: any }} deps
 */
export function createEmailOutboxRepository({ client }) {
  async function callRpc(operation, args) {
    const { data, error } = await client.rpc(operation, args);
    throwIfError(error);
    return data;
  }

  return {
    /**
     * Queues one email through email_enqueue (limits and dedupe inside the database).
     * @param {{ storeId: string | null, kind: string, toEmail: string, language: string, subject: string, body: string,
     *   payload?: object, replyTo?: string | null, dedupeKey: string }} email
     * @returns {Promise<'queued' | 'duplicate' | 'limited_global' | 'limited_recipient'>}
     */
    async enqueue(email) {
      const data = await callRpc('email_enqueue', {
        p_store_id: email.storeId,
        p_kind: email.kind,
        p_to_email: email.toEmail,
        p_language: email.language,
        p_subject: email.subject,
        p_body: email.body,
        p_payload: email.payload ?? {},
        p_reply_to: email.replyTo ?? null,
        p_dedupe_key: email.dedupeKey,
      });
      return parse(z.enum(ENQUEUE_RESULTS), data, 'email_enqueue');
    },

    /** Atomically claims due rows (each gets a lease). @returns {Promise<object[]>} */
    async claimDue(limit, leaseSeconds) {
      const data = await callRpc('claim_due_emails', { p_limit: limit, p_lease_seconds: leaseSeconds });
      return parse(z.array(claimedRow), data ?? [], 'claim_due_emails').map(toClaimed);
    },

    /**
     * Records the result of one send.
     * @param {string} id
     * @param {{ sent: boolean, errorCode?: string | null, retrySeconds?: number | null }} result retrySeconds null means dead at once.
     * @returns {Promise<'sent' | 'queued' | 'dead' | null>} null when the row was not in the sending state.
     */
    async finish(id, { sent, errorCode = null, retrySeconds = null }) {
      const data = await callRpc('finish_email', { p_id: id, p_sent: sent, p_error_code: errorCode, p_retry_seconds: retrySeconds });
      return parse(z.enum(FINISH_RESULTS).nullable(), data ?? null, 'finish_email');
    },

    /** Retention: ONE delete of sent and dead rows created before the cutoff. @param {string} cutoffIso @returns {Promise<number>} */
    async deleteFinishedBefore(cutoffIso) {
      const { count, error } = await client
        .from('email_outbox')
        .delete({ count: 'exact' })
        .in('status', [EMAIL_STATUSES.SENT, EMAIL_STATUSES.DEAD])
        .lt('created_at', cutoffIso);
      throwIfError(error);
      return count ?? 0;
    },
  };
}
