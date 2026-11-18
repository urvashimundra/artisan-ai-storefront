import { estimateTranslationReservationMicroUsd } from '../ai/translationCost.js';
import { ListingProviderError } from '../ai/listingGenerator.js';
import { LANGUAGES } from '../domain/storeRules.js';
import { AppError, notFound } from '../lib/errors.js';
import { createBudgetedCall } from './budgetedCall.js';

const HTTP_BAD_GATEWAY = 502;
const HTTP_CONFLICT = 409;
const HTTP_GATEWAY_TIMEOUT = 504;
const HTTP_UNPROCESSABLE = 422;

/** One normal try plus one retry when the model's output fails validation. Each try reserves budget again. */
export const MAX_PRODUCT_TRANSLATION_ATTEMPTS = 2;
const NO_RETRY_REASON = 'refused';

const ERRORS = {
  timeout: () => new AppError('AI_TIMEOUT', HTTP_GATEWAY_TIMEOUT, 'The AI took too long to answer. Your text was not changed. Please try again.'),
  provider: () => new AppError('AI_PROVIDER_ERROR', HTTP_BAD_GATEWAY, 'The AI service is not available right now. Your text was not changed. Please try again in a few minutes.'),
  invalidOutput: () => new AppError('AI_INVALID_OUTPUT', HTTP_BAD_GATEWAY, 'The AI did not produce usable translations. Your text was not changed. Please try again, or write them yourself.'),
  nothingToTranslate: (languageName) =>
    new AppError('NOTHING_TO_TRANSLATE', HTTP_UNPROCESSABLE, `Write the ${languageName} title and description first, then update the other languages.`),
  generating: () => new AppError('GENERATION_IN_PROGRESS', HTTP_CONFLICT, 'A listing is being written for this product. Please wait a minute, then try again.'),
  invalid: () => new AppError('AI_INVALID_OUTPUT', HTTP_BAD_GATEWAY, 'The translations could not be saved. Your text was not changed.'),
};

const SAVE_REFUSALS = { not_found: () => notFound('Product not found'), generating: ERRORS.generating, invalid: ERRORS.invalid };

/**
 * "Update other languages from my edits": translates the owner's CURRENT default-language title and description (text only, no photo)
 * into the other languages and saves them as unapproved AI drafts. Claude only proposes: a draft is never public until the owner approves
 * it, and a language whose approved text the owner wrote is never replaced. The store and owner come from the session. A failure at any
 * step leaves every existing text exactly as it was.
 * @param {{ products: { findById: Function, saveTranslationDrafts: Function }, budgets: object,
 *   generator: ReturnType<typeof import('../ai/productTranslationGenerator.js').createProductTranslationGenerator>,
 *   languageNames: Record<string, string>, logger?: { info: Function, warn: Function, error: Function } }} deps
 */
export function createProductTranslationService({ products, budgets, generator, languageNames, logger }) {
  const budgetedCall = createBudgetedCall({ budgets, logger });

  async function attempt({ owner, source, targets, context }) {
    const estimateMicroUsd = estimateTranslationReservationMicroUsd({ tagline: source.title, story: source.description });
    try {
      return await budgetedCall({ owner, estimateMicroUsd, context, call: () => generator.translate({ ...source, targets }) });
    } catch (error) {
      if (!(error instanceof ListingProviderError)) throw error;
      throw error.kind === 'timeout' ? ERRORS.timeout() : ERRORS.provider();
    }
  }

  async function runAttempts({ owner, source, targets, context }) {
    const total = { tokIn: 0, tokOut: 0, costMicroUsd: 0 };
    for (let tryNumber = 1; tryNumber <= MAX_PRODUCT_TRANSLATION_ATTEMPTS; tryNumber += 1) {
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

  /** Target languages (never the default one) holding text the owner wrote AND approved: a draft must never replace it. */
  const protectedLanguages = (translations, defaultLanguage) =>
    translations.filter((row) => row.language !== defaultLanguage && row.approved && row.source === 'owner').map((row) => row.language);

  return {
    /**
     * @param {{ store: { id: string, defaultLanguage: string }, owner: { id: string, isDemo: boolean }, productId: string,
     *   correlationId?: string }} request store and owner come from the session, never from input.
     * @returns {Promise<{ languages: string[], skipped: string[] }>} `skipped` lists languages with approved owner text, which is never replaced.
     * @throws {AppError} NOT_FOUND, NOTHING_TO_TRANSLATE, GENERATION_IN_PROGRESS, AI_BUDGET_EXHAUSTED, AI_BUDGET_UNAVAILABLE, AI_TIMEOUT, AI_PROVIDER_ERROR, AI_INVALID_OUTPUT.
     */
    async update({ store, owner, productId, correlationId }) {
      const product = await products.findById(store.id, productId);
      if (!product) throw notFound('Product not found');
      const source = product.translations.find((row) => row.language === store.defaultLanguage);
      if (!source?.title.trim() || !source.description.trim()) throw ERRORS.nothingToTranslate(languageNames[store.defaultLanguage]);
      const skipped = protectedLanguages(product.translations, store.defaultLanguage);
      const targets = LANGUAGES.filter((language) => language !== store.defaultLanguage && !skipped.includes(language));
      if (targets.length === 0) return { languages: [], skipped };
      const context = { correlationId, storeId: store.id, productId };
      const { output, total } = await runAttempts({ owner, source: { title: source.title, description: source.description }, targets, context });
      const saved = await products.saveTranslationDrafts(store.id, productId, output);
      if (!saved.ok) throw SAVE_REFUSALS[saved.reason]();
      logger?.info('product translations drafted', {
        ...context, model: generator.model, promptVersion: generator.promptVersion, tokIn: total.tokIn, tokOut: total.tokOut, costMicroUsd: total.costMicroUsd,
      });
      return { languages: saved.saved, skipped: [...new Set([...skipped, ...saved.skipped])] };
    },
  };
}
