import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { emailSchema, newPasswordSchema } from '../src/domain/credentialRules.js';
import { createPasswordService } from '../src/lib/password.js';
import { createOwnerRepository } from '../src/repositories/ownerRepository.js';
import { createSessionRepository } from '../src/repositories/sessionRepository.js';
import { createStoreRepository } from '../src/repositories/storeRepository.js';
import { createSupabaseClient } from '../src/repositories/supabaseClient.js';
import { createAuthService } from '../src/services/authService.js';
import { createSessionService } from '../src/services/sessionService.js';
import { createStoreTranslationRepository } from '../src/repositories/storeTranslationRepository.js';
import { createStoreService } from '../src/services/storeService.js';

const EXIT_FAILURE = 1;

/** The one demo store. The slug is fixed; if another owner already holds it the seed stops. */
export const DEMO_STORE = Object.freeze({
  name: 'Demo Shop',
  slug: 'demo-shop',
  defaultLanguage: 'en',
  story: 'A demonstration store for The Artisan Story.',
});

const seedEnvSchema = z.object({
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  DEMO_OWNER_EMAIL: emailSchema,
  DEMO_OWNER_PASSWORD: newPasswordSchema,
});

/** Raised for a safe, expected refusal. The message never contains credentials. */
export class SeedError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'SeedError';
  }
}

/**
 * Validates the seed environment with the same email and password policy as signup. Names only on failure.
 * @param {Record<string, string | undefined>} env
 * @returns {{ supabase: { url: string, serviceRoleKey: string }, email: string, password: string }}
 * @throws {SeedError}
 */
export function readSeedEnv(env) {
  const result = seedEnvSchema.safeParse({
    SUPABASE_URL: env.SUPABASE_URL?.trim(),
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
    DEMO_OWNER_EMAIL: env.DEMO_OWNER_EMAIL,
    DEMO_OWNER_PASSWORD: env.DEMO_OWNER_PASSWORD,
  });
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
    throw new SeedError(`Invalid seed configuration. Fix these variables: ${names.join(', ')}`);
  }
  const data = result.data;
  return {
    supabase: { url: data.SUPABASE_URL, serviceRoleKey: data.SUPABASE_SERVICE_ROLE_KEY },
    email: data.DEMO_OWNER_EMAIL,
    password: data.DEMO_OWNER_PASSWORD,
  };
}

/**
 * Idempotent seed. Aborts, without writing anything, if the email belongs to a non-demo owner. Never changes an
 * existing demo owner's password. Uses the normal owner and store services; the only special thing here is that
 * this script, and nothing reachable over HTTP, passes isDemo: true.
 * @param {{ email: string, password: string, owners: { findByEmail: Function }, auth: { createOwnerRecord: Function },
 *   stores: { findForOwner: Function, create: Function }, log: (message: string) => void }} deps
 */
export async function runSeed({ email, password, owners, auth, stores, log }) {
  const existing = await owners.findByEmail(email);
  if (existing && !existing.isDemo) throw new SeedError('That email belongs to a non-demo owner. Nothing was changed.');
  const ownerId = existing ? existing.id : (await auth.createOwnerRecord({ email, password, isDemo: true })).id;
  log(existing ? 'Demo owner already exists; password left unchanged.' : 'Demo owner created.');
  if (await stores.findForOwner(ownerId)) return log('Demo store already exists.');
  await stores.create(ownerId, DEMO_STORE);
  return log('Demo store created.');
}

/**
 * Builds the real services from the environment and runs the seed. Called only by the command line entry point.
 * @param {Record<string, string | undefined>} [env]
 * @param {(message: string) => void} [log]
 */
export async function main(env = process.env, log = console.log) {
  const { supabase, email, password } = readSeedEnv(env);
  const client = createSupabaseClient(supabase);
  const owners = createOwnerRepository({ client });
  const sessions = createSessionService({ sessions: createSessionRepository({ client }), owners });
  const auth = createAuthService({ owners, passwords: await createPasswordService(), sessions, inviteCode: undefined });
  const stores = createStoreService({ stores: createStoreRepository({ client }), translations: createStoreTranslationRepository({ client }) });
  await runSeed({ email, password, owners, auth, stores, log });
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main().catch((error) => {
    const reason = error instanceof SeedError ? error.message : `Seed failed (${error?.code ?? error?.name ?? 'Error'}).`;
    console.error(reason);
    process.exit(EXIT_FAILURE);
  });
}
