import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPublicShopRepository } from '../../src/repositories/publicShopRepository.js';
import { createStoreRepository } from '../../src/repositories/storeRepository.js';
import { buildSitemapEntries } from '../../src/services/publicShopService.js';
import { buildRobotsTxt, buildSitemapXml } from '../../src/domain/seo.js';

const STORE = '11111111-1111-4111-8111-111111111111';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const PRIVATE_COLUMNS = /contact_email|owner_id|password|image_content_type|\bai_|upi_id|session|token|email/i;

/** Chainable, thenable recorder standing in for the supabase-js builder. */
function recordingClient(data = []) {
  const log = [];
  const client = {
    log,
    from(table) {
      const entry = { table, calls: [] };
      log.push(entry);
      const proxy = new Proxy(() => {}, {
        get: (_t, name) => {
          if (name === 'then') return (resolve) => resolve({ data, error: null });
          if (name === 'maybeSingle') return async () => ({ data: Array.isArray(data) ? null : data, error: null });
          return (...args) => (entry.calls.push([name, ...args]), proxy);
        },
      });
      return proxy;
    },
  };
  return client;
}

const selectOf = (entry) => entry.calls.find(([name]) => name === 'select')[1];
const filters = (entry) => entry.calls.filter(([name]) => name === 'eq').map(([, column, value]) => `${column}=${value}`);

