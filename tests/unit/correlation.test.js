import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { resolveCorrelationId } from '../../src/lib/correlation.js';
import { startTestApp } from '../helpers/testApp.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('resolveCorrelationId', () => {
  it('generates a UUID when absent', () => {
    assert.match(resolveCorrelationId(undefined), UUID);
  });

  it('accepts valid ids up to 64 characters', () => {
    assert.equal(resolveCorrelationId('abc-DEF_123'), 'abc-DEF_123');
    assert.equal(resolveCorrelationId('a'.repeat(64)), 'a'.repeat(64));
  });

  it('rejects too long, empty or unsafe ids', () => {
    for (const bad of ['a'.repeat(65), '', 'has space', 'semi;colon', 'new\nline', '<script>']) {
      assert.match(resolveCorrelationId(bad), UUID);
    }
  });
});

describe('correlation id over HTTP', () => {
  let app;
  before(async () => {
    app = await startTestApp();
  });
  after(() => app.close());

  it('echoes a valid X-Request-Id', async () => {
    const res = await fetch(`${app.url}/health`, { headers: { 'x-request-id': 'client-id-42' } });
    assert.equal(res.headers.get('x-request-id'), 'client-id-42');
  });

  it('replaces an invalid X-Request-Id with a UUID', async () => {
    const res = await fetch(`${app.url}/health`, { headers: { 'x-request-id': 'bad id!' } });
    assert.match(res.headers.get('x-request-id'), UUID);
  });

  it('generates one when the header is missing', async () => {
    const res = await fetch(`${app.url}/health`);
    assert.match(res.headers.get('x-request-id'), UUID);
  });
});
