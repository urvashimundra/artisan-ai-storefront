import { createApp } from '../../src/app.js';
import { createLogger } from '../../src/lib/logger.js';

const LOG_WAIT_TIMEOUT_MS = 2000;

export const TEST_TOKEN ='test-diagnostics-token-0123456789';

export const baseConfig = {
  nodeEnv: 'test',
  port: 0,
  baseUrl: 'http://localhost',
  allowedOrigins: ['http://localhost'],
  cookie: { name: 'session', secure: false },
  signupInviteCode: undefined,
  trustProxy: 1,
  diagnosticsToken: undefined,
  supabase: { url: 'https://project.supabase.test', serviceRoleKey: 'test-key' },
  ai: null,
};

/** A diagnostics fake that records calls and never touches a network. */
export function createFakeDiagnostics() {
  const calls = [];
  return {
    calls,
    run: async (names) => {
      calls.push(names);
      return { ok: true, checks: names.map((name) => ({ name, ok: true, durationMs: 1 })) };
    },
  };
}

/**
 * Starts the app on an ephemeral port with an in-memory logger.
 * `waitForLog(predicate)` resolves with the first matching entry (even one written after the response reached the
 * client, since the request logger emits on the response `finish` event) or rejects after a bounded timeout.
 * @returns {Promise<{ url: string, logs: object[], waitForLog: (predicate: (log: object) => boolean) => Promise<object>, close: () => Promise<void> }>}
 */
export async function startTestApp({ config = {}, ...deps } = {}) {
  const logs = [];
  const waiters = new Set();
  const logger = createLogger({
    level: 'debug',
    write: (line) => {
      logs.push(JSON.parse(line));
      for (const check of [...waiters]) check();
    },
  });
  const waitForLog = (predicate) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const entry = logs.find(predicate);
        if (!entry) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve(entry);
      };
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`no matching log entry within ${LOG_WAIT_TIMEOUT_MS} ms`));
      }, LOG_WAIT_TIMEOUT_MS);
      waiters.add(check);
      check();
    });
  const app = createApp({ config: { ...baseConfig, ...config }, logger, version: '9.9.9', ...deps });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    logs,
    waitForLog,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
