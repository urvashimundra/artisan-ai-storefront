import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createStoreTranslationRepository } from '../../src/repositories/storeTranslationRepository.js';

const STORE = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-11-16T10:00:00Z');

/** Chainable, thenable recorder standing in for the supabase-js builder. */
function recordingClient(data = []) {
  const log = [];
  return {
    log,
    from(table) {
      const entry = { table, calls: [] };
      log.push(entry);
      const proxy = new Proxy(() => {}, {
        get: (_target, name) => {
          if (name === 'then') return (resolve) => resolve({ data, error: null });
          if (name === 'maybeSingle') return async () => ({ data: Array.isArray(data) ? null : data, error: null });
          return (...args) => (entry.calls.push([name, ...args]), proxy);
        },
      });
      return proxy;
    },
  };
}

const callsNamed = (entry, name) => entry.calls.filter(([called]) => called === name);
const ROW = { language: 'gu', tagline: 'ટેગ', story: 'વાર્તા', source: 'ai', approved: false };

describe('store translation repository', () => {
  it('scopes every read and write by store_id and uses the translations table only', async () => {
    const client = recordingClient();
    const repo = createStoreTranslationRepository({ client, now: () => NOW });
    await repo.list(STORE);
    await repo.find(STORE, 'gu');
    await repo.upsertMany(STORE, [ROW]);
    await repo.unapproveAll(STORE);
    assert.equal(client.log.length, 4);
    assert.ok(client.log.every((entry) => entry.table === 'store_translations'));
    for (const entry of [client.log[0], client.log[1], client.log[3]]) {
      assert.deepEqual(callsNamed(entry, 'eq')[0], ['eq', 'store_id', STORE]);
    }
  });

  it('selects explicit columns and never the whole row', async () => {
    const client = recordingClient();
    const repo = createStoreTranslationRepository({ client });
    await repo.list(STORE);
    assert.equal(callsNamed(client.log[0], 'select')[0][1], 'language, tagline, story, source, approved');
  });

  it('upserts in one statement keyed by store and language, with the store id taken from the argument', async () => {
    const client = recordingClient();
    const repo = createStoreTranslationRepository({ client, now: () => NOW });
    await repo.upsertMany(STORE, [{ ...ROW, store_id: 'ignored' }, { ...ROW, language: 'hi' }]);
    const [, rows, options] = callsNamed(client.log[0], 'upsert')[0];
    assert.equal(callsNamed(client.log[0], 'upsert').length, 1);
    assert.deepEqual(options, { onConflict: 'store_id,language' });
    assert.deepEqual(rows.map((row) => [row.store_id, row.language, row.approved]), [[STORE, 'gu', false], [STORE, 'hi', false]]);
    assert.equal(rows[0].updated_at, '2026-11-16T10:00:00.000Z');
  });

  it('unapproves by store only and rejects a missing store id before querying', async () => {
    const client = recordingClient();
    const repo = createStoreTranslationRepository({ client, now: () => NOW });
    await repo.unapproveAll(STORE);
    assert.deepEqual(callsNamed(client.log[0], 'update')[0][1], { approved: false, updated_at: '2026-11-16T10:00:00.000Z' });
    for (const bad of [undefined, '', 'abc', null]) {
      await assert.rejects(repo.list(bad), TypeError);
      await assert.rejects(repo.find(bad, 'gu'), TypeError);
      await assert.rejects(repo.upsertMany(bad, [ROW]), TypeError);
      await assert.rejects(repo.unapproveAll(bad), TypeError);
    }
    assert.equal(client.log.length, 1);
  });
});

describe('approveAll', () => {
  it('is one UPDATE scoped by store, never the default language, only rows with a story', async () => {
    const client = recordingClient();
    const repo = createStoreTranslationRepository({ client, now: () => NOW });
    await repo.approveAll(STORE, 'gu');
    assert.equal(client.log.length, 1);
    const [entry] = client.log;
    assert.deepEqual(callsNamed(entry, 'update')[0][1], { approved: true, updated_at: '2026-11-16T10:00:00.000Z' });
    assert.deepEqual(callsNamed(entry, 'eq').map((call) => call.slice(1)), [['store_id', STORE], ['approved', false]]);
    assert.deepEqual(callsNamed(entry, 'neq').map((call) => call.slice(1)), [['language', 'gu'], ['story', '']]);
    for (const bad of [undefined, '', 'abc', null]) await assert.rejects(repo.approveAll(bad, 'gu'), TypeError);
    assert.equal(client.log.length, 1);
  });
});
