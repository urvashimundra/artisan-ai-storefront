import { throwIfError } from './pgErrors.js';

/**
 * Session persistence. Only token hashes are stored. Keyed by owner id.
 * @param {{ client: any }} deps
 */
export function createSessionRepository({ client }) {
  return {
    /** @param {{ ownerId: string, tokenHash: string, expiresAt: string }} session */
    async insert({ ownerId, tokenHash, expiresAt }) {
      const row = { owner_id: ownerId, token_hash: tokenHash, expires_at: expiresAt };
      const { error } = await client.from('sessions').insert(row);
      throwIfError(error);
    },

    /** @param {string} tokenHash @returns {Promise<{ id: string, ownerId: string, expiresAt: string } | null>} */
    async findByTokenHash(tokenHash) {
      const { data, error } = await client
        .from('sessions')
        .select('id, owner_id, expires_at')
        .eq('token_hash', tokenHash)
        .maybeSingle();
      throwIfError(error);
      return data ? { id: data.id, ownerId: data.owner_id, expiresAt: data.expires_at } : null;
    },

    /** @param {string} id */
    async deleteById(id) {
      const { error } = await client.from('sessions').delete().eq('id', id);
      throwIfError(error);
    },

    /** @param {string} tokenHash */
    async deleteByTokenHash(tokenHash) {
      const { error } = await client.from('sessions').delete().eq('token_hash', tokenHash);
      throwIfError(error);
    },

    /** @param {string} ownerId @param {string} nowIso Sessions expiring at or before this are removed. */
    async deleteExpiredForOwner(ownerId, nowIso) {
      const { error } = await client.from('sessions').delete().eq('owner_id', ownerId).lte('expires_at', nowIso);
      throwIfError(error);
    },
  };
}
