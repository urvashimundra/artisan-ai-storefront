import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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

  it('leaves a whole IP address value unchanged but still redacts a phone number in another field', () => {
    const { lines, logger } = capture();
    logger.info('x', { ip: '103.21.244.10', mapped: '::ffff:103.21.244.10', v6: '2001:db8:1:2::1', note: 'call 98765 43210 now' });
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.ip, '103.21.244.10');
    assert.equal(entry.mapped, '::ffff:103.21.244.10');
    assert.equal(entry.v6, '2001:db8:1:2::1');
    assert.match(entry.note, /REDACTED_PHONE/);
    assert.doesNotMatch(lines[0], /98765/);
  });

  it('survives circular references', () => {
    const { lines, logger } = capture();
    const loop = { name: 'loop' };
    loop.self = loop;
    logger.info('circular', { loop });
    assert.match(lines[0], /TRUNCATED/);
  });

  it('leaves 1000 random UUIDs unchanged as correlationId and as ownerId', () => {
    const { lines, logger } = capture();
    const ids = Array.from({ length: 1000 }, () => randomUUID());
    for (const id of ids) logger.child({ correlationId: id }).info('x', { ownerId: id.toUpperCase() });
    ids.forEach((id, index) => {
      const entry = JSON.parse(lines[index]);
      assert.equal(entry.correlationId, id);
      assert.equal(entry.ownerId, id.toUpperCase());
    });
  });

  const phoneForms = [
    ['9876543210', ''],
    ['+91 98765 43210', ''],
    ['+91-9876543210', ''],
    ['098765-43210', ''],
    ['(079) 2345 6789', '('],
  ];
  for (const [phone, keptPrefix] of phoneForms) {
    it(`still redacts the phone number "${phone}" as a whole value and inside a sentence`, () => {
      const { lines, logger } = capture();
      logger.info('x', { value: phone, note: `call me on ${phone} today` });
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.value, `${keptPrefix}[REDACTED_PHONE]`);
      assert.equal(entry.note, `call me on ${keptPrefix}[REDACTED_PHONE] today`);
    });
  }

  it('scrubs a UUID embedded in a longer message as before (known limitation: embedded UUIDs can be redacted)', () => {
    const { lines, logger } = capture();
    logger.info('x', { note: 'order 51211283-27c5-4b3e-937d-655e3d141ade failed' });
    assert.match(JSON.parse(lines[0]).note, /REDACTED_PHONE/);
  });
});
