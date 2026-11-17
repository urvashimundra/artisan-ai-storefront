import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redact } from '../../src/lib/logger.js';

describe('private link redaction', () => {
  const token = 'A'.repeat(43);

  it('redacts the token in order (/o/) and enquiry (/q/) paths and keeps the rest', () => {
    const out = redact({ url: `/o/${token}`, other: `GET /s/clay/q/${token}/answer?lang=en` });
    assert.equal(out.url, '/o/[REDACTED]');
    assert.equal(out.other, 'GET /s/clay/q/[REDACTED]/answer?lang=en');
  });

  it('does not touch paths that merely contain /q/ with a short segment', () => {
    assert.equal(redact({ path: '/s/clay/q/short' }).path, '/s/clay/q/short');
  });
});
