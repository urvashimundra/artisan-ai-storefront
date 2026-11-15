import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { readVersion } from './config/version.js';
import { createLogger } from './lib/logger.js';
import { correlationId } from './middleware/correlationId.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createRateLimiter } from './middleware/rateLimit.js';
import { requestLogger } from './middleware/requestLogger.js';
import { createBrowserRouter } from './routes/browser.js';
import { createHealthRouter } from './routes/health.js';
import { createInternalRouter } from './routes/internal.js';

export const JSON_BODY_LIMIT = '100kb';
export const FORM_BODY_LIMIT = '10kb';
const VIEWS_DIR = fileURLToPath(new URL('./views', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
export const GLOBAL_RATE_WINDOW_MS = 60_000;
export const GLOBAL_RATE_LIMIT = 120;

const noDiagnostics = { run: async () => ({ ok: false, checks: [] }) };

/**
 * App factory. All collaborators are injectable so tests never touch real services.
 * @param {{
 *   config: ReturnType<import('./config/env.js').loadEnv>,
 *   logger?: ReturnType<typeof createLogger>,
 *   diagnostics?: { run: (names: string[]) => Promise<object> },
 *   services?: { auth: object, sessions: object, stores: object },
 *   authRateLimits?: { loginFailure?: object, loginIp?: object, signup?: object },
 *   version?: string,
 *   globalRateLimit?: { windowMs: number, limit: number },
 * }} deps
 * @returns {import('express').Express}
 */
export function createApp({
  config,
  logger,
  diagnostics = noDiagnostics,
  services,
  authRateLimits,
  version,
  globalRateLimit,
}) {
  const log = logger ?? createLogger({ level: config.nodeEnv === 'test' ? 'silent' : 'info' });
  const limits = globalRateLimit ?? { windowMs: GLOBAL_RATE_WINDOW_MS, limit: GLOBAL_RATE_LIMIT };
  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', VIEWS_DIR);

  app.use(correlationId());
  app.use(helmet());
  app.set('trust proxy', config.trustProxy);
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: FORM_BODY_LIMIT }));
  app.use(requestLogger(log));
  app.use(express.static(PUBLIC_DIR));
  app.use(createRateLimiter(limits));

  app.use(createHealthRouter({ version: version ?? readVersion() }));
  app.use(createInternalRouter({ diagnosticsToken: config.diagnosticsToken, diagnostics }));
  if (services) app.use(createBrowserRouter({ config, services, authRateLimits }));

  app.use(notFoundHandler());
  app.use(errorHandler(log));
  return app;
}
