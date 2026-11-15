import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../../src/lib/errors.js';
import { createAiBudgetRepository } from '../../src/repositories/aiBudgetRepository.js';
import { createAiBudgetService } from '../../src/services/aiBudgetService.js';

const OWNER_ID = '3f2b8c1e-5a4d-4b7e-9c10-1d2e3f4a5b6c';
const RESERVATION_ID = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const LIMITS = { ownerMicroUsd: 1_000_000, demoMicroUsd: 500_000, globalMicroUsd: 5_000_000 };
const GENERIC_MESSAGE = "Today's AI limit has been reached. Please try again tomorrow.";

function fakeRepo(overrides = {}) {
  const calls = [];
  return {
    calls,
    async reserveBudget(request) {
      calls.push(['reserve', request]);
      return { ok: true, reservationId: RESERVATION_ID, reason: null };
    },
    async settleBudget(...args) {
      calls.push(['settle', ...args]);
      return { ok: true, changed: true };
    },
    async releaseBudget(...args) {
      calls.push(['release', ...args]);
      return { ok: true, changed: true };
    },
    ...overrides,
  };
}

const rejection = async (promise) =>
  promise.then(
    () => assert.fail('expected rejection'),
    (error) => error,
  );

const reserveRequest = (extra = {}) => ({ ownerId: OWNER_ID, isDemo: false, estimateMicroUsd: 5, ...extra });

describe('aiBudgetService.reserve', () => {
  it('uses the normal limit for a normal owner and the demo limit for a demo owner', async () => {
    const budgets = fakeRepo();
    const service = createAiBudgetService({ budgets, limits: LIMITS });
    await service.reserve(reserveRequest());
    await service.reserve(reserveRequest({ isDemo: true }));
    assert.equal(budgets.calls[0][1].ownerLimitMicroUsd, LIMITS.ownerMicroUsd);
    assert.equal(budgets.calls[1][1].ownerLimitMicroUsd, LIMITS.demoMicroUsd);
    assert.equal(budgets.calls[0][1].globalLimitMicroUsd, LIMITS.globalMicroUsd);
    assert.equal(budgets.calls[0][1].ownerId, OWNER_ID);
  });

  it('returns the reservation id when allowed', async () => {
    const service = createAiBudgetService({ budgets: fakeRepo(), limits: LIMITS });
    assert.deepEqual(await service.reserve(reserveRequest()), { reservationId: RESERVATION_ID });
  });

  it('refuses with one generic 429 message whichever cap was hit', async () => {
    for (const reason of ['owner_limit', 'global_limit']) {
      const budgets = fakeRepo({ reserveBudget: async () => ({ ok: false, reservationId: null, reason }) });
      const error = await rejection(createAiBudgetService({ budgets, limits: LIMITS }).reserve(reserveRequest()));
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'AI_BUDGET_EXHAUSTED');
      assert.equal(error.httpStatus, 429);
      assert.equal(error.message, GENERIC_MESSAGE);
    }
  });

  it('treats an estimate above the owner limit as exhausted without calling the database', async () => {
    const budgets = fakeRepo();
    const service = createAiBudgetService({ budgets, limits: LIMITS });
    const error = await rejection(service.reserve(reserveRequest({ isDemo: true, estimateMicroUsd: 500_001 })));
    assert.equal(error.code, 'AI_BUDGET_EXHAUSTED');
    assert.equal(budgets.calls.length, 0);
  });

  it('fails closed with a 503 when the repository throws, leaking nothing', async () => {
    const budgets = fakeRepo({
      reserveBudget: async () => {
        throw new Error('relation "ai_usage_daily" does not exist at 10.0.0.1');
      },
    });
    const error = await rejection(createAiBudgetService({ budgets, limits: LIMITS }).reserve(reserveRequest()));
    assert.equal(error.code, 'AI_BUDGET_UNAVAILABLE');
    assert.equal(error.httpStatus, 503);
    assert.doesNotMatch(error.message, /relation|10\.0\.0\.1|ai_usage/);
  });

  it('fails closed on an invalid reason, a missing id, or a bad estimate', async () => {
    const results = [
      { ok: false, reservationId: null, reason: 'invalid' },
      { ok: true, reservationId: null, reason: null },
    ];
    for (const result of results) {
      const budgets = fakeRepo({ reserveBudget: async () => result });
      const error = await rejection(createAiBudgetService({ budgets, limits: LIMITS }).reserve(reserveRequest()));
      assert.equal(error.code, 'AI_BUDGET_UNAVAILABLE');
    }
    const service = createAiBudgetService({ budgets: fakeRepo(), limits: LIMITS });
    for (const estimateMicroUsd of [0, -1, 1.5, NaN, '5']) {
      const error = await rejection(service.reserve(reserveRequest({ estimateMicroUsd })));
      assert.equal(error.code, 'AI_BUDGET_UNAVAILABLE');
    }
  });

  it('takes ownerId only from the caller and ignores extra request fields', async () => {
    const budgets = fakeRepo();
    const service = createAiBudgetService({ budgets, limits: LIMITS });
    await service.reserve(reserveRequest({ ownerLimitMicroUsd: 99, storeId: 'x' }));
    assert.deepEqual(Object.keys(budgets.calls[0][1]).sort(), [
      'amountMicroUsd',
      'globalLimitMicroUsd',
      'ownerId',
      'ownerLimitMicroUsd',
      'ttlSeconds',
    ]);
    assert.equal(budgets.calls[0][1].ownerLimitMicroUsd, LIMITS.ownerMicroUsd);
    const error = await rejection(service.reserve(reserveRequest({ ownerId: '' })));
    assert.equal(error.code, 'AI_BUDGET_UNAVAILABLE');
  });
});

