import { actualCostMicroUsd } from '../domain/aiCost.js';
import { detectImageType } from '../domain/imageUpload.js';
import { generateRequestSchema } from '../domain/productRules.js';
import { estimateListingReservationMicroUsd } from '../ai/listingCost.js';
import { checkListingScripts } from '../ai/scriptCheck.js';
import { AppError, notFound } from '../lib/errors.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const HTTP_BAD_GATEWAY = 502;
const HTTP_GATEWAY_TIMEOUT = 504;

/** A generation that started longer ago than this is treated as abandoned (the request died) and may be retaken. */
export const STALE_GENERATION_MS = 180_000;
/** One normal try plus one retry when the model's output fails validation. Each try reserves budget again. */
export const MAX_GENERATION_ATTEMPTS = 2;
const BUDGET_ERROR_CODES = new Set(['AI_BUDGET_EXHAUSTED', 'AI_BUDGET_UNAVAILABLE']);
const NO_RETRY_REASON = 'refused';

const ERRORS = {
  notDraft: () => new AppError('NOT_DRAFT', HTTP_CONFLICT, 'A published product cannot be regenerated. Edit its text instead.'),
  inProgress: () =>
    new AppError('GENERATION_IN_PROGRESS', HTTP_CONFLICT, 'A listing is already being written for this product. Please wait a minute, then refresh.'),
  timeout: () => new AppError('AI_TIMEOUT', HTTP_GATEWAY_TIMEOUT, 'The AI took too long to answer. Please try again.'),
  provider: () =>
    new AppError('AI_PROVIDER_ERROR', HTTP_BAD_GATEWAY, 'The AI service is not available right now. Please try again in a few minutes.'),
  invalidOutput: () =>
    new AppError('AI_INVALID_OUTPUT', HTTP_BAD_GATEWAY, 'The AI did not produce a usable listing. Please try again, or write the text yourself.'),
  superseded: () =>
    new AppError('GENERATION_SUPERSEDED', HTTP_CONFLICT, 'This listing was replaced by a newer request, so these results were not saved. Please refresh.'),
  badImage: () => new AppError('INVALID_IMAGE', HTTP_BAD_REQUEST, 'The stored photo could not be read. Please add the product again.'),
};

const SAVE_REFUSALS = {
  not_found: () => notFound('Product not found'),
  not_draft: ERRORS.notDraft,
  stale_generation: ERRORS.superseded,
  invalid: ERRORS.invalidOutput,
};

const toIso = (milliseconds) => new Date(milliseconds).toISOString();

/**
 * Orchestrates AI listing generation. Order of every request: validate the story, claim the product's generation
 * slot in the database, reserve AI budget, call Claude, settle the real cost, save through the database function.
 * Claude proposes text only; ownership, budget and the saved result are all decided by code and the database.
 * @param {{ products: object, images: object, budgets: ReturnType<typeof import('./aiBudgetService.js').createAiBudgetService>,
 *   generator: ReturnType<typeof import('../ai/listingGenerator.js').createListingGenerator>,
 *   logger?: { info: Function, warn: Function, error: Function }, now?: () => number }} deps
 */
