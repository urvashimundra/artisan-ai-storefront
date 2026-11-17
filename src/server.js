import { createApp } from './app.js';
import { buildDependencies } from './composition.js';
import { EnvValidationError, loadEnv } from './config/env.js';
import { createLogger } from './lib/logger.js';
import { createShutdownHandler } from './lib/shutdown.js';

const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'];
const EXIT_CONFIG_ERROR = 1;

function loadConfigOrExit() {
  try {
    return loadEnv();
  } catch (error) {
    if (!(error instanceof EnvValidationError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return process.exit(EXIT_CONFIG_ERROR);
  }
}

async function start() {
  const config = loadConfigOrExit();
  const logger = createLogger({ level: config.nodeEnv === 'test' ? 'silent' : 'info' });
  const { diagnostics, services, emailWorker } = await buildDependencies(config);
  const app = createApp({ config, logger, diagnostics, services });
  const server = app.listen(config.port, () => {
    logger.info('server listening', { port: config.port, nodeEnv: config.nodeEnv });
  });
  emailWorker?.start();
  const shutdown = createShutdownHandler({ server, logger, onShutdown: () => emailWorker?.stop() });
  for (const signal of SHUTDOWN_SIGNALS) process.on(signal, () => shutdown(signal));
}

start().catch((error) => {
  process.stderr.write(`Startup failed: ${error?.name ?? 'Error'}\n`);
  process.exit(EXIT_CONFIG_ERROR);
});
