import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MAX_IMAGE_BYTES } from '../../src/domain/imageUpload.js';
import { ListingProviderError } from '../../src/ai/listingGenerator.js';
import { createListingService } from '../../src/services/listingService.js';
import { createProductService } from '../../src/services/productService.js';
import { STORE_FORM, createClient, signupAndLogin } from '../helpers/appHarness.js';
import { buildFakeServices } from '../helpers/fakes.js';
import {
  GOOD_TRANSLATIONS,
  buildBudgetService,
  createFakeGenerator,
  createFakeImages,
  createFakeProducts,
  createLogCollector,
  jpegBytes,
  okResult,
} from '../helpers/productFakes.js';
import { startTestApp } from '../helpers/testApp.js';

const ORIGIN = 'http://localhost';
const HIGH = { windowMs: 60_000, limit: 1000 };
const AUTH_LIMITS = { loginFailure: HIGH, loginIp: HIGH, signup: HIGH };
const dropUndefined = (form) => Object.fromEntries(Object.entries(form).filter(([, value]) => value !== undefined));
const STORY = 'Hand made blue clay pot.';
const INVITE = 'test-invite-code-0123456789';

/** One fixed clock for every service and fake, so no test depends on the real time or on how long a request takes. */
const FIXED_NOW = Date.parse('2026-11-16T10:00:00Z');
const fixedClock = () => FIXED_NOW;

async function startProductApp({ script = [], budgetOptions, productRateLimits, defaultLanguage = 'en' } = {}) {
  const fakes = await buildFakeServices({ inviteCode: INVITE, now: fixedClock });
  const products = createFakeProducts({
    now: fixedClock,
    defaultLanguageOf: (storeId) => fakes.storesRepo.rows.find((row) => row.id === storeId)?.defaultLanguage ?? defaultLanguage,
  });
  const images = createFakeImages();
  const logger = createLogCollector();
  const { repo, service: budgets } = buildBudgetService(budgetOptions);
  const generator = createFakeGenerator(script);
  const productService = createProductService({ products, images, logger, now: fixedClock });
  const listings = createListingService({ products, images, budgets, generator, logger, now: fixedClock });
  const { auth, sessions, stores } = fakes;
  const app = await startTestApp({
    config: { signupInviteCode: INVITE },
    services: { auth, sessions, stores, products: productService, listings },
    authRateLimits: AUTH_LIMITS,
    productRateLimits,
  });
  const request = createClient(app.url);
  return { ...app, ...fakes, products, images, repo, generator, logger, request };
}

async function ownerWithStore(app, email, slug, defaultLanguage = 'en') {
  const cookie = await signupAndLogin(app, email);
  const response = await app.request('/store/new', { method: 'POST', cookie, form: { ...STORE_FORM, slug, defaultLanguage } });
  assert.equal(response.status, 303);
  return cookie;
}

function upload(app, cookie, body = jpegBytes(), { origin = ORIGIN, headers = {} } = {}) {
  const sent = { 'content-type': 'image/jpeg', accept: 'application/json', ...headers };
  if (origin) sent.origin = origin;
  if (cookie) sent.cookie = cookie;
  return fetch(`${app.url}/products/image`, { method: 'POST', headers: sent, body, redirect: 'manual' });
}

const formPost = (app, cookie, path, form, options = {}) => app.request(path, { method: 'POST', cookie, form, ...options });

const reviewForm = (overrides = {}) => dropUndefined({
  story: STORY, price: '499.50', stock: '2', intent: 'save',
  title_en: 'Blue pot', description_en: 'A blue clay pot.', alt_text_en: 'A blue pot.',
  title_gu: '', description_gu: '', alt_text_gu: '', title_hi: '', description_hi: '', alt_text_hi: '',
  approved_en: 'on', ...overrides,
});

async function createProduct(app, cookie) {
  const response = await upload(app, cookie);
  assert.equal(response.status, 201);
  return (await response.json()).id;
}

