import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { STORE_TRANSLATION_CONSTRAINTS } from '../../src/domain/dbConstraints.js';
import { MAX_TRANSLATED_STORY_LENGTH, MAX_TRANSLATED_TAGLINE_LENGTH, TRANSLATION_SOURCES } from '../../src/domain/storeTranslations.js';
import { LANGUAGES } from '../../src/domain/storeRules.js';

const read = (relative) => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8');
const migration = read('db/migrations/007_store_translations.sql');
const verify = read('db/verify/007_store_translations_checks.sql');
const smoke = read('db/test/007_store_translations_smoke.sql');
const stores = read('db/migrations/001_owners_sessions_stores.sql');
const code = (sql) => sql.replace(/--.*$/gm, '').replace(/'(?:[^']|'')*'/g, "''");

describe('migration 007 text', () => {
  it('declares every named constraint and verifies and smoke-tests each of them', () => {
    for (const name of Object.values(STORE_TRANSLATION_CONSTRAINTS)) {
      assert.ok(migration.includes(`CONSTRAINT ${name} `), name);
      assert.ok(verify.includes(`'${name}'`), `verify ${name}`);
      assert.ok(smoke.includes(name) || name.endsWith('_pkey') || name.endsWith('_fkey'), `smoke ${name}`);
    }
    for (const name of [STORE_TRANSLATION_CONSTRAINTS.pkey, STORE_TRANSLATION_CONSTRAINTS.storeFkey]) {
      assert.ok(smoke.includes(name), `smoke ${name}`);
    }
  });

  it('mirrors the limits, languages and sources used by Zod, and the stores.story maximum', () => {
    assert.ok(migration.includes(`char_length(tagline) <= ${MAX_TRANSLATED_TAGLINE_LENGTH})`));
    assert.ok(migration.includes(`char_length(story) <= ${MAX_TRANSLATED_STORY_LENGTH})`));
    assert.ok(stores.includes(`char_length(story) BETWEEN 1 AND ${MAX_TRANSLATED_STORY_LENGTH})`));
    for (const language of LANGUAGES) assert.ok(migration.includes(`'${language}'`), language);
    for (const source of TRANSLATION_SOURCES) assert.ok(migration.includes(`'${source}'`), source);
  });

  it('has the primary key, cascade foreign key and defaults', () => {
    assert.match(migration, /PRIMARY KEY \(store_id, language\)/);
    assert.match(migration, /FOREIGN KEY \(store_id\) REFERENCES public\.stores \(id\) ON DELETE CASCADE/);
    assert.match(migration, /tagline\s+text\s+NOT NULL DEFAULT ''/);
    assert.match(migration, /story\s+text\s+NOT NULL DEFAULT ''/);
    assert.match(migration, /approved\s+boolean\s+NOT NULL DEFAULT false/);
    assert.match(migration, /updated_at\s+timestamptz NOT NULL DEFAULT now\(\)/);
  });

  it('enables RLS with no policy, revokes browser roles, grants service_role only, and adds no functions', () => {
    const sql = code(migration);
    assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
    assert.match(sql, /REVOKE ALL ON TABLE public\.store_translations FROM PUBLIC, anon, authenticated/);
    assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.store_translations TO service_role/);
    assert.doesNotMatch(sql, /CREATE (OR REPLACE )?FUNCTION|CREATE POLICY/i);
  });

  it('keeps the verify script read-only, and the smoke test checks RLS and grants and rolls back', () => {
    assert.doesNotMatch(code(verify), /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/i);
    assert.match(smoke, /USING ERRCODE = 'AB001'/);
    assert.match(smoke, /ALL CHECKS PASSED/);
    for (const text of ['relrowsecurity', 'pg_policies', "has_table_privilege('anon'", "has_table_privilege('authenticated'"]) {
      assert.ok(smoke.includes(text), text);
    }
  });
});
