import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { STOREFRONT_CONSTRAINTS, STOREFRONT_INDEXES } from '../../src/domain/dbConstraints.js';
import { ACCENT_KEYS } from '../../src/domain/palette.js';
import { INSTAGRAM_PATTERN, MAX_TAGLINE_LENGTH, MAX_UPI_LENGTH, UPI_PATTERN } from '../../src/domain/shopSettings.js';
import { WHATSAPP_PATTERN } from '../../src/domain/whatsapp.js';

const read = (relative) => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8');
const migration = read('db/migrations/006_storefront.sql');
const verify = read('db/verify/006_storefront_checks.sql');
const smoke = read('db/test/006_storefront_smoke.sql');
const sqlPattern = (regex) => regex.source;
const code = (sql) => sql.replace(/--.*$/gm, '').replace(/'(?:[^']|'')*'/g, "''");

describe('migration 006 text', () => {
  it('declares every named constraint and index, and verifies and smoke-tests them', () => {
    for (const name of Object.values(STOREFRONT_CONSTRAINTS)) {
      assert.match(migration, new RegExp(`ADD CONSTRAINT ${name}\\b`), name);
      assert.ok(verify.includes(`'${name}'`), `verify ${name}`);
      assert.ok(smoke.includes(`'${name}'`), `smoke ${name}`);
    }
    for (const name of STOREFRONT_INDEXES) {
      assert.match(migration, new RegExp(`INDEX IF NOT EXISTS ${name}\\b`), name);
      assert.ok(verify.includes(`'${name}'`) || verify.includes(name), `verify ${name}`);
    }
  });

  it('mirrors the accent keys, limits and patterns used by Zod', () => {
    for (const key of ACCENT_KEYS) assert.ok(migration.includes(`'${key}'`), key);
    assert.match(migration, new RegExp(`char_length\\(tagline\\) <= ${MAX_TAGLINE_LENGTH}\\)`));
    assert.ok(migration.includes(`'${sqlPattern(WHATSAPP_PATTERN)}'`));
    assert.ok(migration.includes(`'${sqlPattern(INSTAGRAM_PATTERN)}'`));
    assert.ok(migration.includes(`'${sqlPattern(UPI_PATTERN)}'`));
    assert.match(migration, new RegExp(`char_length\\(upi_id\\) <= ${MAX_UPI_LENGTH}\\b`));
  });

  it('requires the opt-in flag to come with a number', () => {
    assert.match(migration, /CHECK \(NOT whatsapp_enabled OR whatsapp_number IS NOT NULL\)/);
    assert.match(migration, /whatsapp_enabled\s+boolean NOT NULL DEFAULT false/);
  });

  it('adds only columns, constraints and the partial index: no functions, tables, RLS or grants', () => {
    assert.doesNotMatch(code(migration), /CREATE (OR REPLACE )?FUNCTION|CREATE TABLE|CREATE POLICY|GRANT |REVOKE |ENABLE ROW LEVEL/i);
    assert.match(migration, /\(store_id, created_at DESC, id DESC\) WHERE status = 'published'/);
  });

  it('keeps the verify script read-only and the smoke test self-rolling-back', () => {
    assert.doesNotMatch(code(verify), /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/i);
    assert.match(smoke, /USING ERRCODE = 'AB001'/);
    assert.match(smoke, /ALL CHECKS PASSED/);
  });
});
