import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express from 'express';
import { z } from 'zod';
import { AppError, badRequest, conflict, forbidden, notFound, tooManyRequests, unauthorized } from '../../src/lib/errors.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { createLogger } from '../../src/lib/logger.js';

async function request(throwing) {
  const logs = [];
  const app = express();
  app.use((req, _res, next) => {
    req.correlationId = 'cid-1';
    next();
  });
  app.get('/boom', throwing);
  app.use(errorHandler(createLogger({ level: 'debug', write: (line) => logs.push(line) })));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/boom`);
    return { status: res.status, text: await res.text(), logs };
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

describe('error helpers', () => {
  it('map to the expected codes and statuses', () => {
    const cases = [
      [badRequest(), 'BAD_REQUEST', 400],
      [unauthorized(), 'UNAUTHORIZED', 401],
      [forbidden(), 'FORBIDDEN', 403],
      [notFound(), 'NOT_FOUND', 404],
      [conflict(), 'CONFLICT', 409],
      [tooManyRequests(), 'TOO_MANY_REQUESTS', 429],
    ];
    for (const [error, code, status] of cases) {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, code);
      assert.equal(error.httpStatus, status);
    }
  });
});

describe('error handler', () => {
  it('hides stacks, SQL and provider details for unknown errors', async () => {
    const { status, text, logs } = await request(() => {
      throw new Error('select * from owners; provider said sk-ant-SECRET');
    });
    const body = JSON.parse(text);
    assert.equal(status, 500);
    assert.deepEqual(body, {
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong', correlationId: 'cid-1' },
    });
    assert.doesNotMatch(text, /select|SECRET|stack|\.js/i);
    assert.ok(logs.length > 0);
  });

  it('returns AppError safe message but not its details', async () => {
    const { status, text } = await request(() => {
      throw conflict('Slug already taken', { sql: 'INSERT secret' });
    });
    assert.equal(status, 409);
    assert.equal(JSON.parse(text).error.message, 'Slug already taken');
    assert.doesNotMatch(text, /INSERT|secret/);
  });

  it('maps Zod errors to 400 with field paths and codes only', async () => {
    const { status, text } = await request(() => {
      z.object({ name: z.string() }).strict().parse({ name: 42, hidden: 'value-should-not-leak' });
    });
    const body = JSON.parse(text);
    assert.equal(status, 400);
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.ok(body.error.details.some((field) => field.path === 'name'));
    assert.doesNotMatch(text, /value-should-not-leak/);
  });
});
