import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ZodError } from 'zod';
import { actualCostMicroUsd } from '../../src/domain/aiCost.js';
import { ListingProviderError } from '../../src/ai/listingGenerator.js';
import { MAX_GENERATION_ATTEMPTS, STALE_GENERATION_MS, createListingService } from '../../src/services/listingService.js';
import {
  GOOD_TRANSLATIONS,
  buildBudgetService,
  createFakeGenerator,
  createFakeImages,
  createFakeProducts,
  createLogCollector,
  invalidResult,
  jpegBytes,
  okResult,
} from '../helpers/productFakes.js';

const STORE_A = '11111111-1111-4111-8111-111111111111';
const STORE_B = '22222222-2222-4222-8222-222222222222';
const OWNER = { id: '33333333-3333-4333-8333-333333333333', isDemo: false };
const STORY = { story: 'Hand made blue clay pot, glazed twice.' };

async function setup({ script, budgetOptions, limits } = {}) {
  const products = createFakeProducts();
  const images = createFakeImages();
  const logger = createLogCollector();
  const { repo, service: budgets } = buildBudgetService(budgetOptions, limits);
  const generator = createFakeGenerator(script ?? [okResult()]);
  let clock = Date.now();
  const service = createListingService({ products, images, budgets, generator, logger, now: () => clock });
  const path = `${STORE_A}/44444444-4444-4444-8444-444444444444/55555555-5555-4555-8555-555555555555.jpg`;
  const productId = '44444444-4444-4444-8444-444444444444';
  await images.upload(STORE_A, productId, path, jpegBytes(), 'image/jpeg');
  await products.insert(STORE_A, { id: productId, imagePath: path, imageContentType: 'image/jpeg' });
  const generate = (overrides = {}) => service.generate({ storeId: STORE_A, owner: OWNER, productId, input: STORY, ...overrides });
  return { products, images, logger, repo, generator, generate, productId, advance: (ms) => (clock += ms) };
}

describe('listing generation: success path', () => {
  it('reserves budget before calling Claude, settles real cost, saves an unapproved AI draft and audit row', async () => {
    const ctx = await setup();
    const order = [];
    const realGenerate = ctx.generator.generate.bind(ctx.generator);
    ctx.generator.generate = async (input) => (order.push(...ctx.repo.calls.map((c) => c.op), 'claude'), realGenerate(input));
    const outcome = await ctx.generate();
    assert.deepEqual(order, ['reserve', 'claude']);
    const cost = actualCostMicroUsd({ inputTokens: 4000, outputTokens: 900 });
    assert.deepEqual(ctx.repo.calls.map((c) => c.op), ['reserve', 'settle']);
    assert.equal(ctx.repo.calls[1].actualMicroUsd, cost);
    const row = ctx.products.rows[0];
    assert.ok(row.translations.length === 3 && row.translations.every((t) => t.source === 'ai' && !t.approved));
    assert.equal(row.status, 'draft');
    assert.equal(row.story, STORY.story);
    assert.equal(row.aiStatus, 'idle');
    assert.deepEqual(ctx.products.draftRows[0], { id: outcome.draftId, storeId: STORE_A, productId: ctx.productId, model: 'claude-haiku-5-5', tokensIn: 4000, tokensOut: 900, costMicroUsd: cost });
    assert.equal(outcome.needsReview, false);
    assert.equal(ctx.generator.calls[0].image.mediaType, 'image/jpeg');
  });

  it('never leaks the story into logs and logs model, usage, cost and correlation id', async () => {
    const ctx = await setup();
    await ctx.generate({ correlationId: 'corr-1' });
    const line = ctx.logger.entries.find((entry) => entry.message === 'listing generated');
    assert.equal(line.correlationId, 'corr-1');
    assert.equal(line.model, 'claude-haiku-5-5');
    assert.ok(line.costMicroUsd > 0 && line.tokIn === 4000);
    assert.doesNotMatch(JSON.stringify(ctx.logger.entries), /blue clay pot/i);
  });

  it('flags needsReview when a language is in the wrong script', async () => {
    const wrong = okResult();
    wrong.translations.gu = { ...GOOD_TRANSLATIONS.en };
    const ctx = await setup({ script: [wrong] });
    assert.equal((await ctx.generate()).needsReview, true);
  });

  it('uses the demo budget for a demo owner', async () => {
    const ctx = await setup({ limits: { ownerMicroUsd: 1_000_000, demoMicroUsd: 1, globalMicroUsd: 5_000_000 } });
    await assert.rejects(ctx.generate({ owner: { ...OWNER, isDemo: true } }), { code: 'AI_BUDGET_EXHAUSTED' });
    assert.equal(ctx.generator.calls.length, 0);
  });
});

