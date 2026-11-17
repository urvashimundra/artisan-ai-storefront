import { estimateBulkRulesReservationMicroUsd } from '../ai/bulkRuleExtractor.js';
import { ListingProviderError } from '../ai/listingGenerator.js';
import { knowledgeSchema, parseRulesForm } from '../domain/knowledgeRules.js';
import { AppError } from '../lib/errors.js';
import { createBudgetedCall } from './budgetedCall.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_BAD_GATEWAY = 502;
const HTTP_GATEWAY_TIMEOUT = 504;

const ERRORS = {
  empty: () => new AppError('KNOWLEDGE_EMPTY', HTTP_BAD_REQUEST, 'Save your shop notes first, then ask Claude to find the bulk discounts.'),
  timeout: () => new AppError('AI_TIMEOUT', HTTP_GATEWAY_TIMEOUT, 'The AI took too long to answer. Please try again, or enter the discounts yourself.'),
  provider: () => new AppError('AI_PROVIDER_ERROR', HTTP_BAD_GATEWAY, 'The AI service is not available right now. Please try again in a few minutes, or enter the discounts yourself.'),
  invalidOutput: () => new AppError('AI_INVALID_OUTPUT', HTTP_BAD_GATEWAY, 'The AI did not produce usable discounts. Please enter them yourself.'),
};

/**
 * The shop knowledge document and the confirmed bulk tiers. The store always comes from the session (never from input). Replacing the
 * document CLEARS the confirmed tiers (fail-closed: a tier is only ever valid for the text the owner confirmed it against).
 * The AI search only PREFILLS the form: nothing is used until the owner saves it. `extractor` and `budgets` are absent when Claude is not configured.
 * @param {{ knowledge: ReturnType<import('../repositories/knowledgeRepository.js').createKnowledgeRepository>,
 *   extractor?: ReturnType<typeof import('../ai/bulkRuleExtractor.js').createBulkRuleExtractor>, budgets?: object,
 *   logger?: { info: Function, warn: Function, error: Function }, now?: () => number }} deps
 */
export function createKnowledgeService({ knowledge, extractor, budgets, logger, now = Date.now }) {
  const budgetedCall = extractor && budgets ? createBudgetedCall({ budgets, logger }) : null;
  const nowIso = () => new Date(now()).toISOString();

  async function callExtractor({ owner, content, context }) {
    try {
      return await budgetedCall({ owner, estimateMicroUsd: estimateBulkRulesReservationMicroUsd(content), context, call: () => extractor.extract(content) });
    } catch (error) {
      if (!(error instanceof ListingProviderError)) throw error;
      throw error.kind === 'timeout' ? ERRORS.timeout() : ERRORS.provider();
    }
  }

  return {
    canExtract: Boolean(budgetedCall),

    /** @param {{ id: string }} store @returns {Promise<{ content: string, rules: object[] }>} */
    async get(store) {
      const row = await knowledge.get(store.id);
      return { content: row?.content ?? '', rules: row?.bulkRules ?? [] };
    },

    /**
     * Replaces the document (strict validation, one UPSERT) and clears the confirmed tiers.
     * @returns {Promise<{ clearedRules: boolean }>} True when tiers existed and were cleared, so the owner can be told.
     * @throws {import('zod').ZodError}
     */
    async saveDocument(store, body) {
      const { content } = knowledgeSchema.parse(body ?? {});
      const existing = await knowledge.get(store.id);
      await knowledge.replaceContent(store.id, content, nowIso());
      const clearedRules = (existing?.bulkRules.length ?? 0) > 0;
      logger?.info('knowledge saved', { storeId: store.id, characters: content.length, clearedRules });
      return { clearedRules };
    },

    /** Saves the owner's CONFIRMED tiers. @throws {import('zod').ZodError} */
    async saveRules(store, body) {
      const rules = parseRulesForm(body);
      await knowledge.saveRules(store.id, rules, nowIso());
      logger?.info('bulk rules saved', { storeId: store.id, tiers: rules.length });
      return rules;
    },

    /**
     * One Claude call that PROPOSES tiers from the saved document. Nothing is stored.
     * @param {{ store: { id: string }, owner: { id: string, isDemo: boolean }, correlationId?: string }} request
     * @returns {Promise<{ minQty: number, percentOff: number }[]>} Possibly empty (the document states no explicit rule).
     * @throws {AppError} KNOWLEDGE_EMPTY, AI_BUDGET_EXHAUSTED, AI_BUDGET_UNAVAILABLE, AI_TIMEOUT, AI_PROVIDER_ERROR, AI_INVALID_OUTPUT.
     */
    async findBulkRules({ store, owner, correlationId }) {
      const { content } = await this.get(store);
      if (content.trim() === '') throw ERRORS.empty();
      const context = { correlationId, storeId: store.id };
      const { result, charged } = await callExtractor({ owner, content, context });
      logger?.info('bulk rules proposed', { ...context, model: extractor.model, promptVersion: extractor.promptVersion, ok: result.ok, tokIn: charged.inputTokens, tokOut: charged.outputTokens, costMicroUsd: charged.costMicroUsd });
      if (!result.ok) throw ERRORS.invalidOutput();
      return result.tiers;
    },
  };
}