describe('aiBudgetService.settle and release', () => {
  it('pass through to the repository and report changed', async () => {
    const budgets = fakeRepo({ releaseBudget: async () => ({ ok: true, changed: false }) });
    const service = createAiBudgetService({ budgets, limits: LIMITS });
    assert.deepEqual(await service.settle(RESERVATION_ID, 42), { changed: true });
    assert.deepEqual(await service.release(RESERVATION_ID), { changed: false });
    assert.deepEqual(budgets.calls[0], ['settle', RESERVATION_ID, 42]);
  });

  it('fail with AI_BUDGET_UNAVAILABLE on errors, unknown reservations or a bad actual', async () => {
    const budgets = fakeRepo({
      settleBudget: async () => ({ ok: false, changed: false }),
      releaseBudget: async () => {
        throw new Error('boom');
      },
    });
    const service = createAiBudgetService({ budgets, limits: LIMITS });
    assert.equal((await rejection(service.settle(RESERVATION_ID, 1))).code, 'AI_BUDGET_UNAVAILABLE');
    assert.equal((await rejection(service.release(RESERVATION_ID))).code, 'AI_BUDGET_UNAVAILABLE');
    assert.equal((await rejection(service.settle(RESERVATION_ID, -1))).code, 'AI_BUDGET_UNAVAILABLE');
  });
});

describe('aiBudgetRepository', () => {
  it('maps arguments to the rpc parameters and parses the jsonb result', async () => {
    const seen = [];
    const client = {
      async rpc(name, args) {
        seen.push([name, args]);
        return { data: { ok: true, reservation_id: RESERVATION_ID, reason: null }, error: null };
      },
    };
    const repo = createAiBudgetRepository({ client });
    const result = await repo.reserveBudget({
      ownerId: OWNER_ID,
      amountMicroUsd: 5,
      ownerLimitMicroUsd: 10,
      globalLimitMicroUsd: 20,
      ttlSeconds: 60,
    });
    assert.deepEqual(result, { ok: true, reservationId: RESERVATION_ID, reason: null });
    assert.deepEqual(seen[0], [
      'reserve_ai_budget',
      { p_owner_id: OWNER_ID, p_amount: 5, p_owner_limit: 10, p_global_limit: 20, p_ttl_seconds: 60 },
    ]);
  });

  it('turns rpc errors and malformed results into a generic AppError', async () => {
    const failing = { rpc: async () => ({ data: null, error: { code: '42883', message: 'secret sql text' } }) };
    const malformed = { rpc: async () => ({ data: { ok: 'yes', extra: 1 }, error: null }) };
    for (const client of [failing, malformed]) {
      const error = await rejection(createAiBudgetRepository({ client }).settleBudget(RESERVATION_ID, 1));
      assert.ok(error instanceof AppError);
      assert.equal(error.message, 'Something went wrong');
    }
  });
});