describe('public repository queries', () => {
  it('selects explicit public columns only, never private or AI columns', async () => {
    const client = recordingClient();
    const repo = createPublicShopRepository({ client });
    await repo.findShopBySlug('mati-no-rang');
    await repo.listPublished(STORE);
    await repo.findPublished(STORE, PRODUCT);
    await repo.findPublishedImage(STORE, PRODUCT);
    await repo.listStoreTranslations(STORE);
    await repo.listSitemapEntries(5000);
    assert.equal(client.log.length, 6);
    for (const entry of client.log) {
      const select = selectOf(entry);
      assert.ok(!select.includes('*'), select);
      assert.doesNotMatch(select.replace('whatsapp_number', ''), PRIVATE_COLUMNS, select);
    }
    const imagePathSelects = client.log.filter((entry) => selectOf(entry).includes('image_path'));
    assert.equal(imagePathSelects.length, 1);
  });

  it('scopes product reads by store_id and published status', async () => {
    const client = recordingClient();
    const repo = createPublicShopRepository({ client });
    await repo.listPublished(STORE);
    await repo.findPublished(STORE, PRODUCT);
    await repo.findPublishedImage(STORE, PRODUCT);
    for (const entry of client.log) {
      assert.ok(filters(entry).includes(`store_id=${STORE}`));
      assert.ok(filters(entry).includes('status=published'));
    }
    assert.ok(client.log.slice(1).every((entry) => filters(entry).includes(`id=${PRODUCT}`)));
  });

  it('lists newest first with a fetch of 49 (48 shown plus one) and rejects a missing store id before querying', async () => {
    const client = recordingClient();
    const repo = createPublicShopRepository({ client });
    await repo.listPublished(STORE);
    const calls = client.log[0].calls;
    assert.deepEqual(calls.filter(([name]) => name === 'order').map(([, column, options]) => [column, options.ascending]), [['created_at', false], ['id', false]]);
    assert.deepEqual(calls.find(([name]) => name === 'limit'), ['limit', 49]);
    for (const bad of [undefined, '', 'abc', null]) {
      await assert.rejects(repo.listPublished(bad), TypeError);
      await assert.rejects(repo.findPublished(bad, PRODUCT), TypeError);
      await assert.rejects(repo.findPublishedImage(bad, PRODUCT), TypeError);
    }
    assert.equal(client.log.length, 1);
  });

  it('the sitemap query is one fixed allowlist of public columns', async () => {
    const client = recordingClient();
    await createPublicShopRepository({ client }).listSitemapEntries(5000);
    const [entry] = client.log;
    assert.equal(entry.table, 'products');
    assert.equal(selectOf(entry), 'id, updated_at, stores!inner(slug, updated_at)');
    assert.deepEqual(filters(entry), ['status=published']);
    assert.deepEqual(entry.calls.find(([name]) => name === 'limit'), ['limit', 5000]);
  });

  it('is the only public repository file, and its only non-store-scoped methods are the two documented ones', () => {
    const source = readFileSync(fileURLToPath(new URL('../../src/repositories/publicShopRepository.js', import.meta.url)), 'utf8');
    const methods = [...source.matchAll(/^\s+async (\w+)\(([^)]*)\)/gm)];
    const unscoped = methods.filter(([, , params]) => !/^storeId(,|$)/.test(params.trim())).map(([, name]) => name);
    assert.deepEqual(unscoped, ['findShopBySlug', 'listSitemapEntries']);
    assert.doesNotMatch(source, /\.delete\(|\.insert\(|\.update\(|\.upsert\(|\.rpc\(/);
  });
});

describe('store settings update', () => {
  it('is one UPDATE scoped by the resolved store id and rejects a missing id', async () => {
    const client = recordingClient({ id: STORE });
    const repo = createStoreRepository({ client });
    const settings = { tagline: 't', story: 's', accentKey: 'teal', whatsappNumber: null, whatsappEnabled: false, instagramHandle: null, upiId: null, notifyEnquiryEmail: true };
    await repo.updateSettings(STORE, settings).catch(() => {});
    assert.equal(client.log.length, 1);
    const [entry] = client.log;
    assert.equal(entry.table, 'stores');
    assert.deepEqual(filters(entry), [`id=${STORE}`]);
    const changes = entry.calls.find(([name]) => name === 'update')[1];
    assert.deepEqual(Object.keys(changes).sort(), ['accent_key', 'instagram_handle', 'notify_enquiry_email', 'story', 'tagline', 'updated_at', 'upi_id', 'whatsapp_enabled', 'whatsapp_number']);
    await assert.rejects(repo.updateSettings('abc', settings), TypeError);
    assert.equal(client.log.length, 1);
  });
});

describe('sitemap builders', () => {
  const row = (slug, id) => ({ slug, productId: id, productUpdatedAt: '2026-11-11T08:00:00Z', shopUpdatedAt: '2026-11-10T08:00:00Z' });

  it('orders shops by slug and products by id, shop first', () => {
    const entries = buildSitemapEntries([row('b-shop', 'p2'), row('a-shop', 'p9'), row('b-shop', 'p1')], 'https://x.test', 10);
    assert.deepEqual(entries.map((entry) => entry.loc), [
      'https://x.test/s/a-shop', 'https://x.test/s/a-shop/p/p9', 'https://x.test/s/b-shop', 'https://x.test/s/b-shop/p/p1', 'https://x.test/s/b-shop/p/p2',
    ]);
    assert.equal(entries[0].lastmod, '2026-11-10T08:00:00.000Z');
  });

  it('caps the output at the hard limit', () => {
    const rows = Array.from({ length: 6000 }, (_, index) => row(`shop-${String(index % 50).padStart(2, '0')}`, `p${String(index).padStart(5, '0')}`));
    assert.equal(buildSitemapEntries(rows, 'https://x.test', 5000).length, 5000);
  });

  it('omits an unparseable lastmod and escapes XML', () => {
    const [entry] = buildSitemapEntries([{ ...row('a', 'p'), shopUpdatedAt: 'garbage' }], 'https://x.test', 10);
    assert.equal(entry.lastmod, null);
    const xml = buildSitemapXml([{ loc: 'https://x.test/a?x=1&y=<2>', lastmod: null }]);
    assert.ok(xml.includes('<loc>https://x.test/a?x=1&amp;y=&lt;2&gt;</loc>'));
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  });

  it('builds robots.txt with an absolute sitemap URL', () => {
    assert.ok(buildRobotsTxt('https://x.test').endsWith('Sitemap: https://x.test/sitemap.xml\n'));
  });
});
