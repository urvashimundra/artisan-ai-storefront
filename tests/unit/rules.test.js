import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  emailSchema,
  loginSchema,
  newPasswordSchema,
  normalizeEmail,
  normalizePassword,
  signupSchema,
} from '../../src/domain/credentialRules.js';
import { RESERVED_SLUGS, SLUG_PATTERN } from '../../src/domain/dbConstraints.js';
import { slugSchema, storeSchema } from '../../src/domain/storeRules.js';

const MIGRATION = fileURLToPath(new URL('../../db/migrations/001_owners_sessions_stores.sql', import.meta.url));

describe('email and password rules', () => {
  it('normalizes email by trimming and lowercasing, and caps its length', () => {
    assert.equal(normalizeEmail('  Maker@Example.COM '), 'maker@example.com');
    assert.equal(emailSchema.parse('  Maker@Example.COM '), 'maker@example.com');
    assert.equal(emailSchema.safeParse(`${'a'.repeat(250)}@example.com`).success, false);
    assert.equal(emailSchema.safeParse('not-an-email').success, false);
  });

  it('enforces 12 to 128 characters at the boundaries', () => {
    assert.equal(newPasswordSchema.safeParse('a'.repeat(MIN_PASSWORD_LENGTH - 1)).success, false);
    assert.equal(newPasswordSchema.safeParse('a'.repeat(MIN_PASSWORD_LENGTH)).success, true);
    assert.equal(newPasswordSchema.safeParse('a'.repeat(MAX_PASSWORD_LENGTH)).success, true);
    assert.equal(newPasswordSchema.safeParse('a'.repeat(MAX_PASSWORD_LENGTH + 1)).success, false);
  });

  it('applies NFKC before measuring, so expansion cannot exceed the 128 cap', () => {
    assert.equal(normalizePassword('ｐａｓｓ'), 'pass');
    assert.equal('ﷺ'.normalize('NFKC').length, 18);
    const expanding = 'ﷺ'.repeat(8);
    assert.ok(expanding.length < MAX_PASSWORD_LENGTH);
    assert.equal(newPasswordSchema.safeParse(expanding).success, false);
    assert.equal(loginSchema.safeParse({ email: 'a@b.test', password: expanding }).success, false);
    assert.equal(newPasswordSchema.safeParse('ﷺ'.repeat(7)).success, true);
  });

  it('counts the normalized form against the minimum too', () => {
    assert.equal(newPasswordSchema.safeParse('ﷺ').success, true);
    assert.equal(newPasswordSchema.parse('ｐａｓｓｗｏｒｄ１２３４'), 'password1234');
  });

  it('bounds raw password input before normalization', () => {
    assert.equal(loginSchema.safeParse({ email: 'a@b.test', password: 'x'.repeat(5000) }).success, false);
  });

  it('signup and login schemas reject unknown keys such as is_demo and store_id', () => {
    const base = { email: 'a@b.test', password: 'a-long-enough-password' };
    assert.equal(signupSchema.safeParse(base).success, true);
    assert.equal(signupSchema.safeParse({ ...base, is_demo: 'true' }).success, false);
    assert.equal(loginSchema.safeParse({ email: 'a@b.test', password: 'x', store_id: 'y' }).success, false);
  });
});

describe('store rules', () => {
  const valid = ['a', 'z9', 'my-shop', 'a'.repeat(40), '0-0'];
  const invalid = ['', '-a', 'a-', 'A_b', 'my shop', 'a'.repeat(41), 'sh/op', 'shöp'];

  it('accepts and rejects slugs according to the exact pattern', () => {
    assert.equal(SLUG_PATTERN.source, '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$');
    for (const slug of valid) assert.equal(slugSchema.safeParse(slug).success, true, slug);
    for (const slug of invalid) assert.equal(slugSchema.safeParse(slug).success, false, slug);
  });

  it('lowercases and trims slugs, and rejects reserved slugs in any case', () => {
    assert.equal(slugSchema.parse('  My-Shop '), 'my-shop');
    for (const slug of RESERVED_SLUGS) {
      assert.equal(slugSchema.safeParse(slug).success, false, slug);
      assert.equal(slugSchema.safeParse(slug.toUpperCase()).success, false, slug);
    }
    assert.equal(slugSchema.safeParse('administrator').success, true);
  });

  it('keeps the migration reserved list and slug regex in sync with the constants', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    const reserved = /slug NOT IN \(([^)]*)\)/.exec(sql)[1].match(/'([a-z]+)'/g).map((item) => item.slice(1, -1));
    assert.deepEqual(reserved, [...RESERVED_SLUGS]);
    assert.ok(sql.includes(`slug ~ '${SLUG_PATTERN.source}'`));
  });

  it('store schema is strict and validates language', () => {
    const base = { name: 'Clay Works', slug: 'clay-works', defaultLanguage: 'gu', story: 'Hand made.' };
    assert.equal(storeSchema.safeParse(base).success, true);
    assert.equal(storeSchema.safeParse({ ...base, store_id: 'x' }).success, false);
    assert.equal(storeSchema.safeParse({ ...base, defaultLanguage: 'fr' }).success, false);
    assert.equal(storeSchema.safeParse({ ...base, name: '   ' }).success, false);
  });
});
