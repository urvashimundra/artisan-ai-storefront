import { z } from 'zod';
import { parseUsdToMicroUsd } from '../domain/aiCost.js';
import { deriveCookieConfig } from '../lib/cookies.js';
import { LINK_KEY_PATTERN } from '../lib/linkCipher.js';

const DEFAULT_PORT = 3000;
const MAX_PORT = 65535;
const DEFAULT_TRUST_PROXY = 1;
const MIN_DIAGNOSTICS_TOKEN_LENGTH = 24;
const DEFAULT_CLAUDE_MODEL = 'claude-haiku-5-5';
const KNOWN_NODE_ENVS = ['development', 'test', 'production'];
const FALLBACK_NODE_ENV = 'production';
const PRODUCTION_NODE_ENV = 'production';
const LOCAL_HTTP_HOSTS = ['localhost', '127.0.0.1'];
const DEFAULT_OWNER_BUDGET_USD = '1.00';
const DEFAULT_DEMO_BUDGET_USD = '0.50';
const DEFAULT_GLOBAL_BUDGET_USD = '5.00';
const DEFAULT_EMAIL_RELAY_URL = 'http://127.0.0.1:2525';

const GROUP_KEYS = {
  ai: ['ANTHROPIC_API_KEY', 'CLAUDE_MODEL'],
};
const CORE_KEYS = [
  'NODE_ENV',
  'PORT',
  'BASE_URL',
  'TRUST_PROXY',
  'DIAGNOSTICS_TOKEN',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ALLOWED_ORIGINS',
  'AI_DAILY_BUDGET_USD',
  'AI_DEMO_DAILY_BUDGET_USD',
  'AI_GLOBAL_DAILY_BUDGET_USD',
  'EMAIL_RELAY_URL',
  'CONTACT_INBOX_EMAIL',
  'OWNER_NOTIFY_EMAIL',
  'ORDER_LINK_KEY',
  'EMAIL_WORKER_ENABLED',
];

const nonEmpty = z.string().min(1);
const port = z.coerce.number().int().min(1).max(MAX_PORT);

/**
 * Parses a comma-separated list of bare origins (scheme + host + optional port, no path, query or fragment).
 * @param {string} csv
 * @returns {string[] | null} The origins, or null if any entry is not a bare http(s) origin.
 */
function parseOriginList(csv) {
  const entries = csv.split(',').map((entry) => entry.trim()).filter(Boolean);
  const isBare = (entry) => {
    try {
      const url = new URL(entry);
      return ['http:', 'https:'].includes(url.protocol) && url.origin === entry;
    } catch {
      return false;
    }
  };
  return entries.length > 0 && entries.every(isBare) ? entries : null;
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** @param {string} value @returns {boolean} True for an https: URL. */
function isHttpsUrl(value) {
  return parseUrl(value)?.protocol === 'https:';
}

/** @param {string} value @returns {boolean} True for https:, or http: on localhost / 127.0.0.1 (BASE_URL only). */
function isHttpsOrLocalHttp(value) {
  const url = parseUrl(value);
  if (!url) return false;
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HTTP_HOSTS.includes(url.hostname));
}

/**
 * @param {string} value
 * @returns {boolean} True only for a bare http: origin on localhost or 127.0.0.1 (no path, query, fragment or credentials).
 */
function isLoopbackHttpOrigin(value) {
  const url = parseUrl(value);
  return (
    url?.protocol === 'http:' &&
    LOCAL_HTTP_HOSTS.includes(url.hostname) &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '' &&
    url.username === '' &&
    url.password === ''
  );
}

/** Optional decimal USD string with a default, parsed to integer micro-USD without floating point. */
const usdBudget = (fallback) =>
  z
    .string()
    .default(fallback)
    .transform((text, ctx) => {
      try {
        return parseUsdToMicroUsd(text);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'Invalid USD amount' });
        return z.NEVER;
      }
    });

const coreSchema = z.object({
  NODE_ENV: z.string().transform((value) => (KNOWN_NODE_ENVS.includes(value) ? value : FALLBACK_NODE_ENV)),
  PORT: port.default(DEFAULT_PORT),
  BASE_URL: z.url().refine(isHttpsOrLocalHttp),
  TRUST_PROXY: z.coerce.number().int().min(0).default(DEFAULT_TRUST_PROXY),
  DIAGNOSTICS_TOKEN: z.string().min(MIN_DIAGNOSTICS_TOKEN_LENGTH).optional(),
  SUPABASE_URL: z.url().refine(isHttpsUrl),
  SUPABASE_SERVICE_ROLE_KEY: nonEmpty,
  ALLOWED_ORIGINS: z
    .string()
    .refine((value) => parseOriginList(value) !== null)
    .optional(),
  AI_DAILY_BUDGET_USD: usdBudget(DEFAULT_OWNER_BUDGET_USD),
  AI_DEMO_DAILY_BUDGET_USD: usdBudget(DEFAULT_DEMO_BUDGET_USD),
  AI_GLOBAL_DAILY_BUDGET_USD: usdBudget(DEFAULT_GLOBAL_BUDGET_USD),
  EMAIL_RELAY_URL: z.string().refine(isLoopbackHttpOrigin).default(DEFAULT_EMAIL_RELAY_URL),
  CONTACT_INBOX_EMAIL: z.email().optional(),
  OWNER_NOTIFY_EMAIL: z.email().optional(),
  ORDER_LINK_KEY: z.string().regex(LINK_KEY_PATTERN).optional(),
  EMAIL_WORKER_ENABLED: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
});

