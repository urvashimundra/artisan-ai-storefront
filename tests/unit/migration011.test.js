import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EMAIL_LIMITS } from '../../src/domain/emailRules.js';

const read = (relative) => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8');
const migration = read('db/migrations/011_email_hardening.sql');
const code = migration.replace(/--.*$/gm, '');
const smoke = read('db/test/011_email_hardening_smoke.sql');
const races = read('db/test/011_email_races.sql');
const verify = read('db/verify/011_email_hardening_checks.sql');
const FUNCTIONS = {
  email_serialize: '', email_enqueue: 'uuid, text, text, text, text, text, jsonb, text, text', email_enqueue_order: 'uuid, text, text',
  order_cancel_locked: 'uuid, text', expire_overdue_orders: 'uuid, uuid[]', place_order: 'uuid, text, text, text, text, text, text, text, bigint, jsonb, text',
  submit_payment_reference: 'uuid, text, text', resolve_payment: 'uuid, uuid, uuid, text', cancel_order: 'uuid, uuid, text, uuid, text',
};
const bodyOf = (name) => code.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`))[0];
const afterBegin = (name) => {
  const body = bodyOf(name);
  return body.slice(body.indexOf('BEGIN\n') + 'BEGIN\n'.length).trimStart();
};

describe('migration 011 text', () => {
  it('every function is SECURITY INVOKER with a pinned search_path, revoked from public roles and granted to service_role only', () => {
    assert.doesNotMatch(code, /SECURITY DEFINER/i);
    for (const [name, args] of Object.entries(FUNCTIONS)) {
      assert.match(bodyOf(name), /SET search_path = public, pg_temp/, `${name} search_path`);
      assert.ok(code.includes(`REVOKE EXECUTE ON FUNCTION public.${name}(${args}) FROM PUBLIC, anon, authenticated;`), `${name} revoke`);
      assert.ok(code.includes(`GRANT EXECUTE ON FUNCTION public.${name}(${args}) TO service_role;`), `${name} grant`);
    }
    assert.doesNotMatch(code, /GRANT EXECUTE[^;]*(PUBLIC|anon|authenticated)/);
  });

  it('serializes email queuing with one advisory lock, taken first in every order function and in email_enqueue', () => {
    assert.match(bodyOf('email_serialize'), /pg_advisory_xact_lock\(7010011\)/);
    assert.ok(smoke.includes('objid = 7010011'));
    for (const name of ['email_enqueue', 'place_order', 'submit_payment_reference', 'resolve_payment', 'cancel_order']) {
      assert.ok(afterBegin(name).includes('PERFORM public.email_serialize();'), `${name} takes the lock`);
    }
    for (const name of ['place_order', 'submit_payment_reference', 'resolve_payment', 'cancel_order']) {
      assert.ok(afterBegin(name).startsWith('PERFORM public.email_serialize();'), `${name} takes the lock as its first statement`);
    }
    const sweep = bodyOf('expire_overdue_orders');
    assert.ok(sweep.indexOf('email_serialize') > sweep.indexOf('RETURN 0;\n  END IF;\n  PERFORM'), 'the sweep locks only when something is overdue');
    assert.ok(sweep.indexOf('email_serialize') < sweep.indexOf('FOR UPDATE OF o SKIP LOCKED'), 'and before it locks any order');
  });

  it('keeps the limits and the order logic of 010', () => {
    const constant = (name) => Number(code.match(new RegExp(`${name} +CONSTANT integer := (\\d+);`))?.[1]);
    assert.equal(constant('c_customer_per_hour'), EMAIL_LIMITS.customerPerHour);
    assert.equal(constant('c_customer_per_day'), EMAIL_LIMITS.customerPerDay);
    assert.equal(constant('c_seller_per_hour'), EMAIL_LIMITS.sellerPerHour);
    assert.equal(constant('c_global_per_hour'), EMAIL_LIMITS.globalPerHour);
    assert.ok(bodyOf('resolve_payment').includes('order_resubmit_interval()'));
    assert.ok(bodyOf('place_order').includes('order_expiry_interval()'));
  });

  it('stores only ciphertext: a constrained column, no link argument, no plaintext token', () => {
    assert.ok(code.includes('orders_status_token_enc_check'));
    assert.ok(bodyOf('place_order').includes('p_status_token_enc'));
    assert.doesNotMatch(code, /p_status_link|p_token\b|'link'/);
    assert.ok(bodyOf('email_enqueue_order').includes("'token_enc'"));
  });

  it('leaves migrations 008, 009 and 010 alone and ships verify, smoke and race scripts', () => {
    for (const earlier of ['008_orders', '009_order_reservation_10min', '010_email_outbox_contact']) {
      assert.doesNotMatch(read(`db/migrations/${earlier}.sql`), /email_serialize|status_token_enc/, earlier);
    }
    assert.match(smoke, /ERRCODE = 'AB001'/);
    for (const phrase of ['order_placed carries it', 'order_cancelled carries it', 'order_expired carries it', 'seller alerts never carry', 'SECURITY DEFINER', 'malformed ciphertext']) {
      assert.ok(smoke.includes(phrase), phrase);
    }
    for (const phrase of ['PER-RECIPIENT LIMIT', 'GLOBAL CAP', 'NO DEADLOCK']) assert.ok(races.includes(phrase), phrase);
    for (const phrase of ['SECURITY INVOKER', 'only service_role', 'same owner as', 'takes the lock first']) assert.ok(verify.includes(phrase), phrase);
  });
});
