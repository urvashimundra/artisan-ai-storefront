import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ASSISTANT_CONSTRAINTS, ASSISTANT_INDEXES } from '../../src/domain/dbConstraints.js';
import {
  ENQUIRY_STATUSES, FLAG_REASONS, MAX_ANSWER_LENGTH, MAX_ENQUIRY_NAME_LENGTH, MAX_QUESTION_LENGTH, MAX_REPLY_LENGTH, MAX_TRACE_ITEMS,
} from '../../src/domain/enquiryRules.js';
import { MAX_BULK_TIERS, MAX_KNOWLEDGE_LENGTH } from '../../src/domain/knowledgeRules.js';
import { LANGUAGES } from '../../src/domain/storeRules.js';

const read = (relative) => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8');
const migration = read('db/migrations/012_assistant.sql');
const verify = read('db/verify/012_assistant_checks.sql');
const smoke = read('db/test/012_assistant_smoke.sql');
const code = (sql) => sql.replace(/--.*$/gm, '').replace(/'(?:[^']|'')*'/g, "''");

describe('migration 012 text', () => {
  it('declares, verifies and smoke-tests every named constraint and index', () => {
    for (const name of Object.values(ASSISTANT_CONSTRAINTS)) {
      assert.match(migration, new RegExp(`CONSTRAINT ${name}\s`), `migration ${name}`);
      assert.ok(verify.includes(`'${name}'`), `verify ${name}`);
      assert.ok(smoke.includes(name) || name === ASSISTANT_CONSTRAINTS.enquiryPkey, `smoke ${name}`);
    }
    for (const name of ASSISTANT_INDEXES) {
      assert.ok(migration.includes(`INDEX IF NOT EXISTS ${name} `), `migration ${name}`);
      assert.ok(verify.includes(`'${name}'`), `verify ${name}`);
    }
  });

  it('mirrors the limits, languages, statuses and flag reasons used by Zod', () => {
    assert.ok(migration.includes(`char_length(content) <= ${MAX_KNOWLEDGE_LENGTH})`));
    assert.ok(migration.includes(`jsonb_array_length(bulk_rules) <= ${MAX_BULK_TIERS}`));
    assert.ok(migration.includes(`char_length(question) BETWEEN 1 AND ${MAX_QUESTION_LENGTH}`));
    assert.ok(migration.includes(`char_length(customer_name) BETWEEN 1 AND ${MAX_ENQUIRY_NAME_LENGTH}`));
    assert.ok(migration.includes(`char_length(answer_text) BETWEEN 1 AND ${MAX_ANSWER_LENGTH}`));
    assert.ok(migration.includes(`char_length(seller_reply) BETWEEN 1 AND ${MAX_REPLY_LENGTH}`));
    assert.ok(migration.includes(`jsonb_array_length(trace) <= ${MAX_TRACE_ITEMS}`));
    for (const value of [...LANGUAGES, ...ENQUIRY_STATUSES, ...FLAG_REASONS]) assert.ok(migration.includes(`'${value}'`), value);
  });

  it('keys enquiries by store, hashes the token and encrypts a copy for the seller link', () => {
    assert.match(migration, /token_hash\s+text\s+NOT NULL/);
    assert.match(migration, /token_enc\s+text,/);
    assert.match(migration, /FOREIGN KEY \(product_id, store_id\) REFERENCES public\.products \(id, store_id\)/);
    assert.match(migration, /FOREIGN KEY \(store_id\) REFERENCES public\.stores \(id\) ON DELETE CASCADE/);
    assert.match(migration, /\(store_id, status, created_at DESC\)/);
  });

  it('enables RLS with no policy, revokes browser roles, grants service_role only, and adds no functions', () => {
    const sql = code(migration);
    assert.match(sql, /ALTER TABLE public\.store_knowledge ENABLE ROW LEVEL SECURITY/);
    assert.match(sql, /ALTER TABLE public\.enquiries\s+ENABLE ROW LEVEL SECURITY/);
    assert.match(sql, /REVOKE ALL ON TABLE public\.store_knowledge, public\.enquiries FROM PUBLIC, anon, authenticated/);
    assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.store_knowledge, public\.enquiries TO service_role/);
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
