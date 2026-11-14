import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLogger } from '../../src/lib/logger.js';

function capture(level = 'debug') {
  const lines = [];
  return { lines, logger: createLogger({ level, write: (line) => lines.push(line) }) };
}

describe('logger', () => {
  it('writes one JSON line with level, msg and bindings', () => {
    const { lines, logger } = capture();
    logger.child({ correlationId: 'c1' }).info('hello', { n: 1 });
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.level, 'info');
    assert.equal(entry.msg, 'hello');
    assert.equal(entry.correlationId, 'c1');
    assert.equal(entry.n, 1);
  });

  it('respects the level threshold', () => {
    const { lines, logger } = capture('warn');
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');
    assert.equal(lines.length, 2);
  });

  it('redacts sensitive keys, including nested ones', () => {
    const { lines, logger } = capture();
    logger.info('x', {
      password: 'pw-secret',
      user: { token: 'tok-secret', authorization: 'Bearer abc', apiKey: 'sk-secret' },
      headers: { cookie: 'sid=cookie-secret' },
      phone: '+91 98765 43210',
      customerMessage: 'I want ten lamps please',
      safe: 'visible',
    });
    const out = lines[0];
    for (const leaked of ['pw-secret', 'tok-secret', 'sk-secret', 'cookie-secret', '98765', 'ten lamps']) {
      assert.doesNotMatch(out, new RegExp(leaked));
    }
    assert.match(out, /visible/);
  });

  it('scrubs phone numbers and bearer tokens inside free text and errors', () => {
    const { lines, logger } = capture();
    logger.error('failed', { note: 'call +91 98765 43210 now', err: new Error('Bearer abc.def.ghi rejected') });
    assert.doesNotMatch(lines[0], /98765|abc\.def\.ghi/);
    assert.match(lines[0], /REDACTED/);
  });

  it('survives circular references', () => {
    const { lines, logger } = capture();
    const loop = { name: 'loop' };
    loop.self = loop;
    logger.info('circular', { loop });
    assert.match(lines[0], /TRUNCATED/);
  });
});
