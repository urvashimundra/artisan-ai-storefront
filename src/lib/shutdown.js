export const SHUTDOWN_TIMEOUT_MS = 10_000;
const EXIT_OK = 0;
const EXIT_FORCED = 1;

/**
 * Creates an idempotent graceful-shutdown handler: stop accepting connections, let in-flight
 * requests finish, and force exit if that takes longer than SHUTDOWN_TIMEOUT_MS.
 * @param {{
 *   server: import('node:http').Server,
 *   logger: { info: Function, error: Function },
 *   exit?: (code: number) => void,
 *   timeoutMs?: number,
 *   onShutdown?: () => Promise<void> | void,
 * }} deps
 * @returns {(signal: string) => void}
 */
export function createShutdownHandler({ server, logger, exit = process.exit, timeoutMs = SHUTDOWN_TIMEOUT_MS, onShutdown }) {
  let shuttingDown = false;
  return (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown started', { signal });
    const forceTimer = setTimeout(() => {
      logger.error('shutdown timed out, forcing exit', { timeoutMs });
      exit(EXIT_FORCED);
    }, timeoutMs);
    forceTimer.unref();
    server.close((error) => {
      clearTimeout(forceTimer);
      if (error) logger.error('shutdown error', { err: error });
      const code = error ? EXIT_FORCED : EXIT_OK;
      if (!onShutdown) return exit(code);
      Promise.resolve()
        .then(onShutdown)
        .catch((stopError) => logger.error('shutdown hook failed', { err: stopError }))
        .finally(() => exit(code));
    });
    server.closeIdleConnections();
  };
}