describe('product routes: authentication and CSRF', () => {
  let app;
  before(async () => { app = await startProductApp(); });
  after(() => app.close());

  it('redirects anonymous visitors to login on every route and reads no upload body', async () => {
    for (const path of ['/products', '/products/new', `/products/${crypto.randomUUID()}/edit`]) {
      const response = await app.request(path);
      assert.equal(response.status, 303, path);
      assert.equal(response.location, '/login');
    }
    const anonymousUpload = await upload(app, null);
    assert.equal(anonymousUpload.status, 303);
    for (const action of ['generate', 'save', 'delete']) {
      const response = await formPost(app, null, `/products/${crypto.randomUUID()}/${action}`, {});
      assert.equal(response.status, 303, action);
    }
    assert.equal(app.images.objects.size, 0);
  });

  it('rejects state-changing requests from another origin or with no origin proof (403) and changes nothing', async () => {
    const cookie = await ownerWithStore(app, 'csrf@example.com', 'csrf-shop');
    const id = await createProduct(app, cookie);
    for (const action of ['generate', 'save', 'delete']) {
      for (const origin of ['https://evil.example', null]) {
        const response = await formPost(app, cookie, `/products/${id}/${action}`, { story: 'x' }, { origin });
        assert.equal(response.status, 403, `${action} ${origin}`);
      }
    }
    assert.equal((await upload(app, cookie, jpegBytes(), { origin: 'https://evil.example' })).status, 403);
    assert.equal(app.products.rows.length, 1);
    assert.equal(app.generator.calls.length, 0);
  });

  it('sets no-store caching and allows the Supabase origin for images in the CSP', async () => {
    const cookie = await ownerWithStore(app, 'csp@example.com', 'csp-shop');
    const response = await app.request('/products', { cookie });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-security-policy'), /img-src [^;]*https:\/\/project\.supabase\.test/);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  });

  it('shows the owner a Manage products link on the dashboard', async () => {
    const cookie = await ownerWithStore(app, 'link@example.com', 'link-shop');
    assert.match((await app.request('/dashboard', { cookie })).text, /href="\/products"/);
  });
});

describe('product routes: upload', () => {
  let app;
  before(async () => { app = await startProductApp(); });
  after(() => app.close());

  it('stores a valid photo and returns the new product id and generate URL', async () => {
    const cookie = await ownerWithStore(app, 'up@example.com', 'up-shop');
    const response = await upload(app, cookie);
    assert.equal(response.status, 201);
    const { id, generateUrl } = await response.json();
    assert.equal(generateUrl, `/products/${id}/generate`);
    assert.equal(app.products.rows.at(-1).storeId, app.storesRepo.rows.find((s) => s.slug === 'up-shop').id);
    assert.equal(app.images.objects.size, 1);
  });

  it('rejects wrong content, ignoring a lying Content-Type, as JSON with no product and no object', async () => {
    const cookie = await ownerWithStore(app, 'bad@example.com', 'bad-shop');
    const before = [app.products.rows.length, app.images.objects.size];
    for (const body of [Buffer.from('GIF89a not really an image, just text bytes here'), Buffer.from('<?php echo 1; ?> padding padding padding')]) {
      const response = await upload(app, cookie, body);
      assert.equal(response.status, 415);
      assert.equal((await response.json()).error.code, 'INVALID_IMAGE');
    }
    const empty = await upload(app, cookie, Buffer.alloc(0));
    assert.equal(empty.status, 400);
    const wrongType = await upload(app, cookie, Buffer.from('hello'), { headers: { 'content-type': 'text/plain' } });
    assert.equal(wrongType.status, 400);
    assert.deepEqual([app.products.rows.length, app.images.objects.size], before);
  });

  it('rejects a body over 4 MB with 413 and stores nothing', async () => {
    const cookie = await ownerWithStore(app, 'big@example.com', 'big-shop');
    const before = app.images.objects.size;
    const response = await upload(app, cookie, Buffer.alloc(MAX_IMAGE_BYTES + 1024, 1));
    assert.equal(response.status, 413);
    assert.equal(app.images.objects.size, before);
  });

  it('answers 502 and leaves no product when storage fails, without provider details', async () => {
    const cookie = await ownerWithStore(app, 'store@example.com', 'store-shop');
    const count = app.products.rows.length;
    app.images.failures.upload = true;
    const response = await upload(app, cookie);
    app.images.failures.upload = false;
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'STORAGE_ERROR');
    assert.equal(app.products.rows.length, count);
  });

  it('sends an owner without a store to create one', async () => {
    const cookie = await signupAndLogin(app, 'nostore@example.com');
    const response = await app.request('/products', { cookie });
    assert.equal(response.location, '/store/new');
  });
});

describe('product routes: ownership', () => {
  let app;
  let cookieA;
  let cookieB;
  let idA;
  before(async () => {
    app = await startProductApp({ script: [okResult()] });
    cookieA = await ownerWithStore(app, 'a@example.com', 'shop-a');
    cookieB = await ownerWithStore(app, 'b@example.com', 'shop-b');
    idA = await createProduct(app, cookieA);
  });
  after(() => app.close());

  it("another owner gets 404 for edit, generate, save and delete of the first owner's product, and nothing changes", async () => {
    assert.equal((await app.request(`/products/${idA}/edit`, { cookie: cookieB })).status, 404);
    assert.equal((await formPost(app, cookieB, `/products/${idA}/generate`, { story: STORY })).status, 404);
    assert.equal((await formPost(app, cookieB, `/products/${idA}/save`, reviewForm())).status, 404);
    assert.equal((await formPost(app, cookieB, `/products/${idA}/delete`, {})).status, 404);
    assert.equal(app.products.rows.length, 1);
    assert.equal(app.products.rows[0].story, '');
    assert.equal(app.generator.calls.length, 0);
    assert.equal(app.repo.calls.length, 0);
  });

  it("lists only the owner's own products", async () => {
    assert.match((await app.request('/products', { cookie: cookieA })).text, new RegExp(idA));
    assert.doesNotMatch((await app.request('/products', { cookie: cookieB })).text, new RegExp(idA));
  });

  it('answers 404 for malformed ids, and a store_id in the form cannot redirect the operation', async () => {
    assert.equal((await app.request('/products/not-a-uuid/edit', { cookie: cookieA })).status, 404);
    const smuggled = await formPost(app, cookieB, `/products/${idA}/save`, reviewForm({ store_id: app.products.rows[0].storeId }));
    assert.equal(smuggled.status, 400);
    assert.equal(app.products.rows[0].pricePaise, null);
  });
});

describe('product routes: generate, review, publish, delete', () => {
  let app;
  let cookie;
  before(async () => {
    app = await startProductApp({ script: [okResult()] });
    cookie = await ownerWithStore(app, 'flow@example.com', 'flow-shop');
  });
  after(() => app.close());

  it('walks upload, generate, edit, approve, publish and delete', async () => {
    const id = await createProduct(app, cookie);
    const generated = await formPost(app, cookie, `/products/${id}/generate`, { story: STORY });
    assert.equal(generated.status, 303);
    assert.equal(generated.location, `/products/${id}/edit?notice=generated`);
    assert.equal(app.generator.calls.length, 1);

    const page = await app.request(generated.location, { cookie });
    assert.equal(page.status, 200);
    assert.match(page.text, /AI draft, not yet reviewed by you/);
    assert.match(page.text, /value="Blue clay pot"/);
    assert.match(page.text, /<img class="product-thumb" src="https:\/\/project\.supabase\.test\/storage\/v1\/object\/sign\//);
    assert.doesNotMatch(page.text, /Approved by you/);
    assert.equal(app.products.rows[0].status, 'draft');

    const full = reviewForm({
      intent: 'publish',
      title_gu: GOOD_TRANSLATIONS.gu.title, description_gu: GOOD_TRANSLATIONS.gu.description, alt_text_gu: GOOD_TRANSLATIONS.gu.alt_text,
    });
    const published = await formPost(app, cookie, `/products/${id}/save`, full);
    assert.equal(published.location, `/products/${id}/edit?notice=published#tab-details`);
    const after = await app.request(published.location, { cookie });
    assert.match(after.text, /Published/);
    assert.match(after.text, /value="499\.50"/);
    assert.equal(app.products.rows[0].status, 'published');

    const regenerate = await formPost(app, cookie, `/products/${id}/generate`, { story: STORY });
    assert.equal(regenerate.status, 409);
    assert.match(regenerate.text, /cannot be regenerated/);

    const removed = await formPost(app, cookie, `/products/${id}/delete`, {});
    assert.equal(removed.location, '/products?notice=deleted');
    assert.equal(app.products.rows.length, 0);
    assert.equal(app.images.objects.size, 0);
  });

  it('shows validation errors for a bad price and refuses to publish without price or approval, never claiming success', async () => {
    const id = await createProduct(app, cookie);
    const badPrice = await formPost(app, cookie, `/products/${id}/save`, reviewForm({ price: 'abc' }));
    assert.equal(badPrice.status, 400);
    assert.match(badPrice.text, /Enter a price from 1 to 1,000,000 rupees/);
    assert.match(badPrice.text, /value="abc"/);
    const noPrice = await formPost(app, cookie, `/products/${id}/save`, reviewForm({ intent: 'publish', price: '' }));
    assert.equal(noPrice.status, 400);
    assert.match(noPrice.text, /Enter a price before publishing/);
    const noApproval = await formPost(app, cookie, `/products/${id}/save`, reviewForm({ intent: 'publish', approved_en: undefined }));
    assert.equal(noApproval.status, 422);
    assert.match(noApproval.text, /class="alert" role="alert">Approve the English text before publishing\./);
    assert.match(noApproval.text, /<input type="checkbox" id="approved_en"[^>]*autofocus[^>]*aria-describedby="approval-error"/);
    assert.match(noApproval.text, /id="approval-error" class="error-text" role="alert">Approve the English text before publishing\./);
    assert.equal(app.products.rows.find((row) => row.id === id).status, 'draft');
    const incomplete = await formPost(app, cookie, `/products/${id}/save`, reviewForm({ approved_gu: 'on' }));
    assert.equal(incomplete.status, 400);
    assert.match(incomplete.text, /fill in its title, description and photo description/);
  });

  it('accepts a full three-language Gujarati and Hindi form larger than the global 10 kb form limit', async () => {
    const id = await createProduct(app, cookie);
    const long = 'ક'.repeat(1100);
    const form = reviewForm({ description_gu: long, description_hi: 'क'.repeat(1100), description_en: 'a'.repeat(1100), title_gu: 'શીર્ષક', alt_text_gu: 'વર્ણન' });
    assert.ok(new URLSearchParams(form).toString().length > 10_240);
    const response = await formPost(app, cookie, `/products/${id}/save`, form);
    assert.equal(response.status, 303);
  });

  it('rejects unknown keys and bad intent as 400 and does not save', async () => {
    const id = await createProduct(app, cookie);
    for (const extra of [{ status: 'published' }, { intent: 'delete' }, { is_demo: 'true' }]) {
      const response = await formPost(app, cookie, `/products/${id}/save`, reviewForm(extra));
      assert.equal(response.status, 400, JSON.stringify(extra));
    }
    assert.equal(app.products.rows.find((row) => row.id === id).pricePaise, null);
  });

  it('escapes AI and owner text in the page (no markup injection)', async () => {
    const id = await createProduct(app, cookie);
    const hostile = '"><script>alert(1)</script><img src=x onerror=alert(2)>';
    const response = await formPost(app, cookie, `/products/${id}/save`, reviewForm({ title_en: hostile, price: 'x' }));
    assert.doesNotMatch(response.text, /<script>alert|<img src=x/);
    assert.match(response.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });
});

describe('product routes: generation failures are shown on the page', () => {
  it('shows budget exhaustion as 429 and the provider error and timeout messages, without provider details', async () => {
    const app = await startProductApp({ script: [new ListingProviderError('timeout'), new ListingProviderError('http', 529)] });
    try {
      const cookie = await ownerWithStore(app, 'fail@example.com', 'fail-shop');
      const id = await createProduct(app, cookie);
      const timeout = await formPost(app, cookie, `/products/${id}/generate`, { story: STORY });
      assert.equal(timeout.status, 504);
      assert.match(timeout.text, /took too long/);
      assert.match(timeout.text, /Last AI attempt failed/);
      const provider = await formPost(app, cookie, `/products/${id}/generate`, { story: STORY });
      assert.equal(provider.status, 502);
      assert.doesNotMatch(provider.text, /529|overloaded/i);
      const empty = await formPost(app, cookie, `/products/${id}/generate`, { story: '  ' });
      assert.equal(empty.status, 400);
      assert.match(empty.text, /Write a few sentences/);
      const extra = await formPost(app, cookie, `/products/${id}/generate`, { story: STORY, store_id: 'x' });
      assert.equal(extra.status, 400);
    } finally {
      await app.close();
    }
  });

  it('refuses with 429 and never calls Claude when the budget is exhausted', async () => {
    const app = await startProductApp({ script: [okResult()], budgetOptions: { ownerRemaining: 0 } });
    try {
      const cookie = await ownerWithStore(app, 'broke@example.com', 'broke-shop');
      const id = await createProduct(app, cookie);
      const response = await formPost(app, cookie, `/products/${id}/generate`, { story: STORY });
      assert.equal(response.status, 429);
      assert.match(response.text, /AI limit has been reached/);
      assert.equal(app.generator.calls.length, 0);
    } finally {
      await app.close();
    }
  });
});

describe('product routes: rate limits', () => {
  it('limits uploads and generations per owner, independently of other owners', async () => {
    const app = await startProductApp({
      script: [okResult(), okResult(), okResult()],
      productRateLimits: { upload: { windowMs: 60_000, limit: 2 }, generate: { windowMs: 60_000, limit: 1 } },
    });
    try {
      const cookieA = await ownerWithStore(app, 'rl-a@example.com', 'rl-a');
      const cookieB = await ownerWithStore(app, 'rl-b@example.com', 'rl-b');
      const id = await createProduct(app, cookieA);
      await createProduct(app, cookieA);
      assert.equal((await upload(app, cookieA)).status, 429);
      assert.equal((await upload(app, cookieB)).status, 201);
      assert.equal((await formPost(app, cookieA, `/products/${id}/generate`, { story: STORY })).status, 303);
      assert.equal((await formPost(app, cookieA, `/products/${id}/generate`, { story: STORY })).status, 429);
      assert.equal(app.generator.calls.length, 1);
    } finally {
      await app.close();
    }
  });
});

describe('product routes are optional', () => {
  it('are not mounted when the product services are not provided', async () => {
    const fakes = await buildFakeServices({ inviteCode: INVITE });
    const app = await startTestApp({ config: { signupInviteCode: INVITE }, services: { auth: fakes.auth, sessions: fakes.sessions, stores: fakes.stores }, authRateLimits: AUTH_LIMITS });
    try {
      const request = createClient(app.url);
      assert.equal((await request('/products')).status, 404);
    } finally {
      await app.close();
    }
  });
});
