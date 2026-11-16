import { targetLanguages } from '../domain/storeTranslations.js';
import { estimateTranslationReservationMicroUsd } from '../ai/translationCost.js';
import { ListingProviderError } from '../ai/listingGenerator.js';
import { AppError } from '../lib/errors.js';
import { createBudgetedCall } from './budgetedCall.js';

const HTTP_BAD_GATEWAY = 502;
const HTTP_GATEWAY_TIMEOUT = 504;

/** One normal try plus one retry when the model's output fails validation. Each try reserves budget again. */
export const MAX_TRANSLATION_ATTEMPTS = 2;
const NO_RETRY_REASON = 'refused';

const ERRORS = {
  timeout: () => new AppError('AI_TIMEOUT', HTTP_GATEWAY_TIMEOUT, 'The AI took too long to answer. Please try again.'),
  provider: () =>
    new AppError('AI_PROVIDER_ERROR', HTTP_BAD_GATEWAY, 'The AI service is not available right now. Please try again in a few minutes.'),
  invalidOutput: () =>
    new AppError('AI_INVALID_OUTPUT', HTTP_BAD_GATEWAY, 'The AI did not produce usable translations. Please try again, or write them yourself.'),
};

/**
 * Drafts the shop tagline and story in the other languages. Claude only proposes: drafts are saved unapproved with
 * source 'ai', so nothing is public until the owner approves it. The tagline and story are the only data sent.
 * @param {{ translations: { upsertMany: Function }, budgets: object,
 *   generator: ReturnType<typeof import('../ai/translationGenerator.js').createTranslationGenerator>,
 *   logger?: { info: Function, warn: Function, error: Function } }} deps
 */
export function createTranslationDraftService({ translations, budgets, generator, logger }) {
  /** Languages holding text the owner wrote AND approved: a draft must never replace it. */
  async function protectedLanguages(storeId) {
    const rows = await translations.list(storeId);
    return rows.filter((row) => row.approved && row.source === 'owner').map((row) => row.language);
  }

  const budgetedCall = createBudgetedCall({ budgets, logger });

  async function attempt({ owner, source, targets, context }) {
    const estimateMicroUsd = estimateTranslationReservationMicroUsd(source);
    try {
      return await budgetedCall({ owner, estimateMicroUsd, context, call: () => generator.translate({ ...source, targets }) });
    } catch (error) {
      if (!(error instanceof ListingProviderError)) throw error;
      throw error.kind === 'timeout' ? ERRORS.timeout() : ERRORS.provider();
    }
  }

  async function runAttempts({ owner, source, targets, context }) {
    const total = { tokIn: 0, tokOut: 0, costMicroUsd: 0 };
    for (let tryNumber = 1; tryNumber <= MAX_TRANSLATION_ATTEMPTS; tryNumber += 1) {
      const { result, charged } = await attempt({ owner, source, targets, context: { ...context, tryNumber } });
      total.tokIn += charged.inputTokens;
      total.tokOut += charged.outputTokens;
      total.costMicroUsd += charged.costMicroUsd;
      if (result.ok) return { output: result.translations, total };
      logger?.warn('ai output rejected', { ...context, tryNumber, reason: result.reason });
      if (result.reason === NO_RETRY_REASON) break;
    }
    throw ERRORS.invalidOutput();
  }

  /** An empty source tagline stays empty: code, not the model, decides what is shown. */
  const toRows = (output, source) =>
    Object.entries(output).map(([language, text]) => ({
      language,
      tagline: source.tagline ? text.tagline : '',
      story: text.story,
      source: 'ai',
      approved: false,
    }));

  return {
    /**
     * @param {{ store: { id: string, defaultLanguage: string, tagline: string, story: string },
     *   owner: { id: string, isDemo: boolean }, correlationId?: string }} request store and owner come from the session.
     * @returns {Promise<{ languages: string[], skipped: string[] }>} `skipped` lists languages with approved owner text, which is never replaced.
     * @throws {AppError} AI_BUDGET_EXHAUSTED, AI_BUDGET_UNAVAILABLE, AI_TIMEOUT, AI_PROVIDER_ERROR, AI_INVALID_OUTPUT.
     */
    async draft({ store, owner, correlationId }) {
      const skipped = await protectedLanguages(store.id);
      const targets = targetLanguages(store.defaultLanguage).filter((language) => !skipped.includes(language));
      if (targets.length === 0) return { languages: [], skipped };
      const source = { tagline: store.tagline, story: store.story };
      const context = { correlationId, storeId: store.id };
      const { output, total } = await runAttempts({ owner, source, targets, context });
      const recheck = await protectedLanguages(store.id);
      const rows = toRows(output, source).filter((row) => !recheck.includes(row.language));
      if (rows.length > 0) await translations.upsertMany(store.id, rows);
      logger?.info('store translations drafted', {
        ...context,
        model: generator.model,
        promptVersion: generator.promptVersion,
        tokIn: total.tokIn,
        tokOut: total.tokOut,
        costMicroUsd: total.costMicroUsd,
      });
      return { languages: rows.map((row) => row.language), skipped: skipped.concat(recheck.filter((language) => !skipped.includes(language))) };
    },
  };
}
