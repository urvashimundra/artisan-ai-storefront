import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ListingProviderError } from '../../src/ai/listingGenerator.js';
import { STALE_GENERATION_MS, createListingService } from '../../src/services/listingService.js';
import { createProductService } from '../../src/services/productService.js';
import {
  GOOD_TRANSLATIONS,
  buildBudgetService,
  createFakeImages,
  createFakeProducts,
  createLogCollector,
  jpegBytes,
  okResult,
} from '../helpers/productFakes.js';

const STORE_A = '11111111-1111-4111-8111-111111111111';
const STORE_B = '22222222-2222-4222-8222-222222222222';
const OWNER = { id: '33333333-3333-4333-8333-333333333333', isDemo: false };
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const STORY = { story: 'Hand made blue clay pot, glazed twice.' };

/** A generator whose calls wait until the test releases them, so requests can overlap deterministically. */
function createGatedGenerator() {
  const gates = [];
  return {
    gates,
    model: 'claude-haiku-5-5',
    promptVersion: 'listing-v1',
    generate() {
      return new Promise((resolve, reject) => gates.push({ resolve, reject }));
    },
  };
}

const titled = (title) => {
  const result = okResult();
  result.translations.en = { ...GOOD_TRANSLATIONS.en, title };
  return result;
};

async function setup() {
  const products = createFakeProducts();
  const images = createFakeImages();
  const generator = createGatedGenerator();
  const { service: budgets } = buildBudgetService();
  let clock = Date.now();
  const listings = createListingService({ products, images, budgets, generator, logger: createLogCollector(), now: () => clock });
  const productService = createProductService({ products, images, logger: createLogCollector() });
  const path = `${STORE_A}/${PRODUCT}/55555555-5555-4555-8555-555555555555.jpg`;
  await images.upload(STORE_A, PRODUCT, path, jpegBytes(), 'image/jpeg');
  await products.insert(STORE_A, { id: PRODUCT, imagePath: path, imageContentType: 'image/jpeg' });
  const generate = (overrides = {}) => listings.generate({ storeId: STORE_A, owner: OWNER, productId: PRODUCT, input: STORY, ...overrides });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { products, generator, generate, productService, flush, advance: (ms) => (clock += ms) };
}

const reviewForm = (overrides = {}) => ({
  story: 'Owner story.', price: '250', stock: '4', intent: 'save',
  title_en: 'Owner title', description_en: 'Owner description.', alt_text_en: 'Owner alt.',
  title_gu: '', description_gu: '', alt_text_gu: '', title_hi: '', description_hi: '', alt_text_hi: '',
  approved_en: 'on', ...overrides,
});

describe('generation fencing token: claims', () => {
  it('two simultaneous claims cannot both own the product, and each success gets a fresh token', async () => {
    const { products } = await setup();
    const claim = () => products.claimGeneration(STORE_A, PRODUCT, { story: 's', nowIso: new Date().toISOString(), staleBeforeIso: '2000-01-01T00:00:00.000Z' });
    const [first, second] = await Promise.all([claim(), claim()]);
    assert.equal([first, second].filter(Boolean).length, 1);
    const winner = first ?? second;
    assert.match(winner.generationId, /^[0-9a-f-]{36}$/);
    await products.finishGeneration(STORE_A, PRODUCT, winner.generationId, 'failed');
    const next = await claim();
    assert.notEqual(next.generationId, winner.generationId);
  });

  it('never exposes the token through reads', async () => {
    const { products } = await setup();
    await products.claimGeneration(STORE_A, PRODUCT, { story: 's', nowIso: new Date().toISOString(), staleBeforeIso: '2000-01-01T00:00:00.000Z' });
    assert.equal('generationId' in (await products.findById(STORE_A, PRODUCT)), false);
    assert.equal('aiGenerationId' in (await products.findById(STORE_A, PRODUCT)), false);
  });
});

