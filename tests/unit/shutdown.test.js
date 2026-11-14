import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import { createShutdownHandler, SHUTDOWN_TIMEOUT_MS } from '../../src/lib/shutdown.js';

const silentLogger = { info: () => {}, error: () => {} };

function listen() {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => res.end('ok'));
    server.listen(0, () => resolve(server));
  });
}

describe('shutdown handler', () => {
  it('uses a 10 second timeout', () => {
    assert.equal(SHUTDOWN_TIMEOUT_MS, 10_000);
  });

  it('closes the server and exits 0', async () => {
    const server = await listen();
    const exitCode = await new Promise((resolve) => {
      createShutdownHandler({ server, logger: silentLogger, exit: resolve })('SIGTERM');
    });
    assert.equal(exitCode, 0);
    assert.equal(server.listening, false);
  });

  it('is idempotent when signalled twice', async () => {
    const server = await listen();
    const exits = [];
    const handler = createShutdownHandler({ server, logger: silentLogger, exit: (code) => exits.push(code) });
    handler('SIGINT');
    handler('SIGTERM');
    await new Promise((resolve) => server.once('close', resolve));
    assert.deepEqual(exits, [0]);
  });

  it('forces exit 1 when connections never drain within the timeout', async () => {
    const server = { close: () => {}, closeIdleConnections: () => {} };
    const exitCode = await new Promise((resolve) => {
      createShutdownHandler({ server, logger: silentLogger, exit: resolve, timeoutMs: 20 })('SIGTERM');
      setTimeout(() => {}, 100);
    });
    assert.equal(exitCode, 1);
  });
});
