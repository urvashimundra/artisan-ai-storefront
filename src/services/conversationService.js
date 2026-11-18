import { randomUUID } from 'node:crypto';
import { createEnquiryTools } from '../ai/tools/enquiryTools.js';
import {
  MAX_CONTEXT_MESSAGES, REASON_OUTCOMES, isStaleRun, messageSchema, persistenceError, refusalError, startSchema,
} from '../domain/conversationRules.js';
import { AGENT_WALL_CLOCK_MS } from '../domain/enquiryRules.js';
import { NOTICE_KEYS } from '../domain/conversationStrings.js';
import { resolveLanguage } from '../domain/language.js';
import { fillTemplate, stringsFor } from '../domain/publicStrings.js';
import { AppError, notFound } from '../lib/errors.js';
import { formatInr } from '../lib/money.js';
import { generateStatusToken, hashStatusToken, isWellFormedToken } from '../lib/statusToken.js';
import { createBudgetedCall } from './budgetedCall.js';
import { buildChatView, buildPollView, buildStartView } from './conversationView.js';
import { isProductId, normalizeSlug } from './publicShopService.js';

const NOT_FOUND_MESSAGE = 'Not found';
const HTTP_CONFLICT = 409;
/** The customer-facing outcome for each flag reason (distinct, see OUTCOMES in conversationRules). */
const REASON_TO_OUTCOME = Object.freeze({
  budget: 'budget', provider_limit: 'provider_limit', timeout: 'timeout', network: 'network', store_limit: 'store_limit',
  not_in_document: 'seller', source_conflict: 'seller', unverified_amount: 'seller', too_complex: 'seller', refused: 'seller', knowledge_too_long: 'seller',
  provider_error: 'ai_unavailable', invalid_output: 'ai_unavailable', unavailable: 'ai_unavailable',
});
const PRICE_CLAIM_REJECTION = 'price_claim';
const iso = (ms) => new Date(ms).toISOString();

/** The customer's note when the live stock cannot cover the quantity asked: the database's own figures, in fixed localised words. */
function stockShortBody({ title, requested, available, unitPricePaise }, strings) {
  if (available === 0) return fillTemplate(strings.chatNoticeSoldOut, { product: title });
  const key = available === 1 ? 'chatNoticeStockShortOne' : 'chatNoticeStockShort';
  return fillTemplate(strings[key], { product: title, price: formatInr(unitPricePaise), available: String(available), requested: String(requested) });
}

/**
 * The customer side of the persistent chat. The shop comes from the URL slug (resolved here); the conversation comes from the private
 * token, hashed and looked up INSIDE that shop; nothing the customer sends names a store or a conversation. A customer message is persisted
 * (with the limits, the idempotency key and the one-run claim) in ONE database function BEFORE any AI work, so an AI failure never loses it.
 * The agent runs inside the POST that won the run claim and its outcome is stored exactly once; a run stuck for two minutes is failed by
 * whoever next opens the chat. The seller is alerted at most once per escalation. It never throws for an AI failure.
 * @param {{ shops: { findShopBySlug: Function, listPublished: Function, findPublished: Function },
 *   conversations: ReturnType<import('../repositories/conversationRepository.js').createConversationRepository>, knowledge: { get: Function },
 *   agent?: { run: Function } | null, budgets?: object | null, emails?: { enqueueSellerEnquiryAlert: Function } | null,
 *   logger: { info: Function, warn: Function, error: Function }, linkCipher?: { encrypt: Function, decrypt: Function } | null,
 *   newToken?: () => string, now?: () => number, baseUrl?: string, agentWallClockMs?: number }} deps
 */
