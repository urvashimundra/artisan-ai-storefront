import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { originCheck } from '../../src/middleware/originCheck.js';

const ALLOWED = ['https://theartisanstory.in', 'https://preview.example.test'];

function run({ method = 'POST', origin, secFetchSite, allowed = ALLOWED, forwardedHost } = {}) {
  const headers = { origin, 'sec-fetch-site': secFetchSite, 'x-forwarded-host': forwardedHost, host: 'theartisanstory.in' };
  const req = { method, get: (name) => headers[name.toLowerCase()] };
  let result = 'not-called';
  originCheck(allowed)(req, {}, (error) => (result = error));
  return result;
}

describe('origin check', () => {
  it('accepts an Origin matching BASE_URL or an ALLOWED_ORIGINS entry', () => {
    assert.equal(run({ origin: 'https://theartisanstory.in' }), undefined);
    assert.equal(run({ origin: 'https://preview.example.test' }), undefined);
  });

  it('rejects mismatched, null, look-alike and port-variant origins with 403', () => {
    for (const origin of [
      'https://evil.test',
      'null',
      '',
      'http://theartisanstory.in',
      'https://theartisanstory.in:8443',
      'https://theartisanstory.in.evil.test',
      'https://theartisanstory.in/',
    ]) {
      const error = run({ origin });
      assert.equal(error?.httpStatus, 403, origin);
    }
  });

  it('a missing Origin is accepted only with Sec-Fetch-Site exactly same-origin', () => {
    assert.equal(run({ secFetchSite: 'same-origin' }), undefined);
    for (const value of ['cross-site', 'same-site', 'none', 'Same-Origin', undefined]) {
      assert.equal(run({ secFetchSite: value })?.httpStatus, 403, String(value));
    }
  });

  it('a present Origin wins over Sec-Fetch-Site', () => {
    assert.equal(run({ origin: 'https://evil.test', secFetchSite: 'same-origin' })?.httpStatus, 403);
  });

  it('checks POST, PUT, PATCH and DELETE and leaves safe methods alone', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(run({ method, origin: 'https://evil.test' })?.httpStatus, 403);
    for (const method of ['GET', 'HEAD', 'OPTIONS']) assert.equal(run({ method, origin: 'https://evil.test' }), undefined);
  });

  it('ignores forwarded and Host headers when deciding what is allowed', () => {
    assert.equal(run({ origin: 'https://evil.test', forwardedHost: 'evil.test' })?.httpStatus, 403);
    assert.equal(run({ origin: 'https://evil.test', allowed: ['https://theartisanstory.in'] })?.httpStatus, 403);
  });
});
