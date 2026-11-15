import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { startTestApp } from '../helpers/testApp.js';
import { busy } from '../../src/lib/errors.js';
import { correlationId } from '../../src/middleware/correlationId.js';
import { errorHandler, notFoundHandler } from '../../src/middleware/errorHandler.js';
import { createLogger } from '../../src/lib/logger.js';
import express from 'express';
import { fileURLToPath } from 'node:url';

const HTML = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
const VIEWS = fileURLToPath(new URL('../../src/views', import.meta.url));

async function startErrorApp(routes) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', VIEWS);
  app.use(correlationId());
  routes(app);
  app.use(notFoundHandler());
  app.use(errorHandler(createLogger({ level: 'silent' })));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => (server.close(r), server.closeAllConnections())) };
}

describe('HTML and JSON error rendering share the central handler', () => {
  it('browsers get an HTML 404 page with lang, the correlation id and no internals', async () => {
    const app = await startTestApp();
    try {
      const res = await fetch(`${app.url}/nope`, { headers: { ...HTML, 'x-request-id': 'html-404' } });
      const html = await res.text();
      assert.equal(res.status, 404);
      assert.match(res.headers.get('content-type'), /text\/html/);
      assert.match(html, /<html lang="en">/);
      assert.match(html, /html-404/);
      assert.doesNotMatch(html, /Error:|at \w+|node_modules/);
    } finally {
      await app.close();
    }
  });

  it('JSON clients and /api, /internal, /health paths keep the JSON error shape', async () => {
    const app = await startTestApp();
    try {
      for (const [path, headers] of [['/nope', {}], ['/api/nope', HTML], ['/internal/nope', HTML], ['/health/x', HTML]]) {
        const res = await fetch(`${app.url}${path}`, { headers });
        const body = await res.json();
        assert.equal(res.status, 404, path);
        assert.equal(body.error.code, 'NOT_FOUND', path);
        assert.equal(body.error.correlationId, res.headers.get('x-request-id'), path);
      }
    } finally {
      await app.close();
    }
  });

  it('an unexpected error is a generic 500 in both formats and leaks nothing', async () => {
    const app = await startErrorApp((a) =>
      a.get('/boom', () => {
        throw new Error('SELECT * FROM owners; password=hunter2');
      }),
    );
    try {
      const html = await (await fetch(`${app.url}/boom`, { headers: HTML })).text();
      const json = await (await fetch(`${app.url}/boom`)).text();
      for (const text of [html, json]) {
        assert.doesNotMatch(text, /SELECT|hunter2|password/);
        assert.match(text, /Something went wrong/);
      }
    } finally {
      await app.close();
    }
  });

  it('BUSY is 503 with Retry-After and a generic page or JSON body', async () => {
    const app = await startErrorApp((a) =>
      a.get('/busy', (_req, _res, next) => next(busy())),
    );
    try {
      const page = await fetch(`${app.url}/busy`, { headers: HTML });
      assert.equal(page.status, 503);
      assert.equal(page.headers.get('retry-after'), '5');
      assert.match(await page.text(), /Server busy/);
      const api = await fetch(`${app.url}/busy`);
      assert.equal(api.status, 503);
      assert.equal(api.headers.get('retry-after'), '5');
      assert.equal((await api.json()).error.code, 'BUSY');
    } finally {
      await app.close();
    }
  });

  it('falls back to JSON if the error view cannot render', async () => {
    const app = express();
    app.set('view engine', 'ejs');
    app.set('views', '/nonexistent-views-dir');
    app.use(correlationId());
    app.use(notFoundHandler());
    app.use(errorHandler(createLogger({ level: 'silent' })));
    const server = await new Promise((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/x`, { headers: HTML });
      assert.equal(res.status, 404);
      assert.equal((await res.json()).error.code, 'NOT_FOUND');
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });
});

describe('static assets and form parsing', () => {
  it('serves the stylesheet before the global limiter, so assets do not consume the request budget', async () => {
    const app = await startTestApp({ globalRateLimit: { windowMs: 60_000, limit: 1 } });
    try {
      for (let index = 0; index < 3; index += 1) {
        const res = await fetch(`${app.url}/css/app.css`);
        assert.equal(res.status, 200);
        await res.text();
      }
      assert.equal((await fetch(`${app.url}/health`)).status, 200);
      assert.equal((await fetch(`${app.url}/health`)).status, 429);
    } finally {
      await app.close();
    }
  });

  it('rejects urlencoded bodies over 10 KB with 413', async () => {
    const app = await startTestApp();
    try {
      const res = await fetch(`${app.url}/health`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `pad=${'x'.repeat(11 * 1024)}`,
      });
      assert.equal(res.status, 413);
    } finally {
      await app.close();
    }
  });
});
