import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { readVersion } from './config/version.js';
import { createLogger } from './lib/logger.js';
import { correlationId } from './middleware/correlationId.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createRateLimiter } from './middleware/rateLimit.js';
import { requestLogger } from './middleware/requestLogger.js';
import { createAssistantRouter } from './routes/assistant.js';
import { createBrowserRouter } from './routes/browser.js';
import { createContactRouter } from './routes/contact.js';
import { createHealthRouter } from './routes/health.js';
import { createInternalRouter } from './routes/internal.js';
import { createOrderRouter } from './routes/orders.js';
import { createPublicRouter } from './routes/public.js';

export const JSON_BODY_LIMIT = '100kb';
export const FORM_BODY_LIMIT = '10kb';
/** These routes parse their own (larger) forms after authentication: Gujarati text is 9 bytes per character URL-encoded. */
const LARGE_FORM_PATH_PREFIXES = Object.freeze(['/products', '/store/settings', '/store/new', '/store/knowledge', '/contact']);
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
 *   services?: { auth: object, sessions: object, stores: object, products?: object, listings?: object, publicShop?: object, orders?: object,
 *     contact?: object, assistant?: object, conversations?: object },
 *   assistantRateLimits?: { page?: object, ask?: object, answer?: object, chatStart?: object, chatMessage?: object, chatPoll?: object },
 *   contactRateLimits?: { ip?: object },
 *   publicRateLimits?: { pages?: object, image?: object },
 *   orderRateLimits?: { page?: object, create?: object, utr?: object, status?: object },
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
  publicRateLimits,
  orderRateLimits,
  assistantRateLimits,
  contactRateLimits,
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
  app.use((req, res, next) => (LARGE_FORM_PATH_PREFIXES.some((prefix) => req.path.startsWith(prefix)) ? next() : globalForm(req, res, next)));
  app.use(requestLogger(log));
  app.use(express.static(PUBLIC_DIR));
  // Public storefront: before the global limiter and before any session-loading route; it has its own limiters.
  if (services?.publicShop) {
    app.use(createPublicRouter({ config, publicShop: services.publicShop, orders: services.orders, chat: Boolean(services.conversations), logger: log, rateLimits: publicRateLimits }));
  }
  // Customer orders: its own limiters and Origin check, also before the global limiter and with no session.
  if (services?.orders) app.use(createOrderRouter({ config, orders: services.orders, logger: log, rateLimits: orderRateLimits }));
  // Customer questions to the seller: private answer pages and the assistant run, same placement and rules as orders.
  if (services?.assistant || services?.conversations) {
    app.use(createAssistantRouter({ config, assistant: services.assistant ?? null, conversations: services.conversations ?? null, logger: log, rateLimits: assistantRateLimits }));
  }
  app.use(createRateLimiter(limits));

  app.use(createHealthRouter({ version: version ?? readVersion() }));
  app.use(createInternalRouter({ diagnosticsToken: config.diagnosticsToken, diagnostics }));
  if (services?.contact) app.use(createContactRouter({ config, contact: services.contact, rateLimits: contactRateLimits }));
  if (services) app.use(createBrowserRouter({ config, services, authRateLimits, productRateLimits }));

  app.use(notFoundHandler());
  app.use(errorHandler(log));
  return app;
}
