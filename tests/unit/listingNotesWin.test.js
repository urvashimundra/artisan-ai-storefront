import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { correctionFor, findFigureMismatch } from '../../src/ai/listingFigures.js';
import { buildListingSystemPrompt, buildListingUserText } from '../../src/ai/prompts/listingV1.js';
import { createListingService } from '../../src/services/listingService.js';
import {
  GOOD_TRANSLATIONS, buildBudgetService, createFakeGenerator, createFakeImages, createFakeProducts, createLogCollector, jpegBytes,
} from '../helpers/productFakes.js';

const STORE = '11111111-1111-4111-8111-111111111111';
const OWNER = { id: '33333333-3333-4333-8333-333333333333', isDemo: false };
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const NOTES = 'Mug with a deep blue glaze and a white border. Holds 300 ml.';
const USAGE = { inputTokens: 4000, outputTokens: 900 };

const listing = (en, gu = 'ગુજરાતી શીર્ષક', hi = 'हिन्दी शीर्षक') => {
  const copy = structuredClone(GOOD_TRANSLATIONS);
  copy.en = { title: en.title, description: en.description, alt_text: en.alt };
  copy.gu = { ...copy.gu, title: gu };
  copy.hi = { ...copy.hi, title: hi };
  return { ok: true, translations: copy, usage: USAGE };
};
const withFigure = (figure) => listing({ title: 'Blue mug', description: `A deep blue glazed mug that holds ${figure}.`, alt: 'A blue mug with a white border' });

async function setup(script) {
  const products = createFakeProducts();
  const images = createFakeImages();
  const { repo, service: budgets } = buildBudgetService();
  const generator = createFakeGenerator(script);
  const logger = createLogCollector();
  const service = createListingService({ products, images, budgets, generator, logger });
  const path = `${STORE}/${PRODUCT}/55555555-5555-4555-8555-555555555555.jpg`;
  await images.upload(STORE, PRODUCT, path, jpegBytes(), 'image/jpeg');
  await products.insert(STORE, { id: PRODUCT, imagePath: path, imageContentType: 'image/jpeg' });
  const generate = (story = NOTES) => service.generate({ storeId: STORE, owner: OWNER, productId: PRODUCT, input: { story } });
  return { generate, generator, products, repo, logger };
}

describe('findFigureMismatch', () => {
  const entry = (description) => ({ en: { title: 't', description, alt_text: 'a' } });

  it('flags a figure the notes do not state, and only when the notes state any', () => {
    assert.deepEqual(findFigureMismatch(NOTES, entry('Holds 350 ml.')), [{ unit: 'ml', value: 350 }]);
    assert.deepEqual(findFigureMismatch('Deep blue glaze.', entry('Holds 350 ml.')), []);
  });

  it('accepts the notes figure in any form: another scale, Gujarati or Hindi digits and unit words', () => {
    for (const text of ['Holds 300 ml.', 'Holds 0.3 litres.', 'Holds ૩૦૦ મિલી.', 'Holds ३०० मिली.']) assert.deepEqual(findFigureMismatch(NOTES, entry(text)), [], text);
  });

  it('checks every language and every field', () => {
    const translations = { ...entry('Fine.'), gu: { title: '૩૫૦ મિલી', description: 'x', alt_text: 'y' }, hi: { title: 'x', description: 'x', alt_text: '350 मिली' } };
    assert.deepEqual(findFigureMismatch(NOTES, translations), [{ unit: 'ml', value: 350 }]);
  });

  it('names the figures in the corrective note', () => {
    assert.ok(correctionFor([{ unit: 'ml', value: 350 }]).includes('350 ml'));
  });
});

describe('listing generation: seller notes win', () => {
  it('retries once with the specific mismatch, then saves the corrected listing', async () => {
    const ctx = await setup([withFigure('350 ml'), withFigure('300 ml')]);
    const outcome = await ctx.generate();
    assert.ok(outcome.draftId);
    assert.equal(ctx.generator.calls.length, 2);
    assert.equal(ctx.generator.calls[0].correction ?? null, null);
    assert.ok(ctx.generator.calls[1].correction.includes('350 ml'));
    assert.equal(ctx.repo.calls.filter((call) => call.op === 'reserve').length, 2);
    assert.ok(ctx.products.rows[0].translations.some((row) => row.description?.includes('300 ml')));
    assert.equal(ctx.logger.entries.some((entry) => JSON.stringify(entry).includes('350')), false);
  });

  it('fails with the existing error, and saves nothing, when the retry still contradicts the notes', async () => {
    const ctx = await setup([withFigure('350 ml'), withFigure('400 ml')]);
    await assert.rejects(ctx.generate(), (error) => error.code === 'AI_INVALID_OUTPUT');
    assert.equal(ctx.generator.calls.length, 2);
    assert.equal(ctx.products.rows[0].translations.length, 0);
    assert.equal(ctx.products.rows[0].aiStatus, 'failed');
  });

  it('does not retry when the figures match, or when the notes state no figure', async () => {
    const matching = await setup([withFigure('300 ml')]);
    await matching.generate();
    assert.equal(matching.generator.calls.length, 1);
    const noFigures = await setup([withFigure('350 ml')]);
    await noFigures.generate('Mug with a deep blue glaze and a white border.');
    assert.equal(noFigures.generator.calls.length, 1);
  });
});

describe('listing prompt: notes are authoritative', () => {
  it('states that the notes win over the photo and bans contradicting colours, materials, sizes, patterns and quantities', () => {
    const system = buildListingSystemPrompt();
    assert.match(system, /AUTHORITATIVE/);
    for (const word of ['colour', 'material', 'size', 'pattern', 'quantity']) assert.ok(system.includes(word), word);
    assert.match(system, /follow the story/);
  });

  it('puts the corrective note in front of the story, only when given', () => {
    assert.ok(buildListingUserText(NOTES, 'FIX THIS').startsWith('FIX THIS'));
    assert.equal(buildListingUserText(NOTES).includes('FIX THIS'), false);
  });
});
