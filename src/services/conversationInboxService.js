import { z } from 'zod';
import { AppError, notFound } from '../lib/errors.js';
import { inboxFilter, refusalError, sellerReplySchema } from '../domain/conversationRules.js';
import { absoluteUrl } from '../domain/seo.js';
import { buildWhatsappLink } from '../domain/whatsapp.js';
import { formatExpiry } from './orderService.js';
import { isProductId } from './publicShopService.js';

const NOT_FOUND_MESSAGE = 'Conversation not found';
const HTTP_CONFLICT = 409;
const PREVIEW_LENGTH = 110;

/** What the seller sees for each state: text, never colour alone. */
export const STATE_LABELS = Object.freeze({ needs_you: 'Needs you', unanswered: 'Unanswered', open: 'Answered by assistant', handled: 'Handled' });
const SOURCE_LABELS = Object.freeze({ seller_notes: 'Your shop notes', product_description: 'Product description', shop_profile: 'Shop profile', live_catalog: 'Live shop data' });
const FLAG_LABELS = Object.freeze({
  not_in_document: 'The assistant could not finish this from your notes and live shop data, so it passed it to you. Its message says what was missing.',
  source_conflict: 'Two of your written sources disagree. The assistant did not choose one: please decide and reply.',
  budget: 'The daily AI limit was reached, so the message came straight to you.',
  store_limit: "Your shop's daily limit for assistant answers was reached.",
  provider_limit: 'The AI provider was too busy. The message came to you.',
  provider_error: 'The AI provider had a problem. The message came to you.',
  timeout: 'The assistant took too long. The message came to you.',
  network: 'The assistant could not be reached. The message came to you.',
  invalid_output: 'The assistant could not produce a reliable answer, so it came to you.',
  refused: 'The assistant declined to answer this.',
  too_complex: 'The question needed too many steps for the assistant.',
  unverified_amount: 'The assistant tried to state a price on its own, so its answer was blocked.',
  knowledge_too_long: 'Your shop notes are too long for the assistant to use. Shorten them in Shop notes.',
  unavailable: 'The assistant was unavailable. The message came to you.',
});
const deleteSchema = z.object({ confirm: z.literal('yes') }).strict();

const clip = (text, max) => (Array.from(text).length > max ? `${Array.from(text).slice(0, max).join('')}...` : text);

/** @param {{ status: string, lastMessageRole: string | null }} conversation @returns {'needs_you' | 'unanswered' | 'handled' | 'open'} */
export function stateOf(conversation) {
  if (conversation.status === 'needs_you') return 'needs_you';
  if (conversation.lastMessageRole === 'customer') return 'unanswered';
  return conversation.status === 'handled' ? 'handled' : 'open';
}

function rowView(conversation) {
  const state = stateOf(conversation);
  return {
    id: conversation.id, customerName: conversation.customerName, preview: clip(conversation.lastPreview, PREVIEW_LENGTH), state, stateLabel: STATE_LABELS[state],
    time: formatExpiry(conversation.lastActivityAt, 'en'), messageCount: conversation.messageCount,
  };
}

function messageView(message) {
  const conflict = message.conflict
    ? { topic: String(message.conflict.topic ?? ''), claims: (message.conflict.claims ?? []).map((claim) => ({ label: SOURCE_LABELS[claim.label] ?? claim.label, excerpt: String(claim.excerpt ?? '') })) }
    : null;
  return {
    id: message.id, seq: message.seq, role: message.role, kind: message.kind, text: message.body, time: formatExpiry(message.createdAt, 'en'),
    sources: [...new Set(message.sources.map((source) => SOURCE_LABELS[source.label]).filter(Boolean))], conflict,
    flagText: message.flagReason ? FLAG_LABELS[message.flagReason] : null,
  };
}

/**
 * The seller's Conversations inbox. Every lookup is scoped to the store of the session (passed in by the controller from `req.store`); the
 * conversation id in the URL is only ever looked up inside that store. A seller reply is appended to the customer's existing conversation by one
 * database function (idempotent on its message id) and marks it handled. The customer's name and number are returned only here, to the
 * authenticated owner. "Open WhatsApp" carries the latest seller reply plus the customer's private link (decrypted from the stored ciphertext).
 * Legacy enquiries not yet copied into conversations are listed after the conversations and open in the old detail view.
 * @param {{ conversations: ReturnType<import('../repositories/conversationRepository.js').createConversationRepository>,
 *   legacy?: { list: Function } | null, logger: { info: Function, warn: Function },
 *   linkCipher?: { decrypt: (value: string) => string | null } | null, baseUrl: string, now?: () => number }} deps
 */
