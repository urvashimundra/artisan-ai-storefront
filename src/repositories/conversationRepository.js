import { z } from 'zod';
import { CONVERSATION_STATUSES, FLAG_REASONS, MAX_CONTEXT_MESSAGES, MAX_LISTED_CONVERSATIONS, MESSAGE_KINDS, MESSAGE_ROLES } from '../domain/conversationRules.js';
import { AppError } from '../lib/errors.js';
import { throwIfError } from './pgErrors.js';
import { requireStoreId } from './requireStoreId.js';

const HTTP_INTERNAL_ERROR = 500;
/** The most messages one page of a conversation returns (the cap is 210, so this is the whole conversation). */
const MAX_MESSAGES_PER_READ = 210;
/** token_hash is never selected: it is only a lookup key. token_enc is selected only for the seller's detail view and the duplicate-start path. */
const CONVERSATION_COLUMNS = 'id, store_id, product_id, language, customer_name, customer_phone, status, flag_reason, message_count, last_message_role, last_preview, '
  + 'escalation_count, ai_run_id, ai_run_started_at, legacy_enquiry_id, last_activity_at, created_at, updated_at';
const MESSAGE_COLUMNS = 'id, seq, role, kind, body, flag_reason, sources, conflict, created_at';
/** The trace column is read only for the seller's detail view; the customer's reads never select it. */
const OWNER_MESSAGE_COLUMNS = `${MESSAGE_COLUMNS}, trace`;

const conversationRow = z.object({
  id: z.uuid(), store_id: z.uuid(), product_id: z.uuid().nullable(), language: z.enum(['en', 'gu', 'hi']), customer_name: z.string(),
  customer_phone: z.string(), status: z.enum(CONVERSATION_STATUSES), flag_reason: z.enum(FLAG_REASONS).nullable(), message_count: z.number().int(),
  last_message_role: z.enum(MESSAGE_ROLES).nullable(), last_preview: z.string(), escalation_count: z.number().int(), ai_run_id: z.uuid().nullable(),
  ai_run_started_at: z.string().nullable(), legacy_enquiry_id: z.uuid().nullable(), last_activity_at: z.string(), created_at: z.string(),
  updated_at: z.string(), token_enc: z.string().nullable().optional(),
});
const messageRow = z.object({
  id: z.uuid(), seq: z.number().int(), role: z.enum(MESSAGE_ROLES), kind: z.enum(MESSAGE_KINDS), body: z.string(), flag_reason: z.enum(FLAG_REASONS).nullable(),
  sources: z.array(z.object({ label: z.string() }).passthrough()), conflict: z.object({}).passthrough().nullable(), created_at: z.string(), trace: z.array(z.string()).optional(),
});
const startResult = z.object({
  ok: z.boolean(), reason: z.string().optional(), duplicate: z.boolean().optional(), conversation_id: z.uuid().optional(), token_enc: z.string().nullable().optional(),
  message_id: z.uuid().optional(), run_id: z.uuid().nullable().optional(), escalated: z.boolean().optional(), escalation_count: z.number().int().optional(),
});
const finishResult = z.object({ ok: z.boolean(), changed: z.boolean(), became_needs_you: z.boolean().optional(), escalation_count: z.number().int().optional() });
const replyResult = z.object({ ok: z.boolean(), reason: z.string().optional(), duplicate: z.boolean().optional(), message_id: z.uuid().optional() });
const purgeResult = z.object({ conversations: z.number().int(), legacy_enquiries: z.number().int(), usage_rows: z.number().int() });
const contextRow = z.object({ owner_id: z.uuid(), name: z.string(), notify_enquiry_email: z.boolean(), owners: z.object({ is_demo: z.boolean() }) });

function parse(schema, value, operation) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError('DATABASE_ERROR', HTTP_INTERNAL_ERROR, 'Something went wrong', { operation, reason: 'unexpected_result_shape' });
  return parsed.data;
}

const toConversation = (row) => ({
  id: row.id, storeId: row.store_id, productId: row.product_id, language: row.language, customerName: row.customer_name, customerPhone: row.customer_phone,
  status: row.status, flagReason: row.flag_reason, messageCount: row.message_count, lastMessageRole: row.last_message_role, lastPreview: row.last_preview,
  escalationCount: row.escalation_count, aiRunId: row.ai_run_id, aiRunStartedAt: row.ai_run_started_at, legacyEnquiryId: row.legacy_enquiry_id,
  lastActivityAt: row.last_activity_at, createdAt: row.created_at, updatedAt: row.updated_at, tokenEnc: row.token_enc ?? null,
});

