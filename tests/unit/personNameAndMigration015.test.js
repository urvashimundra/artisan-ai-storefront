import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { contactSchema } from '../../src/domain/contactRules.js';
import { startSchema } from '../../src/domain/conversationRules.js';
import { MAX_UTR_SUBMISSIONS } from '../../src/domain/orderRules.js';
import { isValidPersonName } from '../../src/domain/personName.js';

const LIMIT = 80;
const START = { phone: '98765 43210', message: 'Hello there', startKey: crypto.randomUUID(), messageId: crypto.randomUUID() };
const CONTACT = { email: 'a@b.test', message: 'Hello there' };

describe('person names (O4)', () => {
  it('accepts letters and combining marks in any script, spaces, apostrophes, hyphens and full stops', () => {
    for (const name of ['Asha Patel', 'આશા પટેલ', 'आशा पटेल', 'தமிழ் பெயர்', "D'Souza", 'D’Souza', 'Mary-Jane K.', 'Jo']) assert.equal(isValidPersonName(name, LIMIT), true, name);
  });

  it('rejects digits, symbols, one letter, and lengths outside 2 to 80 code points', () => {
    for (const name of ['', 'A', 'Asha 2', 'Asha#', '<b>Asha</b>', 'A.', '..', '- -', 'x'.repeat(LIMIT + 1)]) assert.equal(isValidPersonName(name, LIMIT), false, name);
    assert.equal(isValidPersonName('x'.repeat(LIMIT), LIMIT), true);
  });

  it('collapses and trims spaces in every form that takes a name', () => {
    assert.equal(startSchema.parse({ ...START, name: '  Asha   Patel ' }).name, 'Asha Patel');
    assert.equal(contactSchema.parse({ ...CONTACT, name: ' Asha   Patel' }).name, 'Asha Patel');
    assert.equal(startSchema.safeParse({ ...START, name: 'Asha 99' }).success, false);
    assert.equal(contactSchema.safeParse({ ...CONTACT, name: 'Asha 99' }).success, false);
    assert.equal(contactSchema.safeParse({ ...CONTACT, name: 'Asha\nPatel' }).success, false);
  });
});

describe('migration 015 text (O1)', () => {
  const sql = readFileSync(new URL('../../db/migrations/015_utr_attempts_exhausted.sql', import.meta.url), 'utf8');

  it('mirrors the attempt limit, adds the reason and cancels through the single cancel path', () => {
    assert.match(sql, new RegExp(`c_max_utr_submissions CONSTANT integer := ${MAX_UTR_SUBMISSIONS}`));
    assert.match(sql, /'utr_attempts_exhausted'\)\)/);
    assert.match(sql, /order_cancel_locked\(v_order\.id, 'utr_attempts_exhausted'\)/);
  });

  it('pins search_path and grants only service_role on every function', () => {
    for (const name of ['email_enqueue', 'email_enqueue_order', 'resolve_payment']) {
      assert.match(sql, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?SET search_path = public, pg_temp`), name);
      assert.match(sql, new RegExp(`REVOKE EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`), name);
      assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) TO service_role;`), name);
    }
  });
});
