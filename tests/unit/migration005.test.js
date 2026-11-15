import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { STALE_GENERATION_MS } from '../../src/services/listingService.js';
import { MAX_STOCK } from '../../src/domain/productForm.js';
import { MAX_PRICE_PAISE, MAX_PRODUCT_STORY_LENGTH } from '../../src/domain/productRules.js';

const read = (relative) => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8');
const migration = read('db/migrations/005_generation_fencing.sql');
const verify = read('db/verify/005_generation_fencing_checks.sql');
const smoke = read('db/test/005_generation_fencing_smoke.sql');
const migration004 = read('db/migrations/004_products.sql');

const SAVE_AI = 'save_ai_listing(uuid, uuid, uuid, jsonb, text, int, int, bigint)';
const SAVE_REVIEW = 'save_product_review(uuid, uuid, text, int, bigint, jsonb, text[], boolean)';
const OLD_SAVE_AI = 'save_ai_listing(uuid, uuid, jsonb, text, int, int, bigint)';
const OLD_SAVE_REVIEW = 'save_product_review(uuid, uuid, bigint, jsonb, text[], boolean)';

describe('migration 005 text', () => {
  it('adds a nullable uuid fencing column and nothing else to the table', () => {
    assert.match(migration, /ALTER TABLE public\.products ADD COLUMN IF NOT EXISTS ai_generation_id uuid;/);
    assert.equal(migration.match(/ALTER TABLE/g).length, 2);
    assert.doesNotMatch(migration, /DROP (TABLE|COLUMN) (?!ai_generation_id)/);
  });

  it('drops the migration-004 signatures so no un-fenced function stays callable', () => {
    assert.ok(migration.includes(`DROP FUNCTION IF EXISTS public.${OLD_SAVE_AI};`));
    assert.ok(migration.includes(`DROP FUNCTION IF EXISTS public.${OLD_SAVE_REVIEW};`));
    assert.ok(migration004.includes('p_store_id uuid, p_product_id uuid, p_translations jsonb, p_model text'));
  });

  it('creates exactly the two functions with the new signatures, pinned search_path and service_role-only grants', () => {
    assert.deepEqual([...migration.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)/g)].map((m) => m[1]), ['save_ai_listing', 'save_product_review']);
    assert.equal(migration.match(/SET search_path = public, pg_temp/g).length, 2);
    for (const signature of [SAVE_AI, SAVE_REVIEW]) {
      assert.ok(migration.includes(`REVOKE EXECUTE ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated;`), signature);
      assert.ok(migration.includes(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role;`), signature);
    }
    assert.doesNotMatch(migration, /SECURITY DEFINER|CREATE POLICY|DISABLE ROW LEVEL SECURITY/i);
  });

  it('takes the product row lock scoped by store and product in both functions', () => {
    assert.equal(migration.match(/WHERE id = p_product_id AND store_id = p_store_id FOR UPDATE/g).length, 2);
    assert.equal(migration.match(/'reason', 'not_found'/g).length, 2);
  });

  it('save_ai_listing refuses a missing, stale or mismatched token before any write', () => {
    const body = migration.slice(migration.indexOf('FUNCTION public.save_ai_listing'), migration.indexOf('FUNCTION public.save_product_review'));
    const guard = body.indexOf("p_generation_id IS NULL OR v_token IS DISTINCT FROM p_generation_id");
    assert.ok(guard > 0 && body.includes("'stale_generation'"));
    assert.ok(guard < body.indexOf('INSERT INTO public.product_translations'));
    assert.ok(guard < body.indexOf('INSERT INTO public.ai_drafts'));
    assert.match(body, /ai_status = 'idle', ai_started_at = NULL, ai_generation_id = NULL/);
  });

  it('save_product_review checks generation and validation before its first write, and writes story and stock itself', () => {
    const body = migration.slice(migration.indexOf('FUNCTION public.save_product_review'));
    const firstWrite = body.indexOf('INSERT INTO public.product_translations');
    for (const gate of ["'reason', 'generating'", "'reason', 'price_required'", "'reason', 'default_language_not_approved'", "'reason', 'invalid'"]) {
      assert.ok(body.indexOf(gate) > 0 && body.indexOf(gate) < firstWrite, gate);
    }
    assert.match(body, /SET story = p_story,\s+stock = p_stock,/);
    assert.match(body, /ai_generation_id = CASE WHEN ai_status = 'generating' THEN NULL ELSE ai_generation_id END/);
  });

  it('mirrors the application constants: stale window, story, stock and price limits', () => {
    assert.equal(STALE_GENERATION_MS, 180_000);
    assert.match(migration, /interval '180 seconds'/);
    assert.match(migration, new RegExp(`char_length[(]p_story[)] > ${MAX_PRODUCT_STORY_LENGTH}`));
    assert.match(migration, new RegExp(`p_stock > ${MAX_STOCK}`));
    assert.match(migration, new RegExp(`p_price_paise > ${MAX_PRICE_PAISE}`));
  });

  it('is not destructive to data and keeps a documented rollback', () => {
    assert.doesNotMatch(migration, /TRUNCATE|DELETE FROM|DROP TABLE(?! IF)/i);
    assert.match(migration, /-- Rollback \(NOT executed/);
  });
});

describe('migration 005 verify and smoke scripts', () => {
  it('verify checks the column, both new signatures, grants and search_path, and is read-only', () => {
    assert.match(verify, /ai_generation_id/);
    assert.ok(verify.includes('p_store_id uuid, p_product_id uuid, p_generation_id uuid, p_translations jsonb'));
    assert.ok(verify.includes('p_story text, p_stock integer, p_price_paise bigint'));
    assert.match(verify, /exactly_two_functions_old_signatures_dropped/);
    assert.doesNotMatch(verify, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|GRANT|REVOKE)\b/);
  });

  it('smoke test rolls back through the sentinel and covers every required scenario', () => {
    assert.match(smoke, /RAISE EXCEPTION 'smoke complete, rolling back' USING ERRCODE = 'AB001'/);
    for (const scenario of [
      'NULL token refused', 'wrong token refused', 'superseded token refused', 'stale token clears nothing',
      'refused while generating', 'succeeds after generation', 'refusals left story and stock untouched',
      'late save after deletion', 'other store gets not_found', 'second claim while generating gets nothing',
    ]) {
      assert.ok(smoke.includes(scenario), scenario);
    }
  });
});