const aiSchema = z.object({
  ANTHROPIC_API_KEY: nonEmpty,
  CLAUDE_MODEL: nonEmpty.default(DEFAULT_CLAUDE_MODEL),
});

/** Thrown when environment validation fails. Carries variable NAMES only, never values. */
export class EnvValidationError extends Error {
  /** @param {string[]} variables Names of missing or invalid variables. */
  constructor(variables) {
    super(`Invalid environment configuration. Fix these variables: ${variables.join(', ')}`);
    this.name = 'EnvValidationError';
    this.variables = variables;
  }
}

function pickPresent(source, keys) {
  const present = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') present[key] = value.trim();
  }
  return present;
}

function failingNames(result) {
  if (result.success) return [];
  return [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
}

/**
 * Emails and links are built from BASE_URL, so a production process must not start with an http BASE_URL.
 * @param {{ success: boolean, data?: { NODE_ENV: string, BASE_URL: string } }} result The parsed core group.
 * @returns {string[]} ['BASE_URL'] when production runs with a non-https BASE_URL, else [].
 */
function productionBaseUrlFailures(result) {
  if (!result.success || result.data.NODE_ENV !== PRODUCTION_NODE_ENV) return [];
  return new URL(result.data.BASE_URL).protocol === 'https:' ? [] : ['BASE_URL'];
}

function parseGroup(schema, source, keys, failures) {
  const present = pickPresent(source, keys);
  if (Object.keys(present).length === 0) return null;
  const result = schema.safeParse(present);
  failures.push(...failingNames(result));
  return result.success ? result.data : null;
}

function buildGroups(source, failures) {
  const ai = parseGroup(aiSchema, source, GROUP_KEYS.ai, failures);
  return { ai: ai && { apiKey: ai.ANTHROPIC_API_KEY, model: ai.CLAUDE_MODEL } };
}

function buildAllowedOrigins(core) {
  const extra = core.ALLOWED_ORIGINS ? parseOriginList(core.ALLOWED_ORIGINS) : [];
  return [...new Set([new URL(core.BASE_URL).origin, ...extra])];
}

/**
 * Validates environment variables. Supabase is required. The optional ai group is validated only if any
 * member is set, and are then fully required. The three AI budget variables are optional with defaults (1.00 / 0.50
 * / 5.00 USD) and independent of the ai group. Cookie settings derive from BASE_URL, never NODE_ENV.
 * @param {Record<string, string | undefined>} [source] Defaults to process.env.
 * BASE_URL must be https (http only for localhost and 127.0.0.1, and never in production); SUPABASE_URL must be https. An unknown NODE_ENV
 * does not fail boot: it is treated as "production" (only the logger level reads it).
 * CONTACT_INBOX_EMAIL (optional) receives the contact form (OWNER_NOTIFY_EMAIL, also optional, is the fallback and the relay test address); EMAIL_WORKER_ENABLED (default true) switches the outbox worker.
 * EMAIL_RELAY_URL must be a bare http://localhost or http://127.0.0.1 origin (default http://127.0.0.1:2525).
 * @returns {{ nodeEnv: string, port: number, baseUrl: string, trustProxy: number,
 *   diagnosticsToken: string | undefined, supabase: { url: string, serviceRoleKey: string },
 *   allowedOrigins: string[], cookie: { name: string, secure: boolean },
 *   aiBudget: { ownerDailyMicroUsd: number, demoDailyMicroUsd: number, globalDailyMicroUsd: number },
 *   emailRelayUrl: string, contactInboxEmail: string | undefined, ownerNotifyEmail: string | undefined, orderLinkKey: string | undefined, emailWorkerEnabled: boolean, ai: object | null }}
 * @throws {EnvValidationError} Listing variable names only.
 */
export function loadEnv(source = process.env) {
  const failures = [];
  const core = coreSchema.safeParse(pickPresent(source, CORE_KEYS));
  failures.push(...failingNames(core), ...productionBaseUrlFailures(core));
  const groups = buildGroups(source, failures);
  if (failures.length > 0) throw new EnvValidationError([...new Set(failures)]);
  return {
    nodeEnv: core.data.NODE_ENV,
    port: core.data.PORT,
    baseUrl: core.data.BASE_URL,
    trustProxy: core.data.TRUST_PROXY,
    diagnosticsToken: core.data.DIAGNOSTICS_TOKEN,
    supabase: { url: core.data.SUPABASE_URL, serviceRoleKey: core.data.SUPABASE_SERVICE_ROLE_KEY },
    allowedOrigins: buildAllowedOrigins(core.data),
    cookie: deriveCookieConfig(core.data.BASE_URL),
    aiBudget: {
      ownerDailyMicroUsd: core.data.AI_DAILY_BUDGET_USD,
      demoDailyMicroUsd: core.data.AI_DEMO_DAILY_BUDGET_USD,
      globalDailyMicroUsd: core.data.AI_GLOBAL_DAILY_BUDGET_USD,
    },
    emailRelayUrl: core.data.EMAIL_RELAY_URL,
    contactInboxEmail: core.data.CONTACT_INBOX_EMAIL,
    ownerNotifyEmail: core.data.OWNER_NOTIFY_EMAIL,
    orderLinkKey: core.data.ORDER_LINK_KEY,
    emailWorkerEnabled: core.data.EMAIL_WORKER_ENABLED,
    ...groups,
  };
}
