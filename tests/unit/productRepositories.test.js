import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createImageStorageRepository } from '../../src/repositories/imageStorageRepository.js';
import { createProductRepository } from '../../src/repositories/productRepository.js';

const STORE = '11111111-1111-4111-8111-111111111111';
const OTHER_STORE = '22222222-2222-4222-8222-222222222222';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const GENERATION = '77777777-7777-4777-8777-777777777777';
const PATH = `${STORE}/${PRODUCT}/55555555-5555-4555-8555-555555555555.jpg`;

const productRow = (extra = {}) => ({
  id: PRODUCT, status: 'draft', price_paise: null, stock: null, story: '', image_path: PATH, image_content_type: 'image/jpeg',
  ai_status: 'idle', ai_started_at: null, created_at: '2026-11-15T00:00:00Z', updated_at: '2026-11-15T00:00:00Z', ...extra,
});

/** A chainable, thenable query recorder standing in for the supabase-js builder. */
function recordingClient({ data = null, error = null, rpc } = {}) {
  const log = [];
  const builder = (table) => {
    const entry = { table, calls: [] };
    log.push(entry);
    const proxy = new Proxy(() => {}, {
      get: (_t, name) => {
        if (name === 'then') return (resolve) => resolve({ data, error });
        return (...args) => (entry.calls.push([name, ...args]), proxy);
      },
    });
    return proxy;
  };
  return { log, from: builder, rpc: async (name, args) => (log.push({ rpc: name, args }), rpc ?? { data, error }) };
}

const hasFilter = (entry, column, value) => entry.calls.some(([name, c, v]) => name === 'eq' && c === column && v === value);

describe('productRepository scoping', () => {
  it('scopes every table query by store_id (and id where one product is meant)', async () => {
    const client = recordingClient({ data: [productRow()] });
    const repo = createProductRepository({ client });
    await repo.listByStore(STORE);
    await createProductRepository({ client: Object.assign(client, { _x: 0 }) }).findById(STORE, PRODUCT).catch(() => {});
    await repo.claimGeneration(STORE, PRODUCT, { story: 's', nowIso: '2026-11-15T00:00:00.000Z', staleBeforeIso: '2026-11-15T00:00:00.000Z' });
    await repo.finishGeneration(STORE, PRODUCT, GENERATION, 'failed');
    await repo.deleteById(STORE, PRODUCT);
    for (const entry of client.log) {
      assert.ok(hasFilter(entry, 'store_id', STORE), `missing store filter: ${JSON.stringify(entry.calls.map((c) => c[0]))}`);
    }
    assert.equal(client.log.filter((entry) => hasFilter(entry, 'id', PRODUCT)).length, 4);
  });

  it('rejects a missing or malformed storeId before any query', async () => {
    const client = recordingClient();
    const repo = createProductRepository({ client });
    for (const bad of [undefined, '', 'abc', null]) {
      await assert.rejects(repo.findById(bad, PRODUCT), TypeError);
      await assert.rejects(repo.listByStore(bad), TypeError);
      await assert.rejects(repo.saveReview(bad, PRODUCT, { story: '', stock: null, pricePaise: null, translations: {}, approvedLanguages: [], publish: false }), TypeError);
    }
    assert.equal(client.log.length, 0);
  });

  it('claims only drafts and only when not generating or stale, in a single UPDATE', async () => {
    const client = recordingClient({ data: [] });
    const repo = createProductRepository({ client });
    assert.equal(await repo.claimGeneration(STORE, PRODUCT, { story: 's', nowIso: 'N', staleBeforeIso: 'S' }), null);
    const [entry] = client.log;
    assert.deepEqual(entry.calls.find(([name]) => name === 'update')[1].ai_status, 'generating');
    assert.ok(hasFilter(entry, 'status', 'draft'));
    assert.match(entry.calls.find(([name]) => name === 'or')[1], /ai_status\.neq\.generating,ai_started_at\.is\.null,ai_started_at\.lt\.S/);
  });

  it('maps rows and refuses unexpected row shapes', async () => {
    const repo = createProductRepository({ client: recordingClient({ data: { ...productRow(), product_translations: [{ language: 'en', title: 't', description: 'd', alt_text: 'a', source: 'ai', approved: false }] } }) });
    const product = await repo.findById(STORE, PRODUCT);
    assert.equal(product.translations[0].altText, 'a');
    const broken = createProductRepository({ client: recordingClient({ data: { ...productRow(), status: 'archived' } }) });
    await assert.rejects(broken.findById(STORE, PRODUCT), { code: 'DATABASE_ERROR' });
  });

  it('database errors become a generic AppError without provider text', async () => {
    const repo = createProductRepository({ client: recordingClient({ error: { code: '42501', message: 'permission denied for table secret' } }) });
    await assert.rejects(repo.findById(STORE, PRODUCT), (error) => error.code === 'DATABASE_ERROR' && !/secret/.test(error.message));
  });

  it('refuses to end a generation in an unknown state', async () => {
    const repo = createProductRepository({ client: recordingClient() });
    await assert.rejects(repo.finishGeneration(STORE, PRODUCT, GENERATION, 'published'), TypeError);
  });
});

