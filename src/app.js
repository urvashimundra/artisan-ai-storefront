import express from 'express';
import helmet from 'helmet';
import { readVersion } from './config/version.js';
import { createLogger } from './lib/logger.js';
import { correlationId } from './middleware/correlationId.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createRateLimiter } from './middleware/rateLimit.js';
import { requestLogger } from './middleware/requestLogger.js';
import { createHealthRouter } from './routes/health.js';
import { createInternalRouter } from './routes/internal.js';

export const JSON_BODY_LIMIT = '100kb';
export const GLOBAL_RATE_WINDOW_MS = 60_000;
export const GLOBAL_RATE_LIMIT = 120;

const noDiagnostics = { run: async () => ({ ok: false, checks: [] }) };

/**
 * App factory. All collaborators are injectable so tests never touch real services.
 * @param {{
 *   config: ReturnType<import('./config/env.js').loadEnv>,
 *   logger?: ReturnType<typeof createLogger>,
 *   diagnostics?: { run: (names: string[]) => Promise<object> },
 *   version?: string,
 *   globalRateLimit?: { windowMs: number, limit: number },
 * }} deps
 * @returns {import('express').Express}
 */
export function createApp({ config, logger, diagnostics = noDiagnostics, version, globalRateLimit }) {
  const log = logger ?? createLogger({ level: config.nodeEnv === 'test' ? 'silent' : 'info' });
  const limits = globalRateLimit ?? { windowMs: GLOBAL_RATE_WINDOW_MS, limit: GLOBAL_RATE_LIMIT };
  const app = express();
  app.disable('x-powered-by');

  app.use(correlationId());
  app.use(helmet());
  app.set('trust proxy', config.trustProxy);
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(requestLogger(log));
  app.use(createRateLimiter(limits));

  app.use(createHealthRouter({ version: version ?? readVersion() }));
  app.use(createInternalRouter({ diagnosticsToken: config.diagnosticsToken, diagnostics }));

  app.use(notFoundHandler());
  app.use(errorHandler(log));
  return app;
}