describe('generation fencing token: stale requests', () => {
  it('a stale request cannot save translations over a newer generation', async () => {
    const ctx = await setup();
    const first = ctx.generate();
    first.catch(() => {});
    await ctx.flush();
    ctx.advance(STALE_GENERATION_MS + 1000);
    const second = ctx.generate();
    await ctx.flush();
    assert.equal(ctx.generator.gates.length, 2);
    ctx.generator.gates[1].resolve(titled('Second title'));
    await second;
    ctx.generator.gates[0].resolve(titled('First title'));
    await assert.rejects(first, { code: 'GENERATION_SUPERSEDED', httpStatus: 409 });
    const row = ctx.products.rows[0];
    assert.equal(row.translations.find((t) => t.language === 'en').title, 'Second title');
    assert.equal(ctx.products.draftRows.length, 1);
  });

  it('a stale request cannot finish or clear a newer generation', async () => {
    const ctx = await setup();
    const first = ctx.generate();
    first.catch(() => {});
    await ctx.flush();
    ctx.advance(STALE_GENERATION_MS + 1000);
    const second = ctx.generate();
    await ctx.flush();
    ctx.generator.gates[0].reject(new ListingProviderError('http', 500));
    await assert.rejects(first, { code: 'AI_PROVIDER_ERROR' });
    assert.equal(ctx.products.rows[0].aiStatus, 'generating');
    ctx.generator.gates[1].resolve(titled('Second title'));
    await second;
    assert.equal(ctx.products.rows[0].translations.find((t) => t.language === 'en').title, 'Second title');
    assert.equal(ctx.products.rows[0].aiStatus, 'idle');
  });

  it('a request whose token is missing or unknown is refused without writes', async () => {
    const { products } = await setup();
    await products.claimGeneration(STORE_A, PRODUCT, { story: 's', nowIso: new Date().toISOString(), staleBeforeIso: '2000-01-01T00:00:00.000Z' });
    const input = { translations: GOOD_TRANSLATIONS, model: 'm', tokensIn: 1, tokensOut: 1, costMicroUsd: 1 };
    for (const generationId of [undefined, null, '', '99999999-9999-4999-8999-999999999999']) {
      assert.deepEqual(await products.saveAiListing(STORE_A, PRODUCT, { ...input, generationId }), { ok: false, reason: 'stale_generation' });
    }
    assert.equal(products.rows[0].translations.length, 0);
    assert.equal(products.draftRows.length, 0);
  });
});

