import { actualCostMicroUsd } from '../domain/aiCost.js';
import { ListingProviderError } from '../ai/listingGenerator.js';

/**
 * The budget protocol for one AI call, as used by the listing workflow: reserve before the call, settle on the real
 * usage after it, release when the provider answered with an error status (nothing billed), and otherwise leave the
 * reservation to expire at its reserved amount (the outcome is unknown, which is the safe direction). Reservation
 * failures propagate before the provider is ever called.
 * @param {{ budgets: ReturnType<typeof import('./aiBudgetService.js').createAiBudgetService>,
 *   logger?: { warn: Function, error: Function } }} deps
 */
export function createBudgetedCall({ budgets, logger }) {
  async function releaseQuietly(reservationId, context) {
    try {
      await budgets.release(reservationId);
    } catch {
      logger?.error('ai budget release failed; reservation will expire', { ...context, reservationId });
    }
  }

  async function afterFailure(error, reservationId, context) {
    if (error instanceof ListingProviderError && error.kind === 'http') {
      await releaseQuietly(reservationId, context);
      logger?.warn('ai provider answered with an error status', { ...context, reservationId, status: error.status });
    } else logger?.warn('ai call outcome unknown; reservation left to expire', { ...context, reservationId });
  }

  async function settleQuietly(reservationId, costMicroUsd, context) {
    try {
      await budgets.settle(reservationId, costMicroUsd);
    } catch {
      logger?.error('ai budget settle failed; reservation will expire', { ...context, reservationId, costMicroUsd });
    }
  }

  /** Settles real usage; with no usable usage the reservation expires and the estimate is recorded as the cost. */
  async function settle(reservationId, usage, estimateMicroUsd, context) {
    if (!usage) {
      logger?.warn('ai response had no usage; reservation left to expire', { ...context, reservationId });
      return { inputTokens: 0, outputTokens: 0, costMicroUsd: estimateMicroUsd };
    }
    const costMicroUsd = actualCostMicroUsd(usage);
    await settleQuietly(reservationId, costMicroUsd, context);
    return { ...usage, costMicroUsd };
  }

  /**
   * @template T
   * @param {{ owner: { id: string, isDemo: boolean }, estimateMicroUsd: number, context: object,
   *   call: () => Promise<{ usage: { inputTokens: number, outputTokens: number } | null } & T> }} request
   * @returns {Promise<{ result: T, charged: { inputTokens: number, outputTokens: number, costMicroUsd: number } }>}
   * @throws {AppError} AI_BUDGET_EXHAUSTED or AI_BUDGET_UNAVAILABLE before any provider call.
   * @throws {unknown} Whatever `call` threw, after the reservation was handled.
   */
  return async function budgetedCall({ owner, estimateMicroUsd, context, call }) {
    const { reservationId } = await budgets.reserve({ ownerId: owner.id, isDemo: owner.isDemo, estimateMicroUsd });
    let result;
    try {
      result = await call();
    } catch (error) {
      await afterFailure(error, reservationId, context);
      throw error;
    }
    return { result, charged: await settle(reservationId, result.usage, estimateMicroUsd, context) };
  };
}
