import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PRODUCT_CONSTRAINTS, PRODUCT_INDEXES } from '../../src/domain/dbConstraints.js';
import {
  MAX_ALT_TEXT_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_PRICE_PAISE,
  MAX_PRODUCT_STORY_LENGTH,
  MAX_TITLE_LENGTH,
} from '../../src/domain/productRules.js';

const read = (relative) => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8');
const migration = read('db/migrations/004_products.sql');
const verify = read('db/verify/004_product_checks.sql');
const smoke = read('db/test/004_product_smoke.sql');

const SAVE_AI = 'save_ai_listing(uuid, uuid, jsonb, text, int, int, bigint)';
const SAVE_REVIEW = 'save_product_review(uuid, uuid, bigint, jsonb, text[], boolean)';

describe('migration 004 text', () => {
  it('creates exactly the three tables and two functions', () => {
    assert.deepEqual([...migration.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+)/g)].map((m) => m[1]), ['products', 'product_translations', 'ai_drafts']);
    assert.deepEqual([...migration.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)/g)].map((m) => m[1]), ['save_ai_listing', 'save_product_review']);
  });

  it('enables RLS with no policies and revokes browser roles on every table', () => {
    for (const table of ['products', 'product_translations', 'ai_drafts']) {
      assert.match(migration, new RegExp(`ALTER TABLE public\\.${table}\\s+ENABLE ROW LEVEL SECURITY`));
    }
    assert.doesNotMatch(migration, /CREATE POLICY/i);
    assert.match(migration, /REVOKE ALL ON TABLE public\.products, public\.product_translations, public\.ai_drafts FROM PUBLIC, anon, authenticated/);
    assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE .* TO service_role/);
  });

  it('pins search_path on both functions and grants execute to service_role only', () => {
    assert.equal(migration.match(/SET search_path = public, pg_temp/g).length, 2);
    for (const signature of [SAVE_AI, SAVE_REVIEW]) {
      assert.ok(migration.includes(`REVOKE EXECUTE ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated;`), signature);
      assert.ok(migration.includes(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role;`), signature);
    }
    assert.doesNotMatch(migration, /SECURITY DEFINER/i);
  });

  it('checks product ownership by store_id inside both functions', () => {
    const lock = /WHERE id = p_product_id AND store_id = p_store_id FOR UPDATE/g;
    assert.equal(migration.match(lock).length, 2);
    assert.equal(migration.match(/'reason', 'not_found'/g).length, 2);
  });

  it('requires exactly three keys in every language object, in both functions', () => {
    assert.equal(migration.match(/SELECT count\(\*\) FROM jsonb_object_keys\(v_t\)\) <> 3/g).length, 2);
    assert.match(smoke, /ai listing: extra nested key/);
    assert.match(smoke, /ai listing: missing nested key/);
    assert.match(smoke, /review: extra nested key/);
    assert.match(smoke, /review: missing nested key/);
  });

  it('declares every constraint and index named in dbConstraints.js', () => {
    for (const name of PRODUCT_CONSTRAINTS) {
      assert.match(migration, new RegExp(`CONSTRAINT ${name}\\b`), name);
      assert.ok(verify.includes(`'${name}'`), `verify ${name}`);
    }
    for (const name of PRODUCT_INDEXES) {
      assert.match(migration, new RegExp(`INDEX IF NOT EXISTS ${name}\\b`), name);
      assert.ok(verify.includes(`'${name}'`), `verify ${name}`);
    }
  });

  it('mirrors the Zod length limits and price range', () => {
    assert.match(migration, new RegExp(`char_length\\(title\\) <= ${MAX_TITLE_LENGTH}\\)`));
    assert.match(migration, new RegExp(`char_length\\(description\\) <= ${MAX_DESCRIPTION_LENGTH}\\)`));
    assert.match(migration, new RegExp(`char_length\\(alt_text\\) <= ${MAX_ALT_TEXT_LENGTH}\\)`));
    assert.match(migration, new RegExp(`char_length\\(story\\) <= ${MAX_PRODUCT_STORY_LENGTH}\\)`));
    assert.match(migration, new RegExp(`price_paise <= ${MAX_PRICE_PAISE}\\)`));
    assert.equal(migration.match(new RegExp(`> ${MAX_PRICE_PAISE}`, 'g'))?.length, 1);
  });

  it('keeps the products index ordered newest first', () => {
    assert.match(migration, /products_store_id_created_at_idx ON public\.products \(store_id, created_at DESC\)/);
  });
});

describe('verification and smoke SQL', () => {
  it('verification is read-only', () => {
    const code = verify.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
    assert.doesNotMatch(code, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/i);
  });

  it('verification checks both exact signatures', () => {
    assert.match(verify, /p_store_id uuid, p_product_id uuid, p_translations jsonb, p_model text, p_tokens_in integer, p_tokens_out integer, p_cost bigint/);
    assert.match(verify, /p_store_id uuid, p_product_id uuid, p_price_paise bigint, p_translations jsonb, p_approved_langs text\[\], p_publish boolean/);
  });

  it('smoke test always rolls back through the sentinel and covers the required cases', () => {
    assert.match(smoke, /ERRCODE = 'AB001'/);
    assert.match(smoke, /WHEN SQLSTATE 'AB001' THEN/);
    for (const topic of ['not_found', 'price_required', 'default_language_not_approved', 'exactly en approved', 'source:', 'regen:', 'cascade:']) {
      assert.ok(smoke.includes(topic), topic);
    }
  });

  it('earlier migrations are untouched', () => {
    assert.match(read('db/migrations/003_ai_budget_sweep_order.sql'), /reserve_ai_budget/);
    assert.doesNotMatch(read('db/migrations/002_ai_budget.sql'), /products/);
  });
});
