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
/** Product routes parse their own (larger) forms after authentication: Gujarati text is 9 bytes per character URL-encoded. */
const PRODUCT_PATH_PREFIX = '/products';
const VIEWS_DIR = fileURLToPath(new URL('./views', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
export const GLOBAL_RATE_WINDOW_MS = 60_000;
export const GLOBAL_RATE_LIMIT = 120;
/**
 * Helmet's default `no-referrer` makes Chrome send `Origin: null` on same-origin form POSTs, which the origin check
 * rejects. This policy is the browser default: same-origin requests keep their real Origin, and cross-origin
 * requests still get only the origin, never the path.
 */
export const REFERRER_POLICY = 'strict-origin-when-cross-origin';

/** Helmet's default CSP, plus the Supabase origin for img-src so signed private-photo URLs can be displayed. */
function buildCsp(config) {
  const directives = helmet.contentSecurityPolicy.getDefaultDirectives();
  const storageOrigin = config.supabase?.url ? new URL(config.supabase.url).origin : null;
  if (storageOrigin) directives['img-src'] = [...directives['img-src'], storageOrigin];
  return { directives };
}

const noDiagnostics = { run: async () => ({ ok: false, checks: [] }) };

/**
 * App factory. All collaborators are injectable so tests never touch real services.
 * @param {{
 *   config: ReturnType<import('./config/env.js').loadEnv>,
 *   logger?: ReturnType<typeof createLogger>,
 *   diagnostics?: { run: (names: string[]) => Promise<object> },
 *   services?: { auth: object, sessions: object, stores: object, products?: object, listings?: object },
 *   productRateLimits?: { upload?: object, generate?: object },
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
  productRateLimits,
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
  app.use(helmet({ referrerPolicy: { policy: REFERRER_POLICY }, contentSecurityPolicy: buildCsp(config) }));
  app.set('trust proxy', config.trustProxy);
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  const globalForm = express.urlencoded({ extended: false, limit: FORM_BODY_LIMIT });
  app.use((req, res, next) => (req.path.startsWith(PRODUCT_PATH_PREFIX) ? next() : globalForm(req, res, next)));
  app.use(requestLogger(log));
  app.use(express.static(PUBLIC_DIR));
  app.use(createRateLimiter(limits));

  app.use(createHealthRouter({ version: version ?? readVersion() }));
  app.use(createInternalRouter({ diagnosticsToken: config.diagnosticsToken, diagnostics }));
  if (services) app.use(createBrowserRouter({ config, services, authRateLimits, productRateLimits }));

  app.use(notFoundHandler());
  app.use(errorHandler(log));
  return app;
}