export function createConversationService({
  shops, conversations, knowledge, agent = null, budgets = null, emails = null, logger, linkCipher = null, newToken = generateStatusToken, now = Date.now, baseUrl = '',
  agentWallClockMs = AGENT_WALL_CLOCK_MS,
}) {
  const budgetedCall = agent && budgets ? createBudgetedCall({ budgets, logger }) : null;
  const languageOf = (prefs, fallback) => resolveLanguage({ ...prefs, shopDefault: fallback }).language;

  async function findShop(slug) {
    const parsed = normalizeSlug(slug);
    return parsed ? shops.findShopBySlug(parsed.slug) : null;
  }

  /** "Needs the seller" alert: never fails the request; at most one email per escalation (dedupe id: conversation id and escalation count). */
  async function alertSeller(storeId, conversationId, escalationCount) {
    if (!emails) return;
    try {
      const context = await conversations.findOwnerContext(storeId);
      if (context) await emails.enqueueSellerEnquiryAlert(context, `${conversationId}:${escalationCount}`);
    } catch (error) {
      logger.warn('seller conversation alert failed', { storeId, conversationId, code: error?.code });
    }
  }

  const failureBody = (language, reason) => stringsFor(language)[NOTICE_KEYS[reason]];

  /** Ends a run with a failure the customer is told about in fixed, localised words. Returns the finish result, or null if the database failed. */
  async function failRun(shop, conversation, runId, reason, language) {
    const { kind, result } = REASON_OUTCOMES[reason];
    try {
      const finished = await conversations.finishRun(shop.id, conversation.id, runId, { outcome: result, kind, body: failureBody(language, reason), flagReason: reason });
      if (finished.becameNeedsYou) await alertSeller(shop.id, conversation.id, finished.escalationCount);
      return finished;
    } catch (error) {
      logger.error('conversation run could not be finished', { storeId: shop.id, conversationId: conversation.id, code: error?.code });
      return null;
    }
  }

  /** The fixed refusal when the customer's own message claimed a price or discount: it never repeats the claim. */
function priceClaimFinish(strings) {
  return { outcome: 'escalated', kind: 'escalation', body: strings.chatNoticePriceClaim, flagReason: 'unverified_amount', outcomeKey: 'seller' };
}

/** Maps the agent's result to the finish arguments. A conflict and a not-found answer are escalations to the seller. */
  function toFinish(result, pageLanguage) {
    const strings = stringsFor(result.language ?? pageLanguage);
    if (result.rejection === PRICE_CLAIM_REJECTION) return priceClaimFinish(strings);
    if (!result.ok) {
      const { kind, result: outcome } = REASON_OUTCOMES[result.reason];
      return { outcome, kind, body: strings[NOTICE_KEYS[result.reason]], flagReason: result.reason, outcomeKey: REASON_TO_OUTCOME[result.reason] };
    }
    if (result.outcome === 'conflict') {
      return { outcome: 'escalated', kind: 'conflict', body: strings.chatNoticeConflict, flagReason: 'source_conflict', conflict: result.conflict, outcomeKey: 'seller' };
    }
    if (result.stockShortage) {
      return { outcome: 'escalated', kind: 'escalation', body: stockShortBody(result.stockShortage, strings), flagReason: 'not_in_document', outcomeKey: 'seller' };
    }
    if (result.outcome === 'needs_seller') {
      return { outcome: 'escalated', kind: 'escalation', body: result.text ?? strings.chatNoticeNotInDocument, flagReason: 'not_in_document', outcomeKey: 'seller' };
    }
    return { outcome: 'answered', kind: 'text', body: result.text, flagReason: null, outcomeKey: 'answered' };
  }

  async function runAgent({ shop, conversation, language, correlationId }) {
    const context = await conversations.findOwnerContext(shop.id);
    if (!context || !agent || !budgetedCall) return { ok: false, reason: 'unavailable', detail: context ? 'no_agent' : 'no_owner', trace: [], steps: 0, charged: {} };
    const [messages, document] = await Promise.all([conversations.recentMessages(shop.id, conversation.id, MAX_CONTEXT_MESSAGES), knowledge.get(shop.id)]);
    const tools = createEnquiryTools({ storeId: shop.id, shop, language, shops, knowledge, labelPlaceholders: true });
    return agent.run({
      shop, language, messages, knowledge: document ?? { content: '', bulkRules: [] }, productId: conversation.productId ?? null, tools, budgetedCall, owner: { id: context.ownerId, isDemo: context.isDemo },
      context: { correlationId, storeId: shop.id, conversationId: conversation.id }, now, wallClockMs: agentWallClockMs,
    });
  }

  /** Runs the assistant for a claimed run and stores the outcome once. Returns the outcome key the customer is told. */
  async function runAssistant({ shop, conversation, runId, language, correlationId }) {
    let result;
    try {
      result = await runAgent({ shop, conversation, language, correlationId });
    } catch (error) {
      logger.error('conversation agent crashed', { correlationId, storeId: shop.id, conversationId: conversation.id, code: error?.code });
      result = { ok: false, reason: 'unavailable', detail: 'crash', trace: [], steps: 0, charged: {} };
    }
    const finish = toFinish(result, language);
    let saved = null;
    try {
      saved = await conversations.finishRun(shop.id, conversation.id, runId, {
        outcome: finish.outcome, kind: finish.kind, body: finish.body, flagReason: finish.flagReason, sources: result.sources ?? [], conflict: finish.conflict ?? null, trace: result.trace ?? [],
      });
    } catch (error) {
      logger.error('conversation outcome could not be saved', { correlationId, storeId: shop.id, conversationId: conversation.id, code: error?.code });
    }
    logger.info('conversation answered', {
      correlationId, storeId: shop.id, conversationId: conversation.id, outcome: finish.outcomeKey, flagReason: finish.flagReason, detail: result.detail, steps: result.steps,
      tokIn: result.charged?.inputTokens, tokOut: result.charged?.outputTokens, costMicroUsd: result.charged?.costMicroUsd, saved: Boolean(saved?.changed),
    });
    if (saved?.becameNeedsYou) await alertSeller(shop.id, conversation.id, saved.escalationCount);
    return saved ? finish.outcomeKey : 'saved';
  }

  /** A run in flight for more than two minutes failed (the process died, or the database call never returned): the next visitor settles it. */
  async function settleStale(shop, conversation, tokenHash) {
    if (!isStaleRun(conversation, now())) return conversation;
    await failRun(shop, conversation, conversation.aiRunId, 'timeout', conversation.language);
    return (await conversations.findByTokenHash(shop.id, tokenHash)) ?? conversation;
  }

  /** @returns {Promise<{ shop: object, conversation: object, tokenHash: string } | null>} null for any unknown, other-shop or malformed link. */
  async function load(slug, token) {
    if (!isWellFormedToken(token)) return null;
    const shop = await findShop(slug);
    if (!shop) return null;
    const tokenHash = hashStatusToken(token);
    const found = await conversations.findByTokenHash(shop.id, tokenHash);
    return found ? { shop, conversation: await settleStale(shop, found, tokenHash), tokenHash } : null;
  }

  async function resolveProduct(shop, rawId) {
    if (rawId === undefined || rawId === '') return null;
    if (!isProductId(rawId) || !(await shops.findPublished(shop.id, rawId))) throw notFound(NOT_FOUND_MESSAGE);
    return rawId;
  }

  async function persist(operation) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AppError && error.code !== 'DATABASE_ERROR') throw error;
      logger.error('conversation message not persisted', { code: error?.code, name: error?.name });
      throw persistenceError();
    }
  }

  function tokenFromDuplicate(tokenEnc) {
    const token = tokenEnc && linkCipher ? linkCipher.decrypt(tokenEnc) : null;
    if (!token) throw new AppError('CONVERSATION_ALREADY_STARTED', HTTP_CONFLICT, 'This chat was already started');
    return token;
  }

  const api = {
    /** True when this private token belongs to a conversation of this shop (used to forward legacy /q/ links). NEVER calls Claude. */
    async hasChat(slug, token) {
      return (await load(slug, token)) !== null;
    },

    /** The start screen model (kind chat-start), with fresh idempotency keys unless the caller keeps the ones from a failed attempt. @returns {Promise<{ language: string, view: object } | null>} */
    async startPage(slug, prefs, { productId: rawProductId, values, errors, formError, keys } = {}) {
      const opened = await api.openStart(slug, prefs, rawProductId);
      if (!opened) return null;
      const fresh = keys ?? { startKey: randomUUID(), messageId: randomUUID() };
      return { language: opened.language, view: buildStartView({ shop: opened.shop, language: opened.language, productId: opened.productId, keys: fresh, values, errors, formError }) };
    },

    /** The private chat page model. NEVER calls Claude. @returns {Promise<{ language: string, view: object } | null>} */
    async chatPage(slug, token, prefs) {
      const opened = await api.open(slug, token, prefs);
      if (!opened) return null;
      const view = buildChatView({ ...opened, token, baseUrl, messageId: randomUUID(), nowMs: now() });
      return { language: opened.language, view };
    },

    /** New messages after a sequence number and the live state, for the page script. NEVER calls Claude. @returns {Promise<{ language: string, view: object } | null>} */
    async poll(slug, token, prefs, afterSeq) {
      const opened = await api.open(slug, token, prefs, { afterSeq });
      return opened ? { language: opened.language, view: buildPollView({ ...opened, nowMs: now() }) } : null;
    },

    /** Looks the shop up for the start screen. @returns {Promise<{ shop: object, language: string, productId: string | null } | null>} */
    async openStart(slug, prefs, rawProductId) {
      const shop = await findShop(slug);
      if (!shop) return null;
      const productId = isProductId(rawProductId) && (await shops.findPublished(shop.id, rawProductId)) ? rawProductId : null;
      return { shop, language: languageOf(prefs, shop.defaultLanguage), productId };
    },

    /**
     * Starts a conversation: validates, persists it with the first message and runs the assistant. Throws ZodError (bad input), AppError 404
     * (unknown shop or product), CUSTOMER_LIMIT 429, PERSISTENCE_FAILED 503. The hidden trap field answers like success but saves nothing.
     * @returns {Promise<{ trap: true, slug: string } | { trap: false, token: string, slug: string, language: string, outcome: string, duplicate: boolean }>}
     */
    async start(slug, prefs, body, { correlationId } = {}) {
      const shop = await findShop(slug);
      if (!shop) throw notFound(NOT_FOUND_MESSAGE);
      const form = startSchema.parse(body ?? {});
      if (form.website) return { trap: true, slug: shop.slug };
      const productId = await resolveProduct(shop, form.productId);
      const language = languageOf(prefs, shop.defaultLanguage);
      const token = newToken();
      const started = await persist(() => conversations.start(shop.id, {
        productId, language, name: form.name, phone: form.phone, tokenHash: hashStatusToken(token), tokenEnc: linkCipher ? linkCipher.encrypt(token) : null,
        startKey: form.startKey, messageId: form.messageId, body: form.message, limitNotice: stringsFor(language).chatNoticeStoreLimit,
      }));
      if (!started.ok) throw refusalError(started.reason);
      if (started.duplicate) return { trap: false, token: tokenFromDuplicate(started.tokenEnc), slug: shop.slug, language, outcome: 'saved', duplicate: true };
      logger.info('conversation started', { correlationId, storeId: shop.id, conversationId: started.conversationId, escalated: started.escalated });
      if (started.escalated) {
        await alertSeller(shop.id, started.conversationId, started.escalationCount);
        return { trap: false, token, slug: shop.slug, language, outcome: 'store_limit', duplicate: false };
      }
      const conversation = { id: started.conversationId, productId };
      const outcome = await runAssistant({ shop, conversation, runId: started.runId, language, correlationId });
      return { trap: false, token, slug: shop.slug, language, outcome, duplicate: false };
    },

    /** The private chat. NEVER calls Claude. @returns {Promise<{ shop: object, conversation: object, messages: object[], language: string } | null>} */
    async open(slug, token, prefs, { afterSeq = 0 } = {}) {
      const loaded = await load(slug, token);
      if (!loaded) return null;
      const { shop, conversation } = loaded;
      const messages = await conversations.listMessages(shop.id, conversation.id, { afterSeq });
      return { shop, conversation, messages, language: languageOf(prefs, conversation.language) };
    },

    /**
     * A follow-up message: persists it, then runs the assistant if this call won the run. Throws ZodError, CONVERSATION_BUSY 409,
     * CONVERSATION_FULL 409, CUSTOMER_LIMIT 429, PERSISTENCE_FAILED 503. A repeat of the same messageId saves and runs nothing.
     * @returns {Promise<{ found: false } | { found: true, outcome: string, duplicate: boolean, language: string }>}
     */
    async post(slug, token, prefs, body, { correlationId } = {}) {
      const loaded = await load(slug, token);
      if (!loaded) return { found: false };
      const { shop, conversation } = loaded;
      const form = messageSchema.parse(body ?? {});
      const language = languageOf(prefs, conversation.language);
      const posted = await persist(() => conversations.postMessage(shop.id, conversation.id, {
        messageId: form.messageId, body: form.message, limitNotice: stringsFor(language).chatNoticeStoreLimit,
      }));
      if (!posted.ok) throw refusalError(posted.reason);
      if (posted.duplicate) return { found: true, outcome: 'saved', duplicate: true, language };
      if (posted.escalated) {
        if (conversation.status !== 'needs_you') await alertSeller(shop.id, conversation.id, posted.escalationCount);
        return { found: true, outcome: 'store_limit', duplicate: false, language };
      }
      const outcome = await runAssistant({ shop, conversation, runId: posted.runId, language, correlationId });
      return { found: true, outcome, duplicate: false, language };
    },
  };
  return api;
}
