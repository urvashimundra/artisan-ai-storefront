import { createClient as defaultCreateClient } from '@supabase/supabase-js';
import { ProbeError } from '../lib/probeError.js';
import { withTimeout } from '../lib/timeout.js';
import { SUPABASE_TIMEOUT_MS, createSupabaseClient } from './supabaseClient.js';

export { SUPABASE_TIMEOUT_MS };

/**
 * Supabase connectivity probe. Lists storage buckets, so it needs no table.
 * @param {{ config: { url: string, serviceRoleKey: string }, createClient?: Function }} deps
 * @returns {() => Promise<void>} Resolves on success; rejects with a safe error otherwise.
 */
export function createSupabaseProbe({ config, createClient = defaultCreateClient }) {
  return async function checkSupabase() {
    const client = createSupabaseClient(config, createClient);
    const { error } = await withTimeout(() => client.storage.listBuckets(), SUPABASE_TIMEOUT_MS, 'supabase');
    if (error) throw new ProbeError('SUPABASE_STORAGE_ERROR');
  };
}
