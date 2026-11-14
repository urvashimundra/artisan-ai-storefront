import { createClient as defaultCreateClient } from '@supabase/supabase-js';
import { ProbeError } from '../lib/probeError.js';
import { withTimeout } from '../lib/timeout.js';

export const SUPABASE_TIMEOUT_MS = 8000;

function buildClient(createClient, config) {
  return createClient(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS) }),
    },
  });
}

/**
 * Supabase connectivity probe. Lists storage buckets, so it needs no table.
 * @param {{ config: { url: string, serviceRoleKey: string }, createClient?: Function }} deps
 * @returns {() => Promise<void>} Resolves on success; rejects with a safe error otherwise.
 */
export function createSupabaseProbe({ config, createClient = defaultCreateClient }) {
  return async function checkSupabase() {
    const client = buildClient(createClient, config);
    const { error } = await withTimeout(() => client.storage.listBuckets(), SUPABASE_TIMEOUT_MS, 'supabase');
    if (error) throw new ProbeError('SUPABASE_STORAGE_ERROR');
  };
}
