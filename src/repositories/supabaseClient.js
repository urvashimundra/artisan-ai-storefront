import { createClient as defaultCreateClient } from '@supabase/supabase-js';

export const SUPABASE_TIMEOUT_MS = 8000;
/** Storage transfers photos of up to 4 MB, so they get a longer budget than table calls. */
export const SUPABASE_STORAGE_TIMEOUT_MS = 30000;

/**
 * Builds a server-side Supabase client with no session persistence and a timeout on every request.
 * The one place Supabase is configured; repositories and the diagnostics probe both use it.
 * @param {{ url: string, serviceRoleKey: string }} config
 * @param {Function} [createClient] Injectable for tests.
 * @param {number} [timeoutMs] Per-request timeout.
 * @returns {any}
 */
export function createSupabaseClient(config, createClient = defaultCreateClient, timeoutMs = SUPABASE_TIMEOUT_MS) {
  return createClient(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) }),
    },
  });
}
