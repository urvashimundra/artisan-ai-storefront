import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createOwnerRepository } from '../../src/repositories/ownerRepository.js';
import { createSessionRepository } from '../../src/repositories/sessionRepository.js';
import { createStoreRepository } from '../../src/repositories/storeRepository.js';

/** Records the query chain and resolves to the given result when awaited or when a terminal method is called. */
function fakeClient(result) {
  const calls = [];
  const chain = (table) => {
    const entry = { table, steps: [] };
    calls.push(entry);
    const proxy = new Proxy(
      {},
      {
        get: (_target, name) => {
          if (name === 'then') return (resolve) => resolve(result);
          return (...args) => (entry.steps.push([name, ...args]), proxy);
        },
      },
    );
    return proxy;
  };
  return { calls, client: { from: chain } };
}

describe('repository queries', () => {
  it('stores are looked up by owner_id taken from the caller, and inserts map camelCase to columns', async () => {
    const row = { id: 's1', owner_id: 'o1', slug: 'x', name: 'N', default_language: 'en', story: 'S', contact_email: null };
    const { calls, client } = fakeClient({ data: row, error: null });
    const repo = createStoreRepository({ client });
    const store = await repo.findByOwnerId('o1');
    assert.deepEqual(calls[0].steps.find((step) => step[0] === 'eq'), ['eq', 'owner_id', 'o1']);
    assert.equal(store.defaultLanguage, 'en');
    await repo.insert({ ownerId: 'o1', slug: 'x', name: 'N', defaultLanguage: 'en', story: 'S', tagline: 'T', accentKey: 'teal' });
    const inserted = { owner_id: 'o1', slug: 'x', name: 'N', default_language: 'en', story: 'S', tagline: 'T', accent_key: 'teal' };
    assert.deepEqual(calls[1].steps[0], ['insert', inserted]);
  });

  it('owners are inserted with is_demo exactly as passed and a Postgres error becomes UniqueViolation', async () => {
    const { calls, client } = fakeClient({ data: null, error: { code: '23505', message: 'violates unique constraint "owners_email_lower_key"' } });
    const repo = createOwnerRepository({ client });
    await assert.rejects(repo.insert({ email: 'a@b.test', passwordHash: 'h', isDemo: false }), { constraint: 'owners_email_lower_key' });
    assert.deepEqual(calls[0].steps[0], ['insert', { email: 'a@b.test', password_hash: 'h', is_demo: false }]);
  });

  it('session cleanup deletes only that owner and only expired rows', async () => {
    const { calls, client } = fakeClient({ error: null });
    await createSessionRepository({ client }).deleteExpiredForOwner('o1', '2026-11-15T00:00:00.000Z');
    assert.deepEqual(calls[0].steps, [
      ['delete'],
      ['eq', 'owner_id', 'o1'],
      ['lte', 'expires_at', '2026-11-15T00:00:00.000Z'],
    ]);
  });
});
