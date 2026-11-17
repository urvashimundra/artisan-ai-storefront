import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LINK_KEY_PATTERN, createLinkCipher } from '../../src/lib/linkCipher.js';
import { generateStatusToken } from '../../src/lib/statusToken.js';
import { loadEnv } from '../../src/config/env.js';

const KEY = 'A'.repeat(43);
const MINIMAL = { NODE_ENV: 'test', BASE_URL: 'http://localhost:3000', SUPABASE_URL: 'https://p.supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };

describe('link cipher', () => {
  it('round-trips a status token, with a fresh IV each time and no plaintext in the output', () => {
    const cipher = createLinkCipher(KEY);
    const token = generateStatusToken();
    const first = cipher.encrypt(token);
    assert.notEqual(first, cipher.encrypt(token));
    assert.ok(!first.includes(token));
    assert.match(first, /^[A-Za-z0-9_-]{1,200}$/, 'fits the orders.status_token_enc check');
    assert.equal(cipher.decrypt(first), token);
  });

  it('returns null for a wrong key, tampering, truncation and junk', () => {
    const token = generateStatusToken();
    const sealed = createLinkCipher(KEY).encrypt(token);
    const tampered = `${sealed.slice(0, -2)}${sealed.endsWith('AA') ? 'BB' : 'AA'}`;
    for (const bad of [tampered, sealed.slice(0, 20), '', '!!!', 'x'.repeat(300)]) assert.equal(createLinkCipher(KEY).decrypt(bad), null);
    assert.equal(createLinkCipher('B'.repeat(43)).decrypt(sealed), null);
  });

  it('rejects a key of the wrong size, and ORDER_LINK_KEY is validated and optional', () => {
    assert.throws(() => createLinkCipher('short'), TypeError);
    assert.match(KEY, LINK_KEY_PATTERN);
    assert.equal(loadEnv(MINIMAL).orderLinkKey, undefined);
    assert.equal(loadEnv({ ...MINIMAL, ORDER_LINK_KEY: KEY }).orderLinkKey, KEY);
    assert.throws(() => loadEnv({ ...MINIMAL, ORDER_LINK_KEY: 'too-short' }), (error) => error.variables.join() === 'ORDER_LINK_KEY' && !error.message.includes('too-short'));
  });
});
