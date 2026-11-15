import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ZodError } from 'zod';
import { MAX_IMAGE_BYTES } from '../../src/domain/imageUpload.js';
import { ListingProviderError } from '../../src/ai/listingGenerator.js';
import { createProductService } from '../../src/services/productService.js';
import { GOOD_TRANSLATIONS, createFakeImages, createFakeProducts, createLogCollector, jpegBytes } from '../helpers/productFakes.js';

const STORE_A = '11111111-1111-4111-8111-111111111111';
const STORE_B = '22222222-2222-4222-8222-222222222222';

function setup() {
  const products = createFakeProducts();
  const images = createFakeImages();
  const logger = createLogCollector();
  const service = createProductService({ products, images, logger });
  return { products, images, logger, service };
}

const reviewForm = (overrides = {}) => ({
  story: 'A pot.', price: '499.50', stock: '3', intent: 'save',
  title_en: 'Pot', description_en: 'A pot.', alt_text_en: 'A pot.',
  title_gu: '', description_gu: '', alt_text_gu: '',
  title_hi: '', description_hi: '', alt_text_hi: '',
  approved_en: 'on', ...overrides,
});

async function seedProduct(service, storeId = STORE_A) {
  return (await service.createFromImage(storeId, jpegBytes())).id;
}

describe('photo upload', () => {
  it('stores a valid JPEG privately under the store and product prefix and creates a draft product', async () => {
    const { service, products, images } = setup();
    const { id } = await service.createFromImage(STORE_A, jpegBytes());
    const [path] = [...images.objects.keys()];
    assert.match(path, new RegExp(`^${STORE_A}/${id}/[0-9a-f-]{36}\\.jpg$`));
    assert.equal(images.objects.get(path).contentType, 'image/jpeg');
    assert.equal(products.rows[0].status, 'draft');
    assert.equal(products.rows[0].imagePath, path);
  });

  it('rejects non-image bytes, truncated files, empty bodies and oversize bodies without touching storage or the database', async () => {
    const { service, products, images } = setup();
    const cases = [
      [Buffer.from('<html>not an image at all, just text pretending</html>'), 'INVALID_IMAGE', 415],
      [jpegBytes().subarray(0, 40), 'INVALID_IMAGE', 415],
      [Buffer.alloc(0), 'INVALID_IMAGE', 400],
      [{}, 'INVALID_IMAGE', 400],
      [Buffer.concat([jpegBytes(), Buffer.alloc(MAX_IMAGE_BYTES)]), 'IMAGE_TOO_LARGE', 413],
    ];
    for (const [body, code, status] of cases) {
      await assert.rejects(service.createFromImage(STORE_A, body), (error) => error.code === code && error.httpStatus === status);
    }
    assert.equal(images.objects.size, 0);
    assert.equal(products.rows.length, 0);
  });

  it('a storage failure creates no product and leaves no object', async () => {
    const { service, products, images } = setup();
    images.failures.upload = true;
    await assert.rejects(service.createFromImage(STORE_A, jpegBytes()), { code: 'STORAGE_ERROR' });
    assert.equal(products.rows.length, 0);
    assert.equal(images.objects.size, 0);
  });

  it('a failed product insert removes the uploaded object', async () => {
    const { service, products, images } = setup();
    products.failures.insert = true;
    await assert.rejects(service.createFromImage(STORE_A, jpegBytes()), { code: 'DATABASE_ERROR' });
    assert.equal(images.objects.size, 0);
  });

  it('logs, but does not hide the original error, when cleanup also fails', async () => {
    const { service, products, images, logger } = setup();
    products.failures.insert = true;
    images.failures.remove = true;
    await assert.rejects(service.createFromImage(STORE_A, jpegBytes()), { code: 'DATABASE_ERROR' });
    assert.ok(logger.entries.some((entry) => entry.level === 'error' && /cleanup failed/.test(entry.message)));
  });
});

describe('ownership', () => {
  it('another store cannot read, edit, save or delete a product, and gets 404 every time', async () => {
    const { service, products } = setup();
    const id = await seedProduct(service, STORE_A);
    await assert.rejects(service.getForEdit(STORE_B, id), { code: 'NOT_FOUND' });
    await assert.rejects(service.saveReview(STORE_B, id, reviewForm()), { code: 'NOT_FOUND' });
    await assert.rejects(service.remove(STORE_B, id), { code: 'NOT_FOUND' });
    assert.equal(products.rows.length, 1);
    assert.equal(products.rows[0].story, '');
    assert.deepEqual(await service.list(STORE_B), []);
  });
});