describe('listing generation: budget', () => {
  it('never calls Claude when the reservation is refused, and returns the product to idle', async () => {
    const ctx = await setup({ budgetOptions: { ownerRemaining: 0 } });
    await assert.rejects(ctx.generate(), { code: 'AI_BUDGET_EXHAUSTED', httpStatus: 429 });
    assert.equal(ctx.generator.calls.length, 0);
    assert.equal(ctx.products.rows[0].aiStatus, 'idle');
  });

  it('fails closed when the budget database errors', async () => {
    const ctx = await setup();
    ctx.repo.reserveBudget = async () => { throw new Error('down'); };
    await assert.rejects(ctx.generate(), { code: 'AI_BUDGET_UNAVAILABLE' });
    assert.equal(ctx.generator.calls.length, 0);
  });

  it('releases the reservation when the provider answers with an error status', async () => {
    const ctx = await setup({ script: [new ListingProviderError('http', 529)] });
    await assert.rejects(ctx.generate(), { code: 'AI_PROVIDER_ERROR' });
    assert.deepEqual(ctx.repo.calls.map((c) => c.op), ['reserve', 'release']);
    assert.equal(ctx.products.rows[0].aiStatus, 'failed');
    assert.equal(ctx.products.rows[0].translations.length, 0);
  });

  it('on a timeout leaves the reservation to expire (charged), because the call may have been billed', async () => {
    const ctx = await setup({ script: [new ListingProviderError('timeout')] });
    await assert.rejects(ctx.generate(), { code: 'AI_TIMEOUT', httpStatus: 504 });
    assert.deepEqual(ctx.repo.calls.map((c) => c.op), ['reserve']);
    assert.equal(ctx.products.rows[0].aiStatus, 'failed');
    assert.ok(ctx.logger.entries.some((e) => /outcome unknown/.test(e.message)));
  });

  it('still saves the listing when settlement fails, and logs the reservation and cost for audit', async () => {
    const ctx = await setup({ budgetOptions: { failSettle: true } });
    await ctx.generate();
    assert.equal(ctx.products.rows[0].translations.length, 3);
    const line = ctx.logger.entries.find((e) => /settle failed/.test(e.message));
    assert.ok(line.reservationId && line.costMicroUsd > 0);
    assert.equal(ctx.products.draftRows[0].costMicroUsd, line.costMicroUsd);
  });

  it('survives a failed release and still reports the provider error', async () => {
    const ctx = await setup({ script: [new ListingProviderError('http', 500)], budgetOptions: { failRelease: true } });
    await assert.rejects(ctx.generate(), { code: 'AI_PROVIDER_ERROR' });
    assert.ok(ctx.logger.entries.some((e) => /release failed/.test(e.message)));
  });

  it('without usage in the response, charges the reserved estimate to the audit row and leaves the reservation to expire', async () => {
    const ctx = await setup({ script: [{ ...okResult(), usage: null }] });
    await ctx.generate();
    assert.deepEqual(ctx.repo.calls.map((c) => c.op), ['reserve']);
    assert.equal(ctx.products.draftRows[0].costMicroUsd, ctx.repo.calls[0].amountMicroUsd);
  });
});