const toMessage = (row) => ({
  id: row.id, seq: row.seq, role: row.role, kind: row.kind, body: row.body, flagReason: row.flag_reason, sources: row.sources, conflict: row.conflict, createdAt: row.created_at,
  ...(row.trace ? { trace: row.trace } : {}),
});

/**
 * Conversations and their messages. Every method takes storeId first and scopes by it; the private chat is looked up INSIDE the shop named in
 * its URL. Everything that must be atomic (start, post, finish, reply, delete, purge) is ONE Postgres function from migration 013, so a
 * partial write cannot happen. A database or shape error is thrown as AppError DATABASE_ERROR (never provider text), and the service turns it
 * into "your message was not saved".
 * @param {{ client: any }} deps
 */
export function createConversationRepository({ client }) {
  async function rpc(operation, args, schema) {
    const { data, error } = await client.rpc(operation, args);
    if (error) throw new AppError('DATABASE_ERROR', HTTP_INTERNAL_ERROR, 'Something went wrong', { operation, pgCode: error.code });
    return parse(schema, data, operation);
  }

  const conversations = (storeId, columns = CONVERSATION_COLUMNS) => {
    const scoped = requireStoreId(storeId);
    return client.from('conversations').select(columns).eq('store_id', scoped);
  };

  return {
    /** @returns {Promise<object>} The result of conversation_start (see the migration): ok, reason, duplicate, conversationId, runId, escalated, tokenEnc. */
    async start(storeId, input) {
      const args = {
        p_store_id: requireStoreId(storeId), p_product_id: input.productId, p_language: input.language, p_name: input.name, p_phone: input.phone,
        p_token_hash: input.tokenHash, p_token_enc: input.tokenEnc, p_start_key: input.startKey, p_message_id: input.messageId, p_body: input.body,
        p_limit_notice: input.limitNotice,
      };
      const result = await rpc('conversation_start', args, startResult);
      return {
        ok: result.ok, reason: result.reason ?? null, duplicate: result.duplicate ?? false, conversationId: result.conversation_id ?? null,
        tokenEnc: result.token_enc ?? null, runId: result.run_id ?? null, escalated: result.escalated ?? false, escalationCount: result.escalation_count ?? 0,
      };
    },

    /** @returns {Promise<object>} ok, reason, duplicate, runId, escalated, escalationCount. */
    async postMessage(storeId, conversationId, { messageId, body, limitNotice }) {
      const args = { p_store_id: requireStoreId(storeId), p_conversation_id: conversationId, p_message_id: messageId, p_body: body, p_limit_notice: limitNotice };
      const result = await rpc('conversation_post_message', args, startResult);
      return {
        ok: result.ok, reason: result.reason ?? null, duplicate: result.duplicate ?? false, runId: result.run_id ?? null, escalated: result.escalated ?? false,
        escalationCount: result.escalation_count ?? 0,
      };
    },

    /** Ends a run exactly once. @returns {Promise<{ changed: boolean, becameNeedsYou: boolean, escalationCount: number }>} */
    async finishRun(storeId, conversationId, runId, { outcome, kind, body, flagReason, sources = [], conflict = null, trace = [] }) {
      const args = {
        p_store_id: requireStoreId(storeId), p_conversation_id: conversationId, p_run_id: runId, p_outcome: outcome, p_kind: kind, p_body: body,
        p_flag_reason: flagReason, p_sources: sources, p_conflict: conflict, p_trace: trace,
      };
      const result = await rpc('conversation_finish_run', args, finishResult);
      return { changed: result.changed, becameNeedsYou: result.became_needs_you ?? false, escalationCount: result.escalation_count ?? 0 };
    },

    /** @returns {Promise<{ ok: boolean, reason: string | null, duplicate: boolean }>} */
    async sellerReply(storeId, conversationId, { messageId, body }) {
      const args = { p_store_id: requireStoreId(storeId), p_conversation_id: conversationId, p_message_id: messageId, p_body: body };
      const result = await rpc('conversation_seller_reply', args, replyResult);
      return { ok: result.ok, reason: result.reason ?? null, duplicate: result.duplicate ?? false };
    },

    /** @returns {Promise<'conversation' | 'enquiry' | 'none'>} What the seller's deletion removed (the legacy enquiry too, when linked). */
    async deleteById(storeId, id) {
      const { data, error } = await client.rpc('conversation_delete', { p_store_id: requireStoreId(storeId), p_id: id });
      if (error) throw new AppError('DATABASE_ERROR', HTTP_INTERNAL_ERROR, 'Something went wrong', { operation: 'conversation_delete', pgCode: error.code });
      return parse(z.enum(['conversation', 'enquiry', 'none']), data, 'conversation_delete');
    },

    /** Retention sweep across all stores (the one deliberately cross-store call; only the background job uses it). */
    async purgeExpired({ limit, includeLegacy = false }) {
      const result = await rpc('conversation_purge_expired', { p_limit: limit, p_include_legacy: includeLegacy }, purgeResult);
      return { conversations: result.conversations, legacyEnquiries: result.legacy_enquiries, usageRows: result.usage_rows };
    },

    /** @returns {Promise<object | null>} The conversation with this token hash in THIS shop, or null. */
    async findByTokenHash(storeId, tokenHash) {
      const { data, error } = await conversations(storeId).eq('token_hash', tokenHash).maybeSingle();
      throwIfError(error);
      return data ? toConversation(parse(conversationRow, data, 'conversations.findByTokenHash')) : null;
    },

    /** @returns {Promise<object | null>} One conversation of this shop, with the encrypted link (seller views only). */
    async findForOwner(storeId, id) {
      const { data, error } = await conversations(storeId, `${CONVERSATION_COLUMNS}, token_enc`).eq('id', id).maybeSingle();
      throwIfError(error);
      return data ? toConversation(parse(conversationRow, data, 'conversations.findForOwner')) : null;
    },

    /** @returns {Promise<object[]>} Messages in order, after a sequence number (0 = from the start). `forOwner` also returns each message's trace (seller inbox only). */
    async listMessages(storeId, conversationId, { afterSeq = 0, forOwner = false } = {}) {
      const scoped = requireStoreId(storeId);
      const query = client.from('conversation_messages').select(forOwner ? OWNER_MESSAGE_COLUMNS : MESSAGE_COLUMNS).eq('store_id', scoped).eq('conversation_id', conversationId)
        .gt('seq', afterSeq).order('seq', { ascending: true }).limit(MAX_MESSAGES_PER_READ);
      const { data, error } = await query;
      throwIfError(error);
      return (data ?? []).map((row) => toMessage(parse(messageRow, row, 'conversation_messages.list')));
    },

    /** @returns {Promise<object[]>} The latest messages (default 8) in chronological order: the assistant's context. */
    async recentMessages(storeId, conversationId, limit = MAX_CONTEXT_MESSAGES) {
      const scoped = requireStoreId(storeId);
      const query = client.from('conversation_messages').select(MESSAGE_COLUMNS).eq('store_id', scoped).eq('conversation_id', conversationId)
        .order('seq', { ascending: false }).limit(limit);
      const { data, error } = await query;
      throwIfError(error);
      return (data ?? []).map((row) => toMessage(parse(messageRow, row, 'conversation_messages.recent'))).reverse();
    },

    /** Newest activity first, at most 100. `filter`: 'needs_you', 'handled', or 'unanswered' (the last message is the customer's). */
    async listForOwner(storeId, { filter = null } = {}) {
      let query = conversations(storeId).order('last_activity_at', { ascending: false }).order('id', { ascending: false }).limit(MAX_LISTED_CONVERSATIONS);
      if (filter === 'needs_you' || filter === 'handled') query = query.eq('status', filter);
      if (filter === 'unanswered') query = query.eq('last_message_role', 'customer');
      const { data, error } = await query;
      throwIfError(error);
      return (data ?? []).map((row) => toConversation(parse(conversationRow, row, 'conversations.listForOwner')));
    },

    /** @returns {Promise<number>} Conversations of this store waiting for the seller (the dashboard counter). */
    async countNeedsYou(storeId) {
      const query = client.from('conversations').select('id', { count: 'exact', head: true }).eq('store_id', requireStoreId(storeId)).eq('status', 'needs_you');
      const { count, error } = await query;
      throwIfError(error);
      return count ?? 0;
    },

    /** Compare-and-set open or needs_you -> handled. @returns {Promise<boolean>} */
    async markHandled(storeId, id, nowIso) {
      const query = client.from('conversations').update({ status: 'handled', updated_at: nowIso }).eq('store_id', requireStoreId(storeId)).eq('id', id).in('status', ['open', 'needs_you']);
      const { data, error } = await query.select('id');
      throwIfError(error);
      return (data ?? []).length > 0;
    },

    /** The seller's account context for a shop: who pays for the AI call and whether the alert email is on. @returns {Promise<object | null>} */
    async findOwnerContext(storeId) {
      const query = client.from('stores').select('owner_id, name, notify_enquiry_email, owners(is_demo)').eq('id', requireStoreId(storeId));
      const { data, error } = await query.maybeSingle();
      throwIfError(error);
      if (!data) return null;
      const row = parse(contextRow, data, 'conversations.findOwnerContext');
      return { id: storeId, ownerId: row.owner_id, name: row.name, notifyEnquiryEmail: row.notify_enquiry_email, isDemo: row.owners.is_demo };
    },
  };
}
