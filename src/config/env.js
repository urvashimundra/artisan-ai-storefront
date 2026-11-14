import { z } from 'zod';

const DEFAULT_PORT = 3000;
const MAX_PORT = 65535;
const DEFAULT_TRUST_PROXY = 1;
const MIN_DIAGNOSTICS_TOKEN_LENGTH = 24;
const DEFAULT_CLAUDE_MODEL = 'claude-haiku-5-5';

const GROUP_KEYS = {
  supabase: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
  ai: ['ANTHROPIC_API_KEY', 'CLAUDE_MODEL', 'AI_DAILY_BUDGET_USD'],
  smtp: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM', 'OWNER_NOTIFY_EMAIL'],
};
const CORE_KEYS = ['NODE_ENV', 'PORT', 'BASE_URL', 'TRUST_PROXY', 'DIAGNOSTICS_TOKEN'];

const nonEmpty = z.string().min(1);
const port = z.coerce.number().int().min(1).max(MAX_PORT);

const coreSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: port.default(DEFAULT_PORT),
  BASE_URL: z.url(),
  TRUST_PROXY: z.coerce.number().int().min(0).default(DEFAULT_TRUST_PROXY),
  DIAGNOSTICS_TOKEN: z.string().min(MIN_DIAGNOSTICS_TOKEN_LENGTH).optional(),
});

const supabaseSchema = z.object({
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: nonEmpty,
});

const aiSchema = z.object({
  ANTHROPIC_API_KEY: nonEmpty,
  CLAUDE_MODEL: nonEmpty.default(DEFAULT_CLAUDE_MODEL),
  AI_DAILY_BUDGET_USD: z.coerce.number().positive().finite(),
});

const smtpSchema = z.object({
  SMTP_HOST: nonEmpty,
  SMTP_PORT: port,
  SMTP_USER: nonEmpty,
  SMTP_PASS: nonEmpty,
  MAIL_FROM: nonEmpty,
  OWNER_NOTIFY_EMAIL: z.email(),
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

function parseGroup(schema, source, keys, failures) {
  const present = pickPresent(source, keys);
  if (Object.keys(present).length === 0) return null;
  const result = schema.safeParse(present);
  failures.push(...failingNames(result));
  return result.success ? result.data : null;
}

function buildGroups(source, failures) {
  const supabase = parseGroup(supabaseSchema, source, GROUP_KEYS.supabase, failures);
  const ai = parseGroup(aiSchema, source, GROUP_KEYS.ai, failures);
  const smtp = parseGroup(smtpSchema, source, GROUP_KEYS.smtp, failures);
  return {
    supabase: supabase && { url: supabase.SUPABASE_URL, serviceRoleKey: supabase.SUPABASE_SERVICE_ROLE_KEY },
    ai: ai && { apiKey: ai.ANTHROPIC_API_KEY, model: ai.CLAUDE_MODEL, dailyBudgetUsd: ai.AI_DAILY_BUDGET_USD },
    smtp: smtp && {
      host: smtp.SMTP_HOST,
      port: smtp.SMTP_PORT,
      user: smtp.SMTP_USER,
      pass: smtp.SMTP_PASS,
      from: smtp.MAIL_FROM,
      ownerNotifyEmail: smtp.OWNER_NOTIFY_EMAIL,
    },
  };
}

/**
 * Validates environment variables. Optional groups (supabase, ai, smtp) are validated only if any
 * member is set, and are then fully required.
 * @param {Record<string, string | undefined>} [source] Defaults to process.env.
 * @returns {{ nodeEnv: string, port: number, baseUrl: string, trustProxy: number,
 *   diagnosticsToken: string | undefined, supabase: object | null, ai: object | null, smtp: object | null }}
 * @throws {EnvValidationError} Listing variable names only.
 */
export function loadEnv(source = process.env) {
  const failures = [];
  const core = coreSchema.safeParse(pickPresent(source, CORE_KEYS));
  failures.push(...failingNames(core));
  const groups = buildGroups(source, failures);
  if (failures.length > 0) throw new EnvValidationError([...new Set(failures)]);
  return {
    nodeEnv: core.data.NODE_ENV,
    port: core.data.PORT,
    baseUrl: core.data.BASE_URL,
    trustProxy: core.data.TRUST_PROXY,
    diagnosticsToken: core.data.DIAGNOSTICS_TOKEN,
    ...groups,
  };
}