describe('review, approval and publishing', () => {
  it('saves a draft with price in paise and stock, and reports the database status', async () => {
    const { service, products } = setup();
    const id = await seedProduct(service);
    assert.deepEqual(await service.saveReview(STORE_A, id, reviewForm()), { status: 'draft' });
    assert.equal(products.rows[0].pricePaise, 49950);
    assert.equal(products.rows[0].stock, 3);
    assert.equal(products.rows[0].translations.find((t) => t.language === 'en').approved, true);
  });

  it('publishes only with a price and an approved default language, and says so otherwise', async () => {
    const { service, products } = setup();
    const id = await seedProduct(service);
    await assert.rejects(service.saveReview(STORE_A, id, reviewForm({ intent: 'publish', price: '' })), (error) => error instanceof ZodError);
    await assert.rejects(service.saveReview(STORE_A, id, reviewForm({ intent: 'publish', approved_en: undefined })), { code: 'DEFAULT_LANGUAGE_NOT_APPROVED' });
    assert.equal(products.rows[0].status, 'draft');
    assert.deepEqual(await service.saveReview(STORE_A, id, reviewForm({ intent: 'publish' })), { status: 'published' });
    assert.equal(products.rows[0].status, 'published');
  });

  it('refuses to approve an incomplete language and rejects unknown keys such as store_id or status', async () => {
    const { service } = setup();
    const id = await seedProduct(service);
    await assert.rejects(service.saveReview(STORE_A, id, reviewForm({ approved_gu: 'on' })), (error) => error instanceof ZodError);
    for (const extra of [{ store_id: STORE_B }, { status: 'published' }, { is_demo: 'true' }]) {
      await assert.rejects(service.saveReview(STORE_A, id, reviewForm(extra)), (error) => error instanceof ZodError);
    }
  });

  it('marks edited AI text as owner text and clears approval on languages left unchecked', async () => {
    const { service, products } = setup();
    const id = await seedProduct(service);
    products.rows[0].translations = Object.entries(GOOD_TRANSLATIONS).map(([language, t]) => ({
      language, title: t.title, description: t.description, altText: t.alt_text, source: 'ai', approved: true,
    }));
    const form = reviewForm({ title_en: GOOD_TRANSLATIONS.en.title, description_en: 'Edited by the owner.', alt_text_en: GOOD_TRANSLATIONS.en.alt_text });
    await service.saveReview(STORE_A, id, form);
    const byLanguage = Object.fromEntries(products.rows[0].translations.map((t) => [t.language, t]));
    assert.equal(byLanguage.en.source, 'owner');
    assert.equal(byLanguage.gu.approved, false);
  });

  it('rejects out-of-range prices and stock', async () => {
    const { service } = setup();
    const id = await seedProduct(service);
    for (const bad of [{ price: '0' }, { price: '1000001' }, { price: '-5' }, { price: '1e3' }, { stock: '-1' }, { stock: '2000000' }, { stock: '1.5' }]) {
      await assert.rejects(service.saveReview(STORE_A, id, reviewForm(bad)), (error) => error instanceof ZodError, JSON.stringify(bad));
    }
  });
});

describe('edit view and deletion', () => {
  it('flags AI text in the wrong script but never owner-edited text', async () => {
    const { service, products } = setup();
    const id = await seedProduct(service);
    const wrong = { language: 'gu', title: 'Blue pot', description: 'A clay pot.', altText: 'A pot.', source: 'ai', approved: false };
    products.rows[0].translations = [wrong];
    assert.equal((await service.getForEdit(STORE_A, id)).scriptWarnings.gu, true);
    wrong.source = 'owner';
    assert.equal((await service.getForEdit(STORE_A, id)).scriptWarnings.gu, false);
  });

  it('still renders when photo signing fails', async () => {
    const { service, images } = setup();
    const id = await seedProduct(service);
    images.failures.sign = true;
    assert.equal((await service.getForEdit(STORE_A, id)).imageUrl, null);
  });

  it('a stale generating state is not shown as in progress', async () => {
    const { service, products } = setup();
    const id = await seedProduct(service);
    products.rows[0].aiStatus = 'generating';
    products.rows[0].aiStartedAt = new Date(Date.now() - 600_000).toISOString();
    assert.equal((await service.getForEdit(STORE_A, id)).generating, false);
  });

  it('deletes the row and the photo', async () => {
    const { service, products, images } = setup();
    const id = await seedProduct(service);
    assert.deepEqual(await service.remove(STORE_A, id), { photoRemoved: true });
    assert.equal(products.rows.length, 0);
    assert.equal(images.objects.size, 0);
  });

  it('reports a successful delete and logs the orphan when photo removal fails', async () => {
    const { service, products, images, logger } = setup();
    const id = await seedProduct(service);
    images.failures.remove = true;
    assert.deepEqual(await service.remove(STORE_A, id), { photoRemoved: false });
    assert.equal(products.rows.length, 0);
    assert.ok(logger.entries.some((entry) => /orphaned/.test(entry.message) && entry.productId === id));
  });
});

describe('ListingProviderError', () => {
  it('carries a kind and status', () => {
    assert.equal(new ListingProviderError('http', 529).status, 529);
  });
});