describe('productRepository RPCs', () => {
  const rpcRepo = (data, error = null) => {
    const client = recordingClient({ rpc: { data, error } });
    return { client, repo: createProductRepository({ client }) };
  };
  const aiInput = { generationId: GENERATION, translations: { en: {}, gu: {}, hi: {} }, model: 'm', tokensIn: 1, tokensOut: 2, costMicroUsd: 3 };
  const reviewInput = { story: 'A story.', stock: 2, pricePaise: 100, translations: {}, approvedLanguages: ['en'], publish: true };

  it('calls save_ai_listing with the store id from the caller and p_* arguments only', async () => {
    const { client, repo } = rpcRepo({ ok: true, draft_id: '66666666-6666-4666-8666-666666666666' });
    assert.deepEqual(await repo.saveAiListing(STORE, PRODUCT, aiInput), { ok: true, draftId: '66666666-6666-4666-8666-666666666666' });
    assert.deepEqual(Object.keys(client.log[0].args).sort(), ['p_cost', 'p_generation_id', 'p_model', 'p_product_id', 'p_store_id', 'p_tokens_in', 'p_tokens_out', 'p_translations']);
    assert.equal(client.log[0].args.p_store_id, STORE);
  });

  it('calls save_product_review with the exact argument names of migration 005', async () => {
    const { client, repo } = rpcRepo({ ok: true, status: 'published' });
    assert.deepEqual(await repo.saveReview(STORE, PRODUCT, reviewInput), { ok: true, status: 'published' });
    assert.deepEqual(Object.keys(client.log[0].args).sort(), ['p_approved_langs', 'p_price_paise', 'p_product_id', 'p_publish', 'p_stock', 'p_store_id', 'p_story', 'p_translations']);
  });

  it('passes through documented refusal reasons', async () => {
    assert.deepEqual(await rpcRepo({ ok: false, reason: 'not_found' }).repo.saveReview(STORE, PRODUCT, reviewInput), { ok: false, reason: 'not_found' });
    assert.deepEqual(await rpcRepo({ ok: false, reason: 'not_draft' }).repo.saveAiListing(STORE, PRODUCT, aiInput), { ok: false, reason: 'not_draft' });
    assert.deepEqual(await rpcRepo({ ok: false, reason: 'stale_generation' }).repo.saveAiListing(STORE, PRODUCT, aiInput), { ok: false, reason: 'stale_generation' });
    assert.deepEqual(await rpcRepo({ ok: false, reason: 'generating' }).repo.saveReview(STORE, PRODUCT, reviewInput), { ok: false, reason: 'generating' });
  });

  it('claims with a fresh token that it returns, and finishes only the run that holds the token', async () => {
    const client = recordingClient({ data: [productRow({ ai_generation_id: GENERATION })] });
    const repo = createProductRepository({ client, newGenerationId: () => GENERATION });
    const claimed = await repo.claimGeneration(STORE, PRODUCT, { story: 's', nowIso: 'N', staleBeforeIso: 'S' });
    assert.equal(claimed.generationId, GENERATION);
    assert.equal(client.log[0].calls.find(([name]) => name === 'update')[1].ai_generation_id, GENERATION);
    await repo.finishGeneration(STORE, PRODUCT, GENERATION, 'idle');
    const finish = client.log[1];
    assert.ok(hasFilter(finish, 'ai_generation_id', GENERATION) && hasFilter(finish, 'ai_status', 'generating'));
    assert.equal(finish.calls.find(([name]) => name === 'update')[1].ai_generation_id, null);
  });

  it('refuses to save or finish without a valid generation id, before any query', async () => {
    const { client, repo } = rpcRepo({ ok: true, draft_id: '66666666-6666-4666-8666-666666666666' });
    for (const bad of [undefined, null, '', 'not-a-uuid']) {
      await assert.rejects(repo.finishGeneration(STORE, PRODUCT, bad, 'failed'), TypeError);
      await assert.rejects(repo.saveAiListing(STORE, PRODUCT, { ...aiInput, generationId: bad }), TypeError);
    }
    assert.equal(client.log.length, 0);
  });

  it('rejects malformed RPC responses: unknown reason, extra keys, wrong types, null, a published claim without ok', async () => {
    const bad = [{ ok: false, reason: 'weird' }, { ok: true, status: 'archived' }, { ok: true, status: 'published', extra: 1 }, null, 'ok', { status: 'published' }, { ok: 'true', status: 'draft' }];
    for (const data of bad) {
      await assert.rejects(rpcRepo(data).repo.saveReview(STORE, PRODUCT, reviewInput), { code: 'DATABASE_ERROR' }, JSON.stringify(data));
    }
    for (const data of [{ ok: true }, { ok: true, draft_id: 'nope' }, { ok: false, reason: 'price_required' }, null]) {
      await assert.rejects(rpcRepo(data).repo.saveAiListing(STORE, PRODUCT, aiInput), { code: 'DATABASE_ERROR' }, JSON.stringify(data));
    }
  });

  it('an RPC transport error becomes a generic AppError', async () => {
    const { repo } = rpcRepo(null, { code: '57014', message: 'canceling statement' });
    await assert.rejects(repo.saveReview(STORE, PRODUCT, reviewInput), (error) => error.code === 'DATABASE_ERROR' && !/canceling/.test(error.message));
  });
});