describe('generation fencing token: review during generation', () => {
  it('rejects a manual review while generating and changes nothing', async () => {
    const ctx = await setup();
    const running = ctx.generate();
    running.catch(() => {});
    await ctx.flush();
    const before = structuredClone(ctx.products.rows[0]);
    await assert.rejects(ctx.productService.saveReview(STORE_A, PRODUCT, reviewForm()), { code: 'GENERATION_IN_PROGRESS', httpStatus: 409 });
    assert.deepEqual(ctx.products.rows[0], before);
    ctx.generator.gates[0].resolve(titled('Generated title'));
    await running;
  });

  it('accepts the review after the generation completes', async () => {
    const ctx = await setup();
    const running = ctx.generate();
    await ctx.flush();
    ctx.generator.gates[0].resolve(titled('Generated title'));
    await running;
    assert.deepEqual(await ctx.productService.saveReview(STORE_A, PRODUCT, reviewForm()), { status: 'draft' });
    const row = ctx.products.rows[0];
    assert.equal(row.story, 'Owner story.');
    assert.equal(row.stock, 4);
    assert.equal(row.pricePaise, 25000);
  });

  it('accepts the review after a failed generation and after an abandoned one', async () => {
    const ctx = await setup();
    const running = ctx.generate();
    running.catch(() => {});
    await ctx.flush();
    ctx.generator.gates[0].reject(new ListingProviderError('http', 500));
    await assert.rejects(running);
    await ctx.productService.saveReview(STORE_A, PRODUCT, reviewForm());
    ctx.products.rows[0].aiStatus = 'generating';
    ctx.products.rows[0].aiStartedAt = new Date(Date.now() - STALE_GENERATION_MS - 1000).toISOString();
    await ctx.productService.saveReview(STORE_A, PRODUCT, reviewForm({ story: 'Second story.' }));
    assert.equal(ctx.products.rows[0].story, 'Second story.');
    assert.equal(ctx.products.rows[0].aiStatus, 'idle');
  });

  it('accepts a manual review when a generating product has a NULL timestamp and invalidates its token', async () => {
    const ctx = await setup();
    const generationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    Object.assign(ctx.products.rows[0], {
      aiStatus: 'generating',
      aiStartedAt: null,
      aiGenerationId: generationId,
    });

    await ctx.productService.saveReview(STORE_A, PRODUCT, reviewForm());

    const row = ctx.products.rows[0];
    assert.equal(row.story, 'Owner story.');
    assert.equal(row.stock, 4);
    assert.equal(row.pricePaise, 25000);
    assert.equal(row.translations.find((translation) => translation.language === 'en').title, 'Owner title');
    assert.equal(row.aiStatus, 'idle');
    assert.equal(row.aiStartedAt, null);
    assert.equal(row.aiGenerationId, null);
    assert.deepEqual(
      await ctx.products.saveAiListing(STORE_A, PRODUCT, {
        generationId,
        translations: GOOD_TRANSLATIONS,
        model: 'm',
        tokensIn: 1,
        tokensOut: 1,
        costMicroUsd: 1,
      }),
      { ok: false, reason: 'stale_generation' },
    );
  });

  it('rejects saving an already-published product without default-language approval', async () => {
    const ctx = await setup();
    Object.assign(ctx.products.rows[0], {
      status: 'published',
      pricePaise: 25000,
      story: 'Previously published story.',
      stock: 5,
      translations: [{
        language: 'en',
        title: 'Previously published title',
        description: 'Previously published description.',
        altText: 'Previously published alt.',
        source: 'owner',
        approved: true,
      }],
    });
    const before = structuredClone(ctx.products.rows[0]);

    await assert.rejects(
      ctx.productService.saveReview(STORE_A, PRODUCT, reviewForm({ approved_en: undefined, intent: 'save' })),
      { code: 'DEFAULT_LANGUAGE_NOT_APPROVED' },
    );

    assert.deepEqual(ctx.products.rows[0], before);
  });

  it('a refused review (publish without price) leaves story and stock untouched', async () => {
    const ctx = await setup();
    await assert.rejects(ctx.productService.saveReview(STORE_A, PRODUCT, reviewForm({ intent: 'publish', approved_en: undefined })), { code: 'DEFAULT_LANGUAGE_NOT_APPROVED' });
    assert.equal(ctx.products.rows[0].story, '');
    assert.equal(ctx.products.rows[0].stock, null);
  });
});

describe('generation fencing token: deletion and ownership', () => {
  it('deleting the product during generation invalidates the token: nothing is saved and nothing crashes', async () => {
    const ctx = await setup();
    const running = ctx.generate();
    running.catch(() => {});
    await ctx.flush();
    await ctx.productService.remove(STORE_A, PRODUCT);
    ctx.generator.gates[0].resolve(titled('Late title'));
    await assert.rejects(running, { code: 'NOT_FOUND' });
    assert.equal(ctx.products.rows.length, 0);
    assert.equal(ctx.products.draftRows.length, 0);
  });

  it("another store's product stays 404 for generation and review, and its generation state is untouched", async () => {
    const ctx = await setup();
    await assert.rejects(ctx.generate({ storeId: STORE_B }), { code: 'NOT_FOUND' });
    await assert.rejects(ctx.productService.saveReview(STORE_B, PRODUCT, reviewForm()), { code: 'NOT_FOUND' });
    assert.equal(ctx.products.rows[0].aiStatus, 'idle');
    assert.equal(ctx.products.rows[0].story, '');
  });
});