describe('listing generation: model output', () => {
  it('retries once on invalid output with a fresh reservation, and records the combined cost', async () => {
    const ctx = await setup({ script: [invalidResult(), okResult()] });
    await ctx.generate();
    assert.deepEqual(ctx.repo.calls.map((c) => c.op), ['reserve', 'settle', 'reserve', 'settle']);
    assert.equal(ctx.generator.calls.length, MAX_GENERATION_ATTEMPTS);
    assert.equal(ctx.products.draftRows[0].tokensOut, 300 + 900);
    assert.equal(ctx.products.draftRows[0].costMicroUsd, actualCostMicroUsd({ inputTokens: 4000, outputTokens: 300 }) + actualCostMicroUsd({ inputTokens: 4000, outputTokens: 900 }));
  });

  it('escalates to the owner after the second invalid output and saves nothing', async () => {
    const ctx = await setup({ script: [invalidResult(), invalidResult()] });
    await assert.rejects(ctx.generate(), { code: 'AI_INVALID_OUTPUT' });
    assert.equal(ctx.products.rows[0].translations.length, 0);
    assert.equal(ctx.products.draftRows.length, 0);
    assert.equal(ctx.products.rows[0].aiStatus, 'failed');
    assert.equal(ctx.repo.calls.filter((c) => c.op === 'settle').length, 2);
  });

  it('does not retry a refusal', async () => {
    const ctx = await setup({ script: [{ ok: false, reason: 'refused', usage: { inputTokens: 100, outputTokens: 5 } }] });
    await assert.rejects(ctx.generate(), { code: 'AI_INVALID_OUTPUT' });
    assert.equal(ctx.generator.calls.length, 1);
  });

  it('rejects a bad story before claiming, reserving or calling anything', async () => {
    const ctx = await setup();
    for (const input of [{ story: '' }, { story: '   ' }, { story: 'x'.repeat(1501) }, { story: 'ok', store_id: STORE_B }, {}]) {
      await assert.rejects(ctx.generate({ input }), (error) => error instanceof ZodError);
    }
    assert.equal(ctx.repo.calls.length, 0);
    assert.equal(ctx.products.rows[0].aiStatus, 'idle');
  });
});

describe('listing generation: concurrency and ownership', () => {
  it('lets only one of two simultaneous generations run; the other gets 409 and spends nothing', async () => {
    const ctx = await setup();
    const results = await Promise.allSettled([ctx.generate(), ctx.generate()]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const rejected = results.find((r) => r.status === 'rejected');
    assert.equal(rejected.reason.code, 'GENERATION_IN_PROGRESS');
    assert.equal(ctx.generator.calls.length, 1);
    assert.equal(ctx.repo.calls.filter((c) => c.op === 'reserve').length, 1);
  });

  it('takes over a stale generation but not a fresh one', async () => {
    const ctx = await setup();
    ctx.products.rows[0].aiStatus = 'generating';
    ctx.products.rows[0].aiStartedAt = new Date().toISOString();
    await assert.rejects(ctx.generate(), { code: 'GENERATION_IN_PROGRESS' });
    ctx.advance(STALE_GENERATION_MS + 1000);
    await ctx.generate();
    assert.equal(ctx.products.rows[0].translations.length, 3);
  });

  it('can generate again after a failure', async () => {
    const ctx = await setup({ script: [new ListingProviderError('http', 500), okResult()] });
    await assert.rejects(ctx.generate(), { code: 'AI_PROVIDER_ERROR' });
    await ctx.generate();
    assert.equal(ctx.products.rows[0].translations.length, 3);
  });

  it('refuses a published product', async () => {
    const ctx = await setup();
    ctx.products.rows[0].status = 'published';
    await assert.rejects(ctx.generate(), { code: 'NOT_DRAFT' });
    assert.equal(ctx.generator.calls.length, 0);
  });

  it("treats another store's product as not found and spends nothing", async () => {
    const ctx = await setup();
    await assert.rejects(ctx.generate({ storeId: STORE_B }), { code: 'NOT_FOUND' });
    assert.equal(ctx.repo.calls.length, 0);
    assert.equal(ctx.products.rows[0].aiStatus, 'idle');
  });

  it('a storage failure while loading the photo ends the generation without spending', async () => {
    const ctx = await setup();
    ctx.images.failures.download = true;
    await assert.rejects(ctx.generate(), { code: 'STORAGE_ERROR' });
    assert.equal(ctx.repo.calls.length, 0);
    assert.equal(ctx.products.rows[0].aiStatus, 'failed');
  });

  it('product deleted during generation: save reports not found and nothing is left behind', async () => {
    const ctx = await setup();
    const realGenerate = ctx.generator.generate.bind(ctx.generator);
    ctx.generator.generate = async (input) => (ctx.products.rows.splice(0), realGenerate(input));
    await assert.rejects(ctx.generate(), { code: 'NOT_FOUND' });
    assert.equal(ctx.products.draftRows.length, 0);
  });
});
