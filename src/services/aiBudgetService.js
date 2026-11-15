import { AppError } from '../lib/errors.js';

const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVICE_UNAVAILABLE = 503;
const RESERVATION_TTL_SECONDS = 180;
const EXHAUSTED_MESSAGE = "Today's AI limit has been reached. Please try again tomorrow.";
const UNAVAILABLE_MESSAGE = 'AI is temporarily unavailable. Please try again later.';

const exhausted = (details) => new AppError('AI_BUDGET_EXHAUSTED', HTTP_TOO_MANY_REQUESTS, EXHAUSTED_MESSAGE, details);
const unavailable = (details) =>
  new AppError('AI_BUDGET_UNAVAILABLE', HTTP_SERVICE_UNAVAILABLE, UNAVAILABLE_MESSAGE, details);

const isPositiveSafeInteger = (value) => Number.isSafeInteger(value) && value > 0;

async function guarded(operation, call) {
  try {
    return await call();
  } catch (error) {
    throw unavailable({ operation, cause: error?.name, details: error?.details });
  }
}

/**
 * Spending guard that every Claude call goes through. Fails closed: if the guard errors, no call is allowed.
 * @param {{ budgets: ReturnType<typeof import('../repositories/aiBudgetRepository.js').createAiBudgetRepository>,
 *   limits: { ownerMicroUsd: number, demoMicroUsd: number, globalMicroUsd: number } }} deps
 */
export function createAiBudgetService({ budgets, limits }) {
  return {
    /**
     * Reserves worst-case spend. ownerId must come from the authenticated session, never from request input.
     * @param {{ ownerId: string, isDemo: boolean, estimateMicroUsd: number }} request
     * @returns {Promise<{ reservationId: string }>}
     * @throws {AppError} AI_BUDGET_EXHAUSTED (429) or AI_BUDGET_UNAVAILABLE (503).
     */
    async reserve({ ownerId, isDemo, estimateMicroUsd }) {
      if (!ownerId || !isPositiveSafeInteger(estimateMicroUsd)) throw unavailable({ reason: 'bad_request' });
      const ownerLimit = isDemo ? limits.demoMicroUsd : limits.ownerMicroUsd;
      if (estimateMicroUsd > ownerLimit) throw exhausted({ reason: 'estimate_above_owner_limit' });
      const result = await guarded('reserve', () =>
        budgets.reserveBudget({
          ownerId,
          amountMicroUsd: estimateMicroUsd,
          ownerLimitMicroUsd: ownerLimit,
          globalLimitMicroUsd: limits.globalMicroUsd,
          ttlSeconds: RESERVATION_TTL_SECONDS,
        }),
      );
      if (result.ok && result.reservationId) return { reservationId: result.reservationId };
      if (result.reason === 'owner_limit' || result.reason === 'global_limit') throw exhausted({ reason: result.reason });
      throw unavailable({ reason: result.reason ?? 'unexpected_result' });
    },

    /**
     * Converts a reservation to actual spend. Idempotent. On failure the reservation later expires and is charged
     * at its reserved amount, which is the safe direction.
     * @param {string} reservationId @param {number} actualMicroUsd Integer micro-USD from the response usage.
     * @returns {Promise<{ changed: boolean }>}
     */
    async settle(reservationId, actualMicroUsd) {
      if (!Number.isSafeInteger(actualMicroUsd) || actualMicroUsd < 0) throw unavailable({ reason: 'bad_actual' });
      const result = await guarded('settle', () => budgets.settleBudget(reservationId, actualMicroUsd));
      if (!result.ok) throw unavailable({ reason: 'unknown_reservation' });
      return { changed: result.changed };
    },

    /**
     * Frees a reservation after a provider error with no usage. Idempotent.
     * @param {string} reservationId
     * @returns {Promise<{ changed: boolean }>}
     */
    async release(reservationId) {
      const result = await guarded('release', () => budgets.releaseBudget(reservationId));
      if (!result.ok) throw unavailable({ reason: 'unknown_reservation' });
      return { changed: result.changed };
    },
  };
}
