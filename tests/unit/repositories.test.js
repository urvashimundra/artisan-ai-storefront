import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { OWNERS_EMAIL_LOWER_KEY, STORES_SLUG_KEY } from '../../src/domain/dbConstraints.js';
import { UniqueViolation, constraintNameFrom, throwIfError } from '../../src/repositories/pgErrors.js';
import { requireStoreId } from '../../src/repositories/requireStoreId.js';
import { createSupabaseClient } from '../../src/repositories/supabaseClient.js';
import { createSupabaseProbe } from '../../src/repositories/supabaseProbe.js';

const REPOSITORY_DIR = fileURLToPath(new URL('../../src/repositories/', import.meta.url));
const OWNER_KEYED_OR_INFRASTRUCTURE = new Set([
  'aiBudgetRepository.js',
  'ownerRepository.js',
  'sessionRepository.js',
  'storeRepository.js',
  'supabaseClient.js',
  'supabaseProbe.js',
  'pgErrors.js',
  'requireStoreId.js',
]);
/**
 * The ONLY repository methods allowed to skip the storeId-first rule, by file and name (documented in
 * docs/DECISIONS.md): findShopBySlug resolves a validated slug to a store, listSitemapEntries is the single
 * cross-store query and selects public columns only. Every other method of those files must still take storeId first.
 */
const NON_STORE_SCOPED_ENTRY_POINTS = Object.freeze({ 'publicShopRepository.js': ['findShopBySlug', 'listSitemapEntries'] });
const STORE_ID = '3f2b8c1e-5a4d-4b7e-9c10-1d2e3f4a5b6c';

describe('Postgres error mapping', () => {
  it('reads the constraint name from the message, never from details', () => {
    const message = `duplicate key value violates unique constraint "${OWNERS_EMAIL_LOWER_KEY}"`;
    assert.equal(constraintNameFrom(message), OWNERS_EMAIL_LOWER_KEY);
    assert.equal(constraintNameFrom('something else'), 'unknown');
    assert.equal(constraintNameFrom(undefined), 'unknown');
  });

  it('throws UniqueViolation for 23505 with the constraint name', () => {
    const error = { code: '23505', message: `duplicate key value violates unique constraint "${STORES_SLUG_KEY}"`, details: 'Key (slug)=(x)' };
    assert.throws(() => throwIfError(error), (thrown) => {
      assert.ok(thrown instanceof UniqueViolation);
      assert.equal(thrown.constraint, STORES_SLUG_KEY);
      assert.doesNotMatch(JSON.stringify(thrown), /Key \(/);
      return true;
    });
  });

  it('turns other errors into a generic AppError without provider text, and ignores null', () => {
    throwIfError(null);
    const error = { code: '42P01', message: 'relation "secret_table" does not exist', details: 'leak' };
    assert.throws(() => throwIfError(error), (thrown) => {
      assert.equal(thrown.code, 'DATABASE_ERROR');
      assert.equal(thrown.httpStatus, 500);
      assert.doesNotMatch(thrown.message, /secret_table/);
      return true;
    });
  });
});

describe('shared Supabase client', () => {
  it('is built in one place with no session persistence, and the probe reuses it', () => {
    const seen = [];
    const createClient = (url, key, options) => (seen.push({ url, key, options }), { storage: { listBuckets: async () => ({ error: null }) } });
    createSupabaseClient({ url: 'https://x.test', serviceRoleKey: 'k' }, createClient);
    assert.deepEqual(seen[0].options.auth, { persistSession: false, autoRefreshToken: false });
    assert.equal(typeof seen[0].options.global.fetch, 'function');
    return createSupabaseProbe({ config: { url: 'https://x.test', serviceRoleKey: 'k' }, createClient })().then(() => {
      assert.deepEqual(seen[1].options.auth, seen[0].options.auth);
    });
  });
});

describe('tenancy guard for store-scoped repositories', () => {
  it('requireStoreId rejects a missing or malformed storeId', () => {
    for (const bad of [undefined, null, '', 'abc', 42, {}, `${STORE_ID}x`]) {
      assert.throws(() => requireStoreId(bad), TypeError);
    }
    assert.equal(requireStoreId(STORE_ID), STORE_ID);
  });

  it('every repository outside the owner-keyed allowlist takes storeId first and calls requireStoreId', () => {
    const files = readdirSync(REPOSITORY_DIR).filter((file) => file.endsWith('.js'));
    for (const file of files.filter((name) => !OWNER_KEYED_OR_INFRASTRUCTURE.has(name))) {
      const source = readFileSync(`${REPOSITORY_DIR}${file}`, 'utf8');
      const methods = [...source.matchAll(/^\s+async (\w+)\(([^)]*)\)/gm)];
      assert.ok(source.includes('requireStoreId('), `${file} must call requireStoreId`);
      for (const [, name, params] of methods) {
        if (NON_STORE_SCOPED_ENTRY_POINTS[file]?.includes(name)) continue;
        assert.match(params.trim(), /^storeId(,|$)/, `${file}#${name} must take storeId as first argument`);
      }
    }
  });

  it('owner-keyed repositories never accept a store_id from callers', () => {
    for (const file of ['ownerRepository.js', 'sessionRepository.js']) {
      const source = readFileSync(`${REPOSITORY_DIR}${file}`, 'utf8');
      assert.doesNotMatch(source, /store_id|storeId/, file);
    }
  });
});