export function createConversationInboxService({ conversations, legacy = null, logger, linkCipher = null, baseUrl, now = Date.now }) {
  const nowIso = () => new Date(now()).toISOString();

  function privateLink(store, conversation) {
    const token = conversation.tokenEnc && linkCipher ? linkCipher.decrypt(conversation.tokenEnc) : null;
    return token ? absoluteUrl(baseUrl, `/s/${store.slug}/c/${token}`) : null;
  }

  function whatsappUrl(store, conversation, messages) {
    const link = privateLink(store, conversation);
    const reply = [...messages].reverse().find((message) => message.role === 'seller');
    const text = [reply?.body, link].filter(Boolean).join('\n\n');
    return text === '' ? buildWhatsappLink(conversation.customerPhone, '') : buildWhatsappLink(conversation.customerPhone, text);
  }

  return {
    /** @param {{ id: string }} store From the session. @param {string | null} filter 'needs_you', 'unanswered' or 'handled'. */
    async list(store, filter) {
      const applied = inboxFilter(filter);
      const rows = await conversations.listForOwner(store.id, { filter: applied === 'unanswered' ? null : applied });
      const shown = applied === 'unanswered' ? rows.filter((row) => stateOf(row) === 'unanswered') : rows;
      const earlier = legacy ? await legacy.list(store, applied === 'unanswered' ? null : applied) : { rows: [] };
      const copied = new Set(rows.map((row) => row.legacyEnquiryId).filter(Boolean));
      return { filter: applied, rows: shown.map(rowView), earlier: earlier.rows.filter((row) => !copied.has(row.id)) };
    },

    /** @returns {Promise<object | null>} null when the conversation is not in this store (the caller may then try a legacy enquiry). */
    async get(store, id) {
      if (!isProductId(id)) return null;
      const conversation = await conversations.findForOwner(store.id, id);
      if (!conversation) return null;
      const messages = await conversations.listMessages(store.id, id);
      const state = stateOf(conversation);
      return {
        id: conversation.id, state, stateLabel: STATE_LABELS[state], customerName: conversation.customerName, customerPhone: `+${conversation.customerPhone}`,
        language: conversation.language, started: formatExpiry(conversation.createdAt, 'en'), messageCount: conversation.messageCount,
        flagText: conversation.status === 'needs_you' && conversation.flagReason ? FLAG_LABELS[conversation.flagReason] : null,
        messages: messages.map(messageView), assistantRunning: conversation.aiRunStartedAt !== null, canMarkHandled: conversation.status !== 'handled',
        whatsappUrl: whatsappUrl(store, conversation, messages), hasPrivateLink: privateLink(store, conversation) !== null,
      };
    },

    /**
     * Appends the reply to the customer's conversation and marks it handled. A repeat with the same messageId adds nothing.
     * @throws {import('zod').ZodError} @throws {AppError} 404 when the conversation is not in this store, 409 when it is full.
     */
    async reply(store, id, body) {
      const form = sellerReplySchema.parse(body ?? {});
      if (!isProductId(id)) throw notFound(NOT_FOUND_MESSAGE);
      const result = await conversations.sellerReply(store.id, id, { messageId: form.messageId, body: form.reply });
      if (!result.ok) throw result.reason === 'conversation_full' ? new AppError('CONVERSATION_FULL', HTTP_CONFLICT, 'This conversation is full') : refusalError(result.reason ?? 'not_found');
      logger.info('conversation replied', { storeId: store.id, conversationId: id, duplicate: result.duplicate });
    },

    /** Repeating it is harmless. @throws {AppError} 404 when the conversation is not in this store. */
    async markHandled(store, id) {
      if (!isProductId(id)) throw notFound(NOT_FOUND_MESSAGE);
      if (!(await conversations.markHandled(store.id, id, nowIso())) && (await conversations.findForOwner(store.id, id))?.status !== 'handled') throw notFound(NOT_FOUND_MESSAGE);
      logger.info('conversation handled', { storeId: store.id, conversationId: id });
    },

    /**
     * Seller-initiated deletion: the conversation, its messages, the private link material and any linked legacy enquiry are removed.
     * @throws {import('zod').ZodError} without confirm=yes. @throws {AppError} 404 when nothing of this store has that id.
     */
    async remove(store, id, body) {
      deleteSchema.parse(body ?? {});
      if (!isProductId(id) || (await conversations.deleteById(store.id, id)) === 'none') throw notFound(NOT_FOUND_MESSAGE);
      logger.info('conversation deleted', { storeId: store.id, conversationId: id });
    },

    /** @returns {Promise<boolean>} True when the id is a conversation of this store (otherwise it may be a legacy enquiry). */
    async has(store, id) {
      return isProductId(id) && (await conversations.findForOwner(store.id, id)) !== null;
    },

    /** @returns {Promise<number>} Conversations and not-yet-copied legacy enquiries waiting for the seller (the dashboard counter). */
    async needsYouCount(storeId) {
      const chats = await conversations.listForOwner(storeId, { filter: 'needs_you' });
      const copied = new Set(chats.map((row) => row.legacyEnquiryId).filter(Boolean));
      const old = legacy ? (await legacy.list({ id: storeId }, 'needs_you')).rows.filter((row) => !copied.has(row.id)) : [];
      return chats.length + old.length;
    },
  };
}
