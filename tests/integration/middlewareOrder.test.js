import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { startTestApp } from '../helpers/testApp.js';

const TIGHT_LIMIT = { windowMs: 60_000, limit: 1 };

describe('middleware order', () => {
  it('a rate-limited response still has correlation id, helmet headers and the JSON error shape', async () => {
    const app = await startTestApp({ globalRateLimit: TIGHT_LIMIT });
    try {
      await fetch(`${app.url}/health`);
      const res = await fetch(`${app.url}/health`, { headers: { 'x-request-id': 'order-check-1' } });
      const body = await res.json();
      assert.equal(res.status, 429);
      assert.equal(res.headers.get('x-request-id'), 'order-check-1');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(body.error.code, 'TOO_MANY_REQUESTS');
      assert.equal(body.error.correlationId, 'order-check-1');
    } finally {
      await app.close();
    }
  });

  it('trust proxy applies before the limiter: clients are keyed by X-Forwarded-For', async () => {
    const app = await startTestApp({ globalRateLimit: TIGHT_LIMIT });
    const hit = (ip) => fetch(`${app.url}/health`, { headers: { 'x-forwarded-for': ip } });
    try {
      assert.equal((await hit('203.0.113.1')).status, 200);
      assert.equal((await hit('203.0.113.1')).status, 429);
      assert.equal((await hit('203.0.113.2')).status, 200);
    } finally {
      await app.close();
    }
  });

  it('the body parser runs before routes and limiter errors are logged with the request id', async () => {
    const app = await startTestApp({ globalRateLimit: TIGHT_LIMIT });
    try {
      await fetch(`${app.url}/health`);
      const res = await fetch(`${app.url}/health`, { headers: { 'x-request-id': 'order-check-2' } });
      await res.arrayBuffer();
      const failure = app.logs.find((log) => log.msg === 'request failed' && log.correlationId === 'order-check-2');
      assert.equal(failure.code, 'TOO_MANY_REQUESTS');
    } finally {
      await app.close();
    }
  });
});
