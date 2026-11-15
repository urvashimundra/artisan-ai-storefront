import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clearCookie, deriveCookieConfig, parseCookies, serializeCookie } from '../../src/lib/cookies.js';

const SEVEN_DAYS = 604800;

describe('cookie config derives from BASE_URL, never NODE_ENV', () => {
  it('https BASE_URL gives the __Host-session name and Secure', () => {
    assert.deepEqual(deriveCookieConfig('https://theartisanstory.in'), { name: '__Host-session', secure: true });
  });

  it('http BASE_URL gives plain session without Secure', () => {
    assert.deepEqual(deriveCookieConfig('http://localhost:3000'), { name: 'session', secure: false });
  });

  it('NODE_ENV has no effect', () => {
    const original = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      assert.equal(deriveCookieConfig('http://localhost:3000').secure, false);
      process.env.NODE_ENV = 'development';
      assert.equal(deriveCookieConfig('https://example.test').secure, true);
    } finally {
      process.env.NODE_ENV = original;
    }
  });
});

describe('serializeCookie and clearCookie', () => {
  it('https cookie has Secure, HttpOnly, SameSite=Lax, Path=/, Max-Age and no Domain', () => {
    const value = serializeCookie(deriveCookieConfig('https://example.test'), 'tok', SEVEN_DAYS);
    assert.match(value, /^__Host-session=tok; /);
    for (const part of ['Max-Age=604800', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Secure']) {
      assert.ok(value.split('; ').includes(part), part);
    }
    assert.doesNotMatch(value, /Domain/i);
  });

  it('http cookie has no Secure attribute', () => {
    const value = serializeCookie(deriveCookieConfig('http://localhost:3000'), 'tok', SEVEN_DAYS);
    assert.match(value, /^session=tok; /);
    assert.doesNotMatch(value, /Secure/);
  });

  it('the clearing cookie uses identical name, Path, Secure and SameSite with Max-Age=0', () => {
    for (const baseUrl of ['https://example.test', 'http://localhost:3000']) {
      const cookie = deriveCookieConfig(baseUrl);
      const set = serializeCookie(cookie, 'tok', SEVEN_DAYS).split('; ').slice(1);
      const cleared = clearCookie(cookie).split('; ');
      assert.equal(cleared[0], `${cookie.name}=`);
      assert.deepEqual(
        cleared.slice(1).filter((part) => !part.startsWith('Max-Age')),
        set.filter((part) => !part.startsWith('Max-Age')),
      );
      assert.ok(cleared.includes('Max-Age=0'));
    }
  });
});

describe('parseCookies', () => {
  it('parses pairs, trims, keeps the first duplicate and skips malformed pairs', () => {
    const parsed = parseCookies('a=1; b = 2;broken; =x; a=3; c=d=e');
    assert.equal(parsed.a, '1');
    assert.equal(parsed.b, '2');
    assert.equal(parsed.c, 'd=e');
    assert.equal(parsed.broken, undefined);
  });

  it('handles a missing header and cannot be polluted through __proto__', () => {
    assert.deepEqual(Object.keys(parseCookies(undefined)), []);
    const parsed = parseCookies('__proto__=x');
    assert.equal(Object.getPrototypeOf(parsed), null);
    assert.equal(({}).x, undefined);
  });
});
