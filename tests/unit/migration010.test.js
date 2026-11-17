import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EMAIL_CONSTRAINTS, EMAIL_FUNCTIONS, EMAIL_INDEXES } from '../../src/domain/dbConstraints.js';
import {
  EMAIL_KIND_VALUES, EMAIL_LIMITS, EMAIL_STATUSES, MAX_ATTEMPTS, MAX_BODY_LENGTH, MAX_CONTACT_MESSAGE_LENGTH, MAX_CONTACT_NAME_LENGTH,
  MAX_SUBJECT_LENGTH, RETRY_DELAYS_SECONDS,
} from '../../src/domain/emailRules.js';

const read = (relative) => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8');
const migration = read('db/migrations/010_email_outbox_contact.sql');
const verify = read('db/verify/010_email_checks.sql');
const smoke = read('db/test/010_email_smoke.sql');
const migration009 = read('db/migrations/009_order_reservation_10min.sql');
const code = migration.replace(/--.*$/gm, '');
const ALL_FUNCTIONS = [...EMAIL_FUNCTIONS, 'order_cancel_locked', 'place_order', 'submit_payment_reference', 'resolve_payment'];

describe('migration 010 text', () => {
  it('declares the named constraints and indexes the app relies on, and verifies them', () => {
    for (const name of [...Object.values(EMAIL_CONSTRAINTS), ...EMAIL_INDEXES]) {
      assert.ok(migration.includes(name), name);
      assert.ok(verify.includes(`'${name}'`), `verify ${name}`);
    }
  });

  it('mirrors kinds, statuses and column limits', () => {
    for (const kind of EMAIL_KIND_VALUES) assert.ok(code.includes(`'${kind}'`), kind);
    for (const status of Object.values(EMAIL_STATUSES)) assert.ok(code.includes(`'${status}'`), status);
    assert.ok(code.includes(`char_length(subject) <= ${MAX_SUBJECT_LENGTH}`));
    assert.ok(code.includes(`char_length(body) <= ${MAX_BODY_LENGTH}`));
    assert.ok(code.includes(`CHECK (char_length(name) BETWEEN 1 AND ${MAX_CONTACT_NAME_LENGTH})`));
    assert.ok(code.includes(`CHECK (char_length(message) BETWEEN 1 AND ${MAX_CONTACT_MESSAGE_LENGTH})`));
    assert.ok(code.includes(String.raw`subject !~ '[\r\n]'`));
  });

  it('mirrors the abuse limits', () => {
    const constant = (name) => Number(code.match(new RegExp(`${name} +CONSTANT integer := (\\d+);`))?.[1]);
    assert.equal(constant('c_customer_per_hour'), EMAIL_LIMITS.customerPerHour);
    assert.equal(constant('c_customer_per_day'), EMAIL_LIMITS.customerPerDay);
    assert.equal(constant('c_seller_per_hour'), EMAIL_LIMITS.sellerPerHour);
    assert.equal(constant('c_global_per_hour'), EMAIL_LIMITS.globalPerHour);
  });

  it('mirrors the maximum attempts and the retry schedule length', () => {
    assert.equal(Number(code.match(/c_max_attempts CONSTANT integer := (\d+);/)[1]), MAX_ATTEMPTS);
    assert.ok(code.includes(`attempts BETWEEN 0 AND ${MAX_ATTEMPTS}`));
    assert.ok(code.includes(`attempts >= ${MAX_ATTEMPTS}`));
    assert.equal(RETRY_DELAYS_SECONDS.length, MAX_ATTEMPTS - 1);
  });

  it('every function pins search_path, revokes from public, anon and authenticated, and grants to service_role only', () => {
    for (const name of ALL_FUNCTIONS) {
      assert.match(code, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?SET search_path = public, pg_temp`), `${name} search_path`);
      assert.match(code, new RegExp(`REVOKE EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`), `${name} revoke`);
      assert.match(code, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) TO service_role;`), `${name} grant`);
    }
    assert.doesNotMatch(code, /GRANT EXECUTE[^;]*(PUBLIC|anon|authenticated)/);
  });

  it('enables RLS with no policies, and uses no dynamic SQL', () => {
    for (const table of ['email_outbox', 'contact_messages']) {
      assert.match(code, new RegExp(`ALTER TABLE public\\.${table}\\s+ENABLE ROW LEVEL SECURITY`));
    }
    assert.doesNotMatch(code, /CREATE POLICY/i);
    assert.doesNotMatch(code, /\bEXECUTE\s+(?!ON\b)/);
  });

  it('claims with SKIP LOCKED and leaves migration 009 untouched by email work', () => {
    assert.match(code, /FOR UPDATE SKIP LOCKED/);
    assert.doesNotMatch(migration009, /email/i);
  });

  it('hooks every order transition into the outbox inside the same function', () => {
    for (const kind of ['order_placed', 'order_payment_received', 'seller_payment_submitted', 'order_confirmed', 'order_payment_not_found', 'order_expired', 'order_cancelled']) {
      assert.ok(code.includes(`'${kind}'`), kind);
    }
    assert.equal((code.match(/PERFORM public\.email_enqueue_order\(/g) ?? []).length, 6);
  });

  it('the smoke test rolls back with a sentinel and covers every path', () => {
    assert.match(smoke, /ERRCODE = 'AB001'/);
    for (const phrase of ['lease expired', 'dead at once', 'global hourly cap', 'queues nothing', 'no stock stays reserved', 'LF in subject rejected']) {
      assert.ok(smoke.includes(phrase), phrase);
    }
  });
});
