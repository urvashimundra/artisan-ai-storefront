import { createClient as defaultCreateClient } from '@supabase/supabase-js';

export const SUPABASE_TIMEOUT_MS = 8000;

/**
 * Builds a server-side Supabase client with no session persistence and a timeout on every request.
 * The one place Supabase is configured; repositories and the diagnostics probe both use it.
 * @param {{ url: string, serviceRoleKey: string }} config
 * @param {Function} [createClient] Injectable for tests.
 * @returns {any}
 */
export function createSupabaseClient(config, createClient = defaultCreateClient) {
  return createClient(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS) }),
    },
  });
}
