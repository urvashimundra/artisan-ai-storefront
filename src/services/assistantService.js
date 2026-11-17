import { createEnquiryTools } from '../ai/tools/enquiryTools.js';
import { AGENT_WALL_CLOCK_MS, ENQUIRY_STATUS, STUCK_AFTER_MS, isStuck } from '../domain/enquiryRules.js';
import { resolveLanguage } from '../domain/language.js';
import { stringsFor } from '../domain/publicStrings.js';
import { hashStatusToken, isWellFormedToken } from '../lib/statusToken.js';
import { createBudgetedCall } from './budgetedCall.js';
import { buildEnquiryView } from './enquiryView.js';
import { normalizeSlug } from './publicShopService.js';

const iso = (ms) => new Date(ms).toISOString();

/**
 * LEGACY customer side of "ask the seller" (Module 6): the private answer page of an existing enquiry and running the assistant once for one that
 * is still pending. New questions go through the chat (conversationService); no enquiry is created here any more. The shop comes from the URL
 * slug (resolved here) and the seller's account (who pays for the AI call) is read by shop id, never from input. GET never calls Claude: only the POST that wins the
 * pending -> answering claim runs the agent. Any failure keeps the question and hands it to the seller.
 * @param {{ shops: { findShopBySlug: Function, listPublished: Function, findPublished: Function },
 *   enquiries: ReturnType<import('../repositories/enquiryRepository.js').createEnquiryRepository>,
 *   knowledge: { get: Function }, agent?: ReturnType<typeof import('../ai/enquiryAgent.js').createEnquiryAgent> | null, budgets?: object | null,
 *   emails?: { enqueueSellerEnquiryAlert: Function }, logger: { info: Function, warn: Function, error: Function }, baseUrl: string,
 *   now?: () => number, agentWallClockMs?: number }} deps
 */
export function createAssistantService({
  shops, enquiries, knowledge, agent = null, budgets = null, emails = null, logger, baseUrl, now = Date.now, agentWallClockMs = AGENT_WALL_CLOCK_MS,
}) {
  const budgetedCall = agent && budgets ? createBudgetedCall({ budgets, logger }) : null;

  const prefsLanguage = (prefs, shop) => resolveLanguage({ ...prefs, shopDefault: shop.defaultLanguage }).language;

  async function findShop(slug) {
    const parsed = normalizeSlug(slug);
    return parsed ? shops.findShopBySlug(parsed.slug) : null;
  }

  /** "Needs the seller" alert: never fails the request, and queues at most one email per enquiry (dedupe key enquiry id). */
  async function alertSeller(storeId, enquiryId) {
    if (!emails) return;
    try {
      const context = await enquiries.findOwnerContext(storeId);
      if (context) await emails.enqueueSellerEnquiryAlert(context, enquiryId);
    } catch (error) {
      logger.warn('seller enquiry alert failed', { storeId, enquiryId, code: error?.code });
    }
  }

  /** An enquiry stuck in answering for more than two minutes becomes needs_you (exactly one caller changes it, and alerts). */
  async function settleStuck(storeId, enquiry, tokenHash) {
    if (!isStuck(enquiry, now())) return enquiry;
    const changed = await enquiries.failStuck(storeId, enquiry.id, iso(now() - STUCK_AFTER_MS), iso(now()));
    if (changed) await alertSeller(storeId, enquiry.id);
    return (await enquiries.findByTokenHash(storeId, tokenHash)) ?? enquiry;
  }

  /** @returns {Promise<{ shop: object, enquiry: object, tokenHash: string } | null>} null for any unknown, other-shop or malformed link. */
  async function load(slug, token) {
    if (!isWellFormedToken(token)) return null;
    const shop = await findShop(slug);
    if (!shop) return null;
    const tokenHash = hashStatusToken(token);
    const found = await enquiries.findByTokenHash(shop.id, tokenHash);
    return found ? { shop, enquiry: await settleStuck(shop.id, found, tokenHash), tokenHash } : null;
  }

  /** Maps the agent's outcome to what is stored. needs_seller ALWAYS becomes needs_you, whatever the text says. */
  function toOutcome(result) {
    if (!result.ok) return { status: ENQUIRY_STATUS.NEEDS_YOU, answerText: null, flagReason: result.reason };
    if (result.outcome === 'needs_seller') return { status: ENQUIRY_STATUS.NEEDS_YOU, answerText: result.text, flagReason: 'not_in_document' };
    return { status: ENQUIRY_STATUS.ANSWERED, answerText: result.text, flagReason: null };
  }

  async function runAgent({ shop, enquiry, context, correlationId }) {
    const tools = createEnquiryTools({ storeId: shop.id, shop, language: enquiry.language, shops, knowledge });
    return agent.run({
      shopName: shop.name, language: enquiry.language, question: enquiry.question, productId: enquiry.productId, tools,
      quoteNote: stringsFor(enquiry.language).quoteEstimateNote, budgetedCall, owner: { id: context.ownerId, isDemo: context.isDemo },
      context: { correlationId, storeId: shop.id, enquiryId: enquiry.id }, now, wallClockMs: agentWallClockMs,
    });
  }

  /** Runs the assistant for a claimed enquiry and stores the outcome. Logs ids, status, steps, tokens and cost only. */
  async function processClaimed({ shop, enquiry, correlationId }) {
    const context = await enquiries.findOwnerContext(shop.id);
    const result = context ? await runAgent({ shop, enquiry, context, correlationId }) : { ok: false, reason: 'error', detail: 'no_owner', trace: [], steps: 0, charged: {} };
    const outcome = toOutcome(result);
    const saved = await enquiries.finish(shop.id, enquiry.id, { ...outcome, trace: result.trace }, iso(now()));
    logger.info('enquiry answered', {
      correlationId, storeId: shop.id, enquiryId: enquiry.id, status: outcome.status, flagReason: outcome.flagReason, detail: result.detail,
      steps: result.steps, tokIn: result.charged?.inputTokens, tokOut: result.charged?.outputTokens, costMicroUsd: result.charged?.costMicroUsd, saved,
    });
    if (saved && outcome.status === ENQUIRY_STATUS.NEEDS_YOU) await alertSeller(shop.id, enquiry.id);
  }

  return {
    /** The private page. NEVER calls Claude. @returns {Promise<{ language: string, view: object } | null>} null for any unknown link. */
    async getPage(slug, token, prefs) {
      const loaded = await load(slug, token);
      if (!loaded) return null;
      const language = prefsLanguage(prefs, { defaultLanguage: loaded.enquiry.language });
      return { language, view: buildEnquiryView({ shop: loaded.shop, enquiry: loaded.enquiry, language, token, baseUrl }) };
    },

    /**
     * Runs the assistant once. Only the request that wins the conditional pending -> answering update does any work, so a refresh or
     * a double submit runs the agent once. The caller always redirects back to the page afterwards.
     * @returns {Promise<boolean>} false for an unknown link.
     */
    async answer(slug, token, { correlationId } = {}) {
      const loaded = await load(slug, token);
      if (!loaded) return false;
      const { shop, enquiry } = loaded;
      if (enquiry.status !== ENQUIRY_STATUS.PENDING) return true;
      if (!(await enquiries.claim(shop.id, enquiry.id, iso(now())))) return true;
      try {
        await processClaimed({ shop, enquiry, correlationId });
      } catch (error) {
        logger.error('enquiry processing failed', { correlationId, storeId: shop.id, enquiryId: enquiry.id, code: error?.code, err: error });
      }
      return true;
    },
  };
}
