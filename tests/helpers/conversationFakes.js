import { randomUUID } from 'node:crypto';
import { CUSTOMER_DAILY_QUESTION_LIMIT, MAX_CONVERSATION_MESSAGES, SELLER_MESSAGE_HEADROOM, STORE_DAILY_AI_ANSWER_LIMIT } from '../../src/domain/conversationRules.js';
import { AppError } from '../../src/lib/errors.js';
import { requireStoreId } from '../../src/repositories/requireStoreId.js';

/**
 * In-memory conversation repository that models migration 013's functions with the same rules: store-scoped lookups, the customer and store
 * limits (with reserve / settle / release), idempotency keys, one run per conversation, escalation counting, and deletion. `failNext` makes the
 * next call throw a database error. Calls are synchronous inside, so concurrent callers are serialized like the database's row locks do.
 */
export function createFakeConversationRepo({ now = Date.now, ownerContextOf = null, legacyDelete = null } = {}) {
  const conversations = new Map();
  const messages = [];
  const customerUsed = new Map();
  const state = { storeUsed: 0, storeReserved: 0, failNext: null };
  const iso = () => new Date(now()).toISOString();
  const scoped = (storeId, id) => {
    const found = conversations.get(id);
    return found && found.storeId === requireStoreId(storeId) ? found : null;
  };
  const fail = () => {
    if (!state.failNext) return;
    state.failNext = null;
    throw new AppError('DATABASE_ERROR', 500, 'Something went wrong', { pgCode: 'XX000' });
  };
  const append = (conversation, role, kind, body, extra = {}) => {
    conversation.messageCount += 1;
    const message = {
      id: extra.id ?? randomUUID(), seq: conversation.messageCount, role, kind, body, flagReason: extra.flagReason ?? null, sources: extra.sources ?? [],
      conflict: extra.conflict ?? null, createdAt: iso(), conversationId: conversation.id,
    };
    messages.push(message);
    conversation.lastMessageRole = role;
    conversation.lastPreview = body.slice(0, 160);
    conversation.lastActivityAt = iso();
    return message;
  };
  const beginRun = (conversation, limitNotice) => {
    if (state.storeUsed + state.storeReserved < STORE_DAILY_AI_ANSWER_LIMIT) {
      state.storeReserved += 1;
      conversation.aiRunId = randomUUID();
      conversation.aiRunStartedAt = iso();
      return conversation.aiRunId;
    }
    append(conversation, 'assistant', 'escalation', limitNotice, { flagReason: 'store_limit' });
    if (conversation.status !== 'needs_you') conversation.escalationCount += 1;
    conversation.status = 'needs_you';
    conversation.flagReason = 'store_limit';
    return null;
  };
  const takeSlot = (storeId, phone) => {
    const key = `${storeId}:${phone}`;
    if ((customerUsed.get(key) ?? 0) >= CUSTOMER_DAILY_QUESTION_LIMIT) return false;
    customerUsed.set(key, (customerUsed.get(key) ?? 0) + 1);
    return true;
  };
  const hasMessageId = (conversation, id) => messages.some((m) => m.conversationId === conversation.id && m.clientMsgId === id);
  const view = (conversation) => ({ ...conversation });

  return {
    conversations,
    messages,
    state,
    customerUsed,

    async start(storeId, input) {
      requireStoreId(storeId);
      fail();
      const existing = [...conversations.values()].find((c) => c.storeId === storeId && c.startKey === input.startKey);
      if (existing) return { ok: true, reason: null, duplicate: true, conversationId: existing.id, tokenEnc: existing.tokenEnc, runId: null, escalated: false, escalationCount: 0 };
      if (!takeSlot(storeId, input.phone)) return { ok: false, reason: 'customer_limit', duplicate: false, conversationId: null, tokenEnc: null, runId: null, escalated: false, escalationCount: 0 };
      const conversation = {
        id: randomUUID(), storeId, productId: input.productId, language: input.language, customerName: input.name, customerPhone: input.phone, status: 'open',
        flagReason: null, tokenHash: input.tokenHash, tokenEnc: input.tokenEnc, startKey: input.startKey, messageCount: 0, lastMessageRole: null, lastPreview: '',
        escalationCount: 0, aiRunId: null, aiRunStartedAt: null, legacyEnquiryId: null, lastActivityAt: iso(), createdAt: iso(), updatedAt: iso(),
      };
      conversations.set(conversation.id, conversation);
      append(conversation, 'customer', 'text', input.body).clientMsgId = input.messageId;
      const runId = beginRun(conversation, input.limitNotice);
      return { ok: true, reason: null, duplicate: false, conversationId: conversation.id, tokenEnc: null, runId, escalated: runId === null, escalationCount: conversation.escalationCount };
    },

    async postMessage(storeId, conversationId, { messageId, body, limitNotice }) {
      fail();
      const conversation = scoped(storeId, conversationId);
      const base = { duplicate: false, runId: null, escalated: false, escalationCount: 0 };
      if (!conversation) return { ok: false, reason: 'not_found', ...base };
      if (hasMessageId(conversation, messageId)) return { ok: true, reason: null, ...base, duplicate: true };
      if (conversation.messageCount > MAX_CONVERSATION_MESSAGES - 2) return { ok: false, reason: 'conversation_full', ...base };
      if (conversation.aiRunId) return { ok: false, reason: 'busy', ...base };
      if (!takeSlot(storeId, conversation.customerPhone)) return { ok: false, reason: 'customer_limit', ...base };
      append(conversation, 'customer', 'text', body).clientMsgId = messageId;
      if (conversation.status === 'handled') conversation.status = 'open';
      const runId = beginRun(conversation, limitNotice);
      return { ok: true, reason: null, duplicate: false, runId, escalated: runId === null, escalationCount: conversation.escalationCount };
    },

    async finishRun(storeId, conversationId, runId, { outcome, kind, body, flagReason, sources = [], conflict = null }) {
      fail();
      const conversation = scoped(storeId, conversationId);
      if (!conversation || conversation.aiRunId !== runId) return { changed: false, becameNeedsYou: false, escalationCount: 0 };
      state.storeReserved -= 1;
      if (outcome === 'answered') state.storeUsed += 1;
      append(conversation, 'assistant', kind, body, { flagReason, sources, conflict });
      const toSeller = outcome !== 'answered';
      const became = toSeller && conversation.status !== 'needs_you';
      if (toSeller) Object.assign(conversation, { status: 'needs_you', flagReason });
      if (became) conversation.escalationCount += 1;
      conversation.aiRunId = null;
      conversation.aiRunStartedAt = null;
      return { changed: true, becameNeedsYou: became, escalationCount: conversation.escalationCount };
    },

    async sellerReply(storeId, conversationId, { messageId, body }) {
      fail();
      const conversation = scoped(storeId, conversationId);
      if (!conversation) return { ok: false, reason: 'not_found', duplicate: false };
      if (hasMessageId(conversation, messageId)) return { ok: true, reason: null, duplicate: true };
      if (conversation.messageCount >= MAX_CONVERSATION_MESSAGES + SELLER_MESSAGE_HEADROOM) return { ok: false, reason: 'conversation_full', duplicate: false };
      append(conversation, 'seller', 'text', body).clientMsgId = messageId;
      Object.assign(conversation, { status: 'handled', flagReason: null });
      return { ok: true, reason: null, duplicate: false };
    },

    async deleteById(storeId, id) {
      const conversation = scoped(storeId, id);
      if (!conversation) return legacyDelete?.(requireStoreId(storeId), id) ? 'enquiry' : 'none';
      if (conversation.aiRunId) state.storeReserved -= 1;
      conversations.delete(id);
      for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i].conversationId === id) messages.splice(i, 1);
      return 'conversation';
    },

    async findByTokenHash(storeId, tokenHash) {
      requireStoreId(storeId);
      const found = [...conversations.values()].find((c) => c.storeId === storeId && c.tokenHash === tokenHash);
      return found ? view(found) : null;
    },

    async findForOwner(storeId, id) {
      const found = scoped(storeId, id);
      return found ? view(found) : null;
    },

    async listMessages(storeId, conversationId, { afterSeq = 0 } = {}) {
      requireStoreId(storeId);
      if (!scoped(storeId, conversationId)) return [];
      return messages.filter((m) => m.conversationId === conversationId && m.seq > afterSeq).map((m) => ({ ...m }));
    },

    async recentMessages(storeId, conversationId, limit = 8) {
      if (!scoped(storeId, conversationId)) return [];
      return messages.filter((m) => m.conversationId === conversationId).slice(-limit).map((m) => ({ ...m }));
    },

    async listForOwner(storeId, { filter = null } = {}) {
      requireStoreId(storeId);
      return [...conversations.values()]
        .filter((c) => c.storeId === storeId && (!filter || (filter === 'unanswered' ? c.lastMessageRole === 'customer' : c.status === filter)))
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)).map(view);
    },

    async countNeedsYou(storeId) {
      requireStoreId(storeId);
      return [...conversations.values()].filter((c) => c.storeId === storeId && c.status === 'needs_you').length;
    },

    async markHandled(storeId, id) {
      const found = scoped(storeId, id);
      if (!found || found.status === 'handled') return false;
      found.status = 'handled';
      return true;
    },

    async findOwnerContext(storeId) {
      if (ownerContextOf) return ownerContextOf(requireStoreId(storeId));
      return { id: storeId, ownerId: '99999999-9999-4999-8999-999999999999', name: 'Shop', notifyEnquiryEmail: true, isDemo: false };
    },

    async purgeExpired() {
      return { conversations: 0, legacyEnquiries: 0, usageRows: 0 };
    },
  };
}

/** A fake agent: returns the queued results in order (or `fallback`), recording every call's input. */
export function createFakeAgent({ results = [], fallback = null } = {}) {
  const calls = [];
  return {
    calls,
    queue: results,
    async run(input) {
      calls.push(input);
      const next = results.shift() ?? fallback;
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(input) : next;
    },
  };
}

export const answered = (text = 'It is in stock.', extra = {}) => ({ ok: true, outcome: 'answered', text, sources: [], trace: ['Checked product: Lamp'], steps: 2, charged: {}, ...extra });
export const failedRun = (reason, detail = 'x') => ({ ok: false, reason, detail, trace: [], steps: 1, charged: {} });