export function createListingService({ products, images, budgets, generator, logger, now = Date.now }) {
  async function claim(storeId, productId, story) {
    const at = now();
    const claimed = await products.claimGeneration(storeId, productId, {
      story,
      nowIso: toIso(at),
      staleBeforeIso: toIso(at - STALE_GENERATION_MS),
    });
    if (claimed) return claimed;
    const existing = await products.findById(storeId, productId);
    if (!existing) throw notFound('Product not found');
    throw existing.status === 'draft' ? ERRORS.inProgress() : ERRORS.notDraft();
  }

  async function releaseQuietly(reservationId, context) {
    try {
      await budgets.release(reservationId);
    } catch {
      logger?.error('ai budget release failed; reservation will expire', { ...context, reservationId });
    }
  }

  /** Provider answered with an error status: nothing was billed, free the reservation. Otherwise let it expire (charged). */
  async function afterProviderFailure(error, reservationId, context) {
    if (error.kind === 'http') {
      await releaseQuietly(reservationId, context);
      logger?.warn('ai provider answered with an error status', { ...context, reservationId, kind: error.kind, status: error.status });
    } else logger?.warn('ai call outcome unknown; reservation left to expire', { ...context, reservationId, kind: error.kind });
    throw error.kind === 'timeout' ? ERRORS.timeout() : ERRORS.provider();
  }

  /** Settles real usage; on a settle failure the reservation expires at its reserved amount (safe direction). */
  async function settle(reservationId, usage, estimateMicroUsd, context) {
    const measured = usage ? { ...usage, costMicroUsd: actualCostMicroUsd(usage) } : null;
    const charged = measured ?? { inputTokens: 0, outputTokens: 0, costMicroUsd: estimateMicroUsd };
    if (!measured) logger?.warn('ai response had no usage; reservation left to expire', { ...context, reservationId });
    else await settleQuietly(reservationId, charged.costMicroUsd, context);
    return charged;
  }

  async function settleQuietly(reservationId, costMicroUsd, context) {
    try {
      await budgets.settle(reservationId, costMicroUsd);
    } catch {
      logger?.error('ai budget settle failed; reservation will expire', { ...context, reservationId, costMicroUsd });
    }
  }

  async function attempt({ owner, story, image, context }) {
    const estimateMicroUsd = estimateListingReservationMicroUsd(story);
    const { reservationId } = await budgets.reserve({ ownerId: owner.id, isDemo: owner.isDemo, estimateMicroUsd });
    let result;
    try {
      result = await generator.generate({ story, image });
    } catch (error) {
      return afterProviderFailure(error, reservationId, context);
    }
    return { result, charged: await settle(reservationId, result.usage, estimateMicroUsd, context) };
  }

  async function loadImage(storeId, product) {
    const bytes = await images.download(storeId, product.id, product.imagePath);
    const detected = detectImageType(bytes);
    if (!detected) throw ERRORS.badImage();
    return { mediaType: detected.contentType, data: bytes.toString('base64') };
  }

  async function runAttempts({ owner, story, image, context }) {
    const total = { tokIn: 0, tokOut: 0, costMicroUsd: 0 };
    for (let tryNumber = 1; tryNumber <= MAX_GENERATION_ATTEMPTS; tryNumber += 1) {
      const { result, charged } = await attempt({ owner, story, image, context: { ...context, tryNumber } });
      total.tokIn += charged.inputTokens;
      total.tokOut += charged.outputTokens;
      total.costMicroUsd += charged.costMicroUsd;
      if (result.ok) return { translations: result.translations, total };
      logger?.warn('ai output rejected', { ...context, tryNumber, reason: result.reason });
      if (result.reason === NO_RETRY_REASON) break;
    }
    throw ERRORS.invalidOutput();
  }

  async function persist({ storeId, productId, generationId, translations, total, context }) {
    const saved = await products.saveAiListing(storeId, productId, {
      generationId,
      translations,
      model: generator.model,
      tokensIn: total.tokIn,
      tokensOut: total.tokOut,
      costMicroUsd: total.costMicroUsd,
    });
    if (!saved.ok) throw SAVE_REFUSALS[saved.reason]();
    const needsReview = checkListingScripts(translations).needsReview;
    logger?.info('listing generated', {
      ...context,
      model: generator.model,
      promptVersion: generator.promptVersion,
      tokIn: total.tokIn,
      tokOut: total.tokOut,
      costMicroUsd: total.costMicroUsd,
      needsReview,
    });
    return { draftId: saved.draftId, needsReview };
  }

  async function endGeneration(storeId, productId, generationId, error) {
    const state = BUDGET_ERROR_CODES.has(error?.code) ? 'idle' : 'failed';
    try {
      await products.finishGeneration(storeId, productId, generationId, state);
    } catch {
      logger?.error('could not end generation state; it will be treated as stale', { storeId, productId });
    }
  }

  return {
    /**
     * Generates and saves an AI draft for one of the owner's DRAFT products.
     * @param {{ storeId: string, owner: { id: string, isDemo: boolean }, productId: string, input: unknown,
     *   correlationId?: string }} request storeId and owner come from the authenticated session, never from input.
     * @returns {Promise<{ draftId: string, needsReview: boolean }>}
     * @throws {import('zod').ZodError} Invalid story.
     * @throws {AppError} NOT_FOUND, NOT_DRAFT, GENERATION_IN_PROGRESS, AI_BUDGET_*, AI_TIMEOUT, AI_PROVIDER_ERROR,
     *   AI_INVALID_OUTPUT, GENERATION_SUPERSEDED, STORAGE_ERROR.
     */
    async generate({ storeId, owner, productId, input, correlationId }) {
      const { story } = generateRequestSchema.parse(input);
      const product = await claim(storeId, productId, story);
      const { generationId } = product;
      const context = { correlationId, storeId, productId };
      try {
        const image = await loadImage(storeId, product);
        const { translations, total } = await runAttempts({ owner, story, image, context });
        return await persist({ storeId, productId, generationId, translations, total, context });
      } catch (error) {
        await endGeneration(storeId, productId, generationId, error);
        throw error;
      }
    },
  };
}
