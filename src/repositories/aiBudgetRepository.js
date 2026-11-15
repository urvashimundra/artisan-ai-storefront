import { z } from 'zod';
import { AppError } from '../lib/errors.js';

const HTTP_INTERNAL_ERROR = 500;

const reserveResultSchema = z
  .object({
    ok: z.boolean(),
    reservation_id: z.uuid().nullish(),
    reason: z.enum(['owner_limit', 'global_limit', 'invalid']).nullish(),
  })
  .strict();
const changeResultSchema = z.object({ ok: z.boolean(), changed: z.boolean() }).strict();

function failure(operation, details) {
  return new AppError('DATABASE_ERROR', HTTP_INTERNAL_ERROR, 'Something went wrong', { operation, ...details });
}

async function callRpc(client, operation, args, schema) {
  const { data, error } = await client.rpc(operation, args);
  if (error) throw failure(operation, { pgCode: error.code });
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw failure(operation, { reason: 'unexpected_result_shape' });
  return parsed.data;
}

/**
 * AI budget persistence. Thin wrappers over the Postgres functions in migration 002; the database decides
 * the India budget day and enforces all limits atomically.
 * @param {{ client: any }} deps
 */
export function createAiBudgetRepository({ client }) {
  return {
    /**
     * @param {{ ownerId: string, amountMicroUsd: number, ownerLimitMicroUsd: number,
     *   globalLimitMicroUsd: number, ttlSeconds: number }} request
     * @returns {Promise<{ ok: boolean, reservationId: string | null, reason: string | null }>}
     */
    async reserveBudget({ ownerId, amountMicroUsd, ownerLimitMicroUsd, globalLimitMicroUsd, ttlSeconds }) {
      const result = await callRpc(
        client,
        'reserve_ai_budget',
        {
          p_owner_id: ownerId,
          p_amount: amountMicroUsd,
          p_owner_limit: ownerLimitMicroUsd,
          p_global_limit: globalLimitMicroUsd,
          p_ttl_seconds: ttlSeconds,
        },
        reserveResultSchema,
      );
      return { ok: result.ok, reservationId: result.reservation_id ?? null, reason: result.reason ?? null };
    },

    /** @param {string} reservationId @param {number} actualMicroUsd @returns {Promise<{ ok: boolean, changed: boolean }>} */
    settleBudget(reservationId, actualMicroUsd) {
      const args = { p_reservation_id: reservationId, p_actual: actualMicroUsd };
      return callRpc(client, 'settle_ai_budget', args, changeResultSchema);
    },

    /** @param {string} reservationId @returns {Promise<{ ok: boolean, changed: boolean }>} */
    releaseBudget(reservationId) {
      return callRpc(client, 'release_ai_budget', { p_reservation_id: reservationId }, changeResultSchema);
    },
  };
}
