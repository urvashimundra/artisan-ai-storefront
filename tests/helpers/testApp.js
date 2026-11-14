import { createApp } from '../../src/app.js';
import { createLogger } from '../../src/lib/logger.js';

export const TEST_TOKEN = 'test-diagnostics-token-0123456789';

export const baseConfig = {
  nodeEnv: 'test',
  port: 0,
  baseUrl: 'http://localhost',
  trustProxy: 1,
  diagnosticsToken: undefined,
  supabase: null,
  ai: null,
  smtp: null,
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
 * @returns {Promise<{ url: string, logs: object[], close: () => Promise<void> }>}
 */
export async function startTestApp({ config = {}, ...deps } = {}) {
  const logs = [];
  const logger = createLogger({ level: 'debug', write: (line) => logs.push(JSON.parse(line)) });
  const app = createApp({ config: { ...baseConfig, ...config }, logger, version: '9.9.9', ...deps });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    logs,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
