import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const read = (relative) => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8');
const migration = read('db/migrations/013_conversations.sql');
const backfill = read('db/migrations/014_conversations_backfill.sql');
const verify = read('db/verify/013_conversations_checks.sql');
const smoke = read('db/test/013_conversations_smoke.sql');
const races = read('db/test/013_conversations_races.sql');
const rollback = read('db/rollback/013_conversations_rollback.sql');
const code = (sql) => sql.replace(/--.*$/gm, '').replace(/'(?:[^']|'')*'/g, "''");
const FUNCTIONS = [
  'conversation_india_day', 'conversation_take_customer_slot', 'conversation_reserve_ai', 'conversation_settle_ai', 'conversation_begin_run',
  'conversation_start', 'conversation_post_message', 'conversation_finish_run', 'conversation_seller_reply', 'conversation_delete',
  'conversation_purge_expired',
];

describe('migration 013 text', () => {
  it('is additive: it never alters or drops the legacy tables', () => {
    const sql = code(migration);
    assert.doesNotMatch(sql, /(ALTER|DROP|TRUNCATE)\s+TABLE\s+(IF EXISTS\s+)?(public\.)?(enquiries|store_knowledge)/i);
    assert.doesNotMatch(sql, /DROP\s+TABLE/i);
  });

  it('enables RLS with no policy on every table, revokes browser roles and grants service_role only', () => {
    const sql = code(migration);
    for (const table of ['conversations', 'conversation_messages', 'conversation_usage']) {
      assert.match(sql, new RegExp(`ALTER TABLE public\\.${table}\\s+ENABLE ROW LEVEL SECURITY`));
    }
    assert.match(sql, /REVOKE ALL ON TABLE public\.conversations, public\.conversation_messages, public\.conversation_usage FROM PUBLIC, anon, authenticated/);
    assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.conversations, public\.conversation_messages, public\.conversation_usage TO service_role/);
    assert.doesNotMatch(sql, /CREATE POLICY/i);
  });

  it('pins search_path, uses SECURITY INVOKER and restricts EXECUTE for every function', () => {
    const sql = code(migration);
    assert.doesNotMatch(sql, /SECURITY DEFINER/i);
    const created = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((match) => match[1]);
    assert.deepEqual([...created].sort(), [...FUNCTIONS].sort());
    const pinned = [...sql.matchAll(/SET search_path = public, pg_temp/g)].length;
    assert.equal(pinned, FUNCTIONS.length);
    for (const name of FUNCTIONS) {
      assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC, anon, authenticated`), `revoke ${name}`);
      assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) TO service_role`), `grant ${name}`);
    }
  });

  it('keys everything by store: composite foreign keys and store-scoped lookups', () => {
    assert.match(migration, /FOREIGN KEY \(conversation_id, store_id\)\s+REFERENCES public\.conversations \(id, store_id\) ON DELETE CASCADE/);
    assert.match(migration, /FOREIGN KEY \(product_id, store_id\) REFERENCES public\.products \(id, store_id\)/);
    assert.match(migration, /UNIQUE \(store_id, start_key\)/);
    const sql = code(migration);
    for (const match of sql.matchAll(/FROM public\.conversations\s+WHERE ([^;]*?)(FOR UPDATE|;|\n\s*IF)/g)) {
      assert.match(match[1], /store_id = /, `unscoped conversations lookup: ${match[1]}`);
    }
  });

  it('mirrors the limits: 6 questions, 200 answers, 200 messages, 12 months, India day', () => {
    assert.match(migration, /c_limit CONSTANT integer := 6;/);
    assert.match(migration, /c_limit CONSTANT integer := 200;/);
    assert.match(migration, /c_customer_max_count CONSTANT integer := 198;/);
    assert.match(migration, /v_conv\.message_count >= 210/);
    assert.match(migration, /interval '12 months'/);
    assert.match(migration, /AT TIME ZONE 'Asia\/Kolkata'/);
  });

  it('makes both limits atomic: single-statement upserts with the limit in the WHERE, no read-then-write', () => {
    assert.match(migration, /DO UPDATE SET used = u\.used \+ 1 WHERE u\.used < c_limit/);
    assert.match(migration, /DO UPDATE SET reserved = u\.reserved \+ 1 WHERE u\.used \+ u\.reserved < c_limit/);
  });

  it('allows one run per conversation (row lock plus ai_run_id) and settles a run only once', () => {
    assert.match(migration, /conversations_ai_run_check/);
    assert.match(migration, /AND ai_run_id = p_run_id FOR UPDATE/);
    assert.match(migration, /ai_run_id = NULL, ai_run_day = NULL, ai_run_started_at = NULL/);
    assert.match(migration, /IF v_conv\.ai_run_id IS NOT NULL THEN\s+RETURN jsonb_build_object\('ok', false, 'reason', 'busy'\)/);
  });

  it('keeps customer numbers out of the usage table (hashed subject) and indexes idempotency keys', () => {
    assert.match(migration, /encode\(sha256\(convert_to\(p_phone, 'UTF8'\)\), 'hex'\)/);
    assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS conversation_messages_client_msg_key .*WHERE client_msg_id IS NOT NULL/);
  });
});

describe('migration 014 (optional backfill) text', () => {
  it('is idempotent, copies only settled enquiries, and never writes to the legacy tables or the outbox', () => {
    const sql = code(backfill);
    assert.match(sql, /NOT EXISTS \(SELECT 1 FROM public\.conversations c WHERE c\.legacy_enquiry_id = e\.id\)/);
    assert.match(sql, /status IN \(''?, ''?, ''?\)|status IN \(/);
    assert.doesNotMatch(sql, /\b(UPDATE|DELETE)\b\s+(FROM\s+)?public\.(enquiries|email_outbox)/i);
    assert.doesNotMatch(sql, /INSERT INTO public\.(enquiries|email_outbox|conversation_usage)/i);
    assert.match(backfill, /NOT approved to run/);
  });
});

describe('013 verify, smoke, races and rollback scripts', () => {
  it('keeps the verify script read-only and covers every function and table', () => {
    assert.doesNotMatch(code(verify), /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/i);
    for (const name of FUNCTIONS) assert.ok(verify.includes(`'${name}'`), name);
    for (const name of ['conversations', 'conversation_messages', 'conversation_usage']) assert.ok(verify.includes(`'${name}'`), name);
  });

  it('smoke-tests the limits, idempotency, cross-store access, deletion, purge, RLS and rolls back', () => {
    assert.match(smoke, /USING ERRCODE = 'AB001'/);
    assert.match(smoke, /ALL CHECKS PASSED/);
    for (const text of ['seventh question refused', '201st is escalated', 'another store cannot', 'seller reply double submit', 'purge deletes expired', 'RLS enabled', 'function privileges']) {
      assert.ok(smoke.includes(text), text);
    }
  });

  it('documents two-session race scenarios for both limits, one run, idempotency and single settlement', () => {
    for (const text of ['CUSTOMER LIMIT', 'STORE LIMIT', 'ONE RUN PER CONVERSATION', 'IDEMPOTENT SUBMISSION', 'SETTLE ONCE', 'CLEANUP']) assert.ok(races.includes(text), text);
  });

  it('rolls back only conversation objects', () => {
    assert.doesNotMatch(code(rollback), /DROP TABLE IF EXISTS public\.(enquiries|store_knowledge|email_outbox|ai_budget)/);
    for (const name of FUNCTIONS) assert.ok(rollback.includes(`public.${name}(`), name);
  });
});
