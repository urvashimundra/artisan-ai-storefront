import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startTestApp } from '../helpers/testApp.js';

describe('app basics', () => {
  let app;
  before(async () => {
    app = await startTestApp();
  });
  after(() => app.close());

  it('GET /health returns status, uptime and version', async () => {
    const res = await fetch(`${app.url}/health`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.uptime, 'number');
    assert.equal(body.version, '9.9.9');
  });

  it('GET / returns 200 with name and status for platform health probes', async () => {
    const res = await fetch(`${app.url}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /The Artisan Story/);
    assert.ok(res.headers.get('x-request-id'));
    assert.ok(res.headers.get('x-content-type-options'));
  });

  it('unknown route returns the JSON 404 shape with a correlation id', async () => {
    const res = await fetch(`${app.url}/nope`);
    const body = await res.json();
    assert.equal(res.status, 404);
    assert.deepEqual(Object.keys(body), ['error']);
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.equal(typeof body.error.message, 'string');
    assert.equal(body.error.correlationId, res.headers.get('x-request-id'));
  });

  it('invalid JSON returns 400 INVALID_JSON without internals', async () => {
    const res = await fetch(`${app.url}/health`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"broken":',
    });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'INVALID_JSON');
    assert.doesNotMatch(JSON.stringify(body), /SyntaxError|at /);
  });

  it('rejects JSON bodies over 100 KB with 413', async () => {
    const res = await fetch(`${app.url}/health`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(101 * 1024) }),
    });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error.code, 'PAYLOAD_TOO_LARGE');
  });

  it('sets helmet headers and hides x-powered-by', async () => {
    const res = await fetch(`${app.url}/health`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  it('sends Referrer-Policy strict-origin-when-cross-origin so same-origin form POSTs keep their real Origin', async () => {
    const res = await fetch(`${app.url}/health`);
    await res.arrayBuffer();
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  });

  it('logs requests with the correlation id and without the query string', async () => {
    const res = await fetch(`${app.url}/health?secret=abc123`);
    const id = res.headers.get('x-request-id');
    const entry = await app.waitForLog((log) => log.msg === 'request completed' && log.correlationId === id);
    assert.ok(entry);
    assert.equal(entry.path, '/health');
    assert.doesNotMatch(JSON.stringify(app.logs), /abc123/);
  });

  it('logs the client IP unmangled and only the count of X-Forwarded-For entries, never the raw header', async () => {
    const res = await fetch(`${app.url}/health`, { headers: { 'x-forwarded-for': '9.9.9.9, 103.21.244.10' } });
    const id = res.headers.get('x-request-id');
    await res.arrayBuffer();
    const entry = await app.waitForLog((log) => log.msg === 'request completed' && log.correlationId === id);
    assert.equal(entry.ip, '103.21.244.10');
    assert.equal(entry.xffHops, 2);
    assert.doesNotMatch(JSON.stringify(entry), /9\.9\.9\.9/);
  });

  it('logs xffHops 0 when X-Forwarded-For is absent', async () => {
    const res = await fetch(`${app.url}/health`);
    const id = res.headers.get('x-request-id');
    await res.arrayBuffer();
    const entry = await app.waitForLog((log) => log.msg === 'request completed' && log.correlationId === id);
    assert.equal(entry.xffHops, 0);
  });

  it('redacts a phone-number-shaped client X-Request-Id in the log line', async () => {
    const res = await fetch(`${app.url}/health`, { headers: { 'x-request-id': '9876543210' } });
    await res.arrayBuffer();
    const entry = await app.waitForLog((log) => log.msg === 'request completed' && log.correlationId === '[REDACTED_PHONE]');
    assert.equal(entry.path, '/health');
    assert.doesNotMatch(JSON.stringify(app.logs), /9876543210/);
  });
});
