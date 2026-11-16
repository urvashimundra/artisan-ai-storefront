import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ORDER_CONSTRAINTS, ORDER_FUNCTIONS, ORDER_INDEXES } from '../../src/domain/dbConstraints.js';
import {
  MAX_ADDRESS_LENGTH, MAX_CUSTOMER_NAME_LENGTH, MAX_EMAIL_LENGTH, MAX_QUANTITY, MAX_UTR_SUBMISSIONS, MIN_QUANTITY, ORDER_EXPIRY_MINUTES, ORDER_STATUSES,
  CANCEL_REASONS,
} from '../../src/domain/orderRules.js';

const read = (relative) => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8');
const migration = read('db/migrations/008_orders.sql');
const verify = read('db/verify/008_orders_checks.sql');
const smoke = read('db/test/008_orders_smoke.sql');
const races = read('db/test/008_orders_races.sql');
const code = migration.replace(/--.*$/gm, '');
const ALL_FUNCTIONS = [...ORDER_FUNCTIONS, 'order_cancel_locked', 'order_owner_matches', 'order_parse_items', 'order_expiry_interval'];

describe('migration 008 text', () => {
  it('declares the named constraints and indexes the app relies on, and verifies them', () => {
    for (const name of [...Object.values(ORDER_CONSTRAINTS), ...ORDER_INDEXES]) {
      assert.ok(migration.includes(name), name);
      assert.ok(verify.includes(`'${name}'`), `verify ${name}`);
    }
  });

  it('mirrors the limits in the domain rules', () => {
    assert.match(code, new RegExp(`quantity BETWEEN ${MIN_QUANTITY} AND ${MAX_QUANTITY}`));
    assert.match(code, new RegExp(`utr_submissions BETWEEN 0 AND ${MAX_UTR_SUBMISSIONS}`));
    assert.match(code, new RegExp(`utr_submissions >= ${MAX_UTR_SUBMISSIONS}`));
    assert.match(code, new RegExp(`customer_name\\) BETWEEN 1 AND ${MAX_CUSTOMER_NAME_LENGTH}`));
    assert.match(code, new RegExp(`delivery_address\\) BETWEEN 1 AND ${MAX_ADDRESS_LENGTH}`));
    assert.match(code, new RegExp(`customer_email\\) <= ${MAX_EMAIL_LENGTH}`));
    assert.match(code, new RegExp(`interval '${ORDER_EXPIRY_MINUTES / 60} hour'`));
    for (const status of ORDER_STATUSES) assert.ok(code.includes(`'${status}'`), status);
    for (const reason of CANCEL_REASONS) assert.ok(code.includes(`'${reason}'`), reason);
  });

  it('every function pins search_path, revokes from public, anon and authenticated, and grants to service_role only', () => {
    for (const name of ALL_FUNCTIONS) {
      const definition = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?SET search_path = public, pg_temp`);
      assert.match(code, definition, `${name} search_path`);
      assert.match(code, new RegExp(`REVOKE EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`), `${name} revoke`);
      assert.match(code, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) TO service_role;`), `${name} grant`);
    }
    assert.doesNotMatch(code, /GRANT EXECUTE[^;]*(PUBLIC|anon|authenticated)/);
  });

  it('enables RLS, adds no policies, and revokes table access from browser roles', () => {
    for (const table of ['store_order_counters', 'orders', 'order_items', 'order_payment_attempts']) {
      assert.match(code, new RegExp(`ALTER TABLE public\\.${table}\\s+ENABLE ROW LEVEL SECURITY`), table);
    }
    assert.doesNotMatch(code, /CREATE POLICY/i);
    assert.match(code, /REVOKE ALL ON TABLE[\s\S]*FROM PUBLIC, anon, authenticated/);
  });

  it('uses no dynamic SQL and no SELECT MAX for references, and allocates with UPDATE ... RETURNING semantics', () => {
    assert.doesNotMatch(code.replace(/(GRANT|REVOKE) EXECUTE/g, ''), /\bEXECUTE\b/i);
    assert.doesNotMatch(code, /\bmax\s*\(/i);
    assert.match(code, /ON CONFLICT \(store_id\) DO UPDATE SET last_number = public\.store_order_counters\.last_number \+ 1\s+RETURNING last_number/);
  });

  it('sweeps with FOR UPDATE SKIP LOCKED and restores stock only behind the stock_restored_at marker', () => {
    assert.match(code, /FOR UPDATE OF o SKIP LOCKED/);
    assert.match(code, /stock_restored_at IS NULL/);
    assert.match(code, /\(status = 'cancelled'\) = \(stock_restored_at IS NOT NULL\)/);
  });

  it('does not touch order_requests or send any email', () => {
    assert.doesNotMatch(code, /order_requests|email_outbox/i);
  });

  it('has verify and smoke files that exercise every function and the race scenarios', () => {
    for (const name of ORDER_FUNCTIONS) {
      assert.ok(verify.includes(`'${name}'`), `verify ${name}`);
      assert.ok(smoke.includes(name) || races.includes(name), `tests ${name}`);
    }
    for (const marker of ['LAST UNIT', 'CONCURRENT REFERENCES', 'CANCEL vs EXPIRY', 'EXPIRY vs NEW ORDER', 'CONCURRENT DUPLICATE UTR']) {
      assert.ok(races.includes(marker), marker);
    }
    assert.match(smoke, /ALL CHECKS PASSED/);
    assert.match(smoke, /AB001/);
  });
});