describe('imageStorageRepository', () => {
  function fakeStorage({ uploadError = null, downloadData, downloadError = null, removeError = null, signed } = {}) {
    const calls = [];
    const bucket = {
      upload: async (...args) => (calls.push(['upload', ...args]), { error: uploadError }),
      download: async (...args) => (calls.push(['download', ...args]), { data: downloadData, error: downloadError }),
      remove: async (...args) => (calls.push(['remove', ...args]), { error: removeError }),
      createSignedUrl: async (...args) => (calls.push(['sign', ...args]), signed ?? { data: { signedUrl: 'https://x.test/s?token=1' }, error: null }),
    };
    return { calls, client: { storage: { from: (name) => (calls.push(['bucket', name]), bucket) } } };
  }

  it('uses only the private product-images bucket and never overwrites', async () => {
    const { client, calls } = fakeStorage();
    const repo = createImageStorageRepository({ client });
    await repo.upload(STORE, PRODUCT, PATH, Buffer.from('x'), 'image/jpeg');
    assert.deepEqual(calls[0], ['bucket', 'product-images']);
    assert.deepEqual(calls[1].slice(0, 1), ['upload']);
    assert.deepEqual(calls[1][3], { contentType: 'image/jpeg', upsert: false });
  });

  it("refuses any path outside this store's and product's prefix, so no cross-store access is possible", async () => {
    const { client, calls } = fakeStorage();
    const repo = createImageStorageRepository({ client });
    const foreign = `${OTHER_STORE}/${PRODUCT}/55555555-5555-4555-8555-555555555555.jpg`;
    for (const path of [foreign, '../x.jpg', `${STORE}/${PRODUCT}/../a.jpg`, `${STORE}/${PRODUCT}/x.gif`, undefined]) {
      await assert.rejects(repo.download(STORE, PRODUCT, path), TypeError);
      await assert.rejects(repo.remove(STORE, PRODUCT, path), TypeError);
      await assert.rejects(repo.createSignedUrl(STORE, PRODUCT, path), TypeError);
      await assert.rejects(repo.upload(STORE, PRODUCT, path, Buffer.from('x'), 'image/jpeg'), TypeError);
    }
    assert.equal(calls.length, 0);
  });

  it('maps provider failures to a generic STORAGE_ERROR without the provider message', async () => {
    const leak = { message: 'Bucket secret-bucket not found at https://internal' };
    const failing = createImageStorageRepository({ client: fakeStorage({ uploadError: leak, downloadError: leak, removeError: leak, signed: { data: null, error: leak } }).client });
    for (const call of [
      () => failing.upload(STORE, PRODUCT, PATH, Buffer.from('x'), 'image/jpeg'),
      () => failing.download(STORE, PRODUCT, PATH),
      () => failing.remove(STORE, PRODUCT, PATH),
      () => failing.createSignedUrl(STORE, PRODUCT, PATH),
    ]) {
      await assert.rejects(call(), (error) => error.code === 'STORAGE_ERROR' && error.httpStatus === 502 && !/secret|internal/.test(error.message));
    }
  });

  it('downloads bytes and returns a short-lived signed URL', async () => {
    const { client, calls } = fakeStorage({ downloadData: new Blob([Buffer.from('abc')]) });
    const repo = createImageStorageRepository({ client });
    assert.equal((await repo.download(STORE, PRODUCT, PATH)).toString(), 'abc');
    assert.match(await repo.createSignedUrl(STORE, PRODUCT, PATH), /^https:\/\//);
    assert.equal(calls.find(([name]) => name === 'sign')[2], 300);
  });
});
