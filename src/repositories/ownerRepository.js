import { throwIfError } from './pgErrors.js';

const OWNER_COLUMNS = 'id, email, password_hash, is_demo';

const toOwner = (row) => (row ? { id: row.id, email: row.email, passwordHash: row.password_hash, isDemo: row.is_demo } : null);

/**
 * Owner persistence. Keyed by owner id. Emails are stored normalized (lowercase).
 * @param {{ client: any }} deps
 */
export function createOwnerRepository({ client }) {
  return {
    /** @param {string} email Normalized email. @returns {Promise<{id: string, email: string, passwordHash: string, isDemo: boolean} | null>} */
    async findByEmail(email) {
      const { data, error } = await client.from('owners').select(OWNER_COLUMNS).eq('email', email).maybeSingle();
      throwIfError(error);
      return toOwner(data);
    },

    /** @param {string} id @returns {Promise<{id: string, email: string, passwordHash: string, isDemo: boolean} | null>} */
    async findById(id) {
      const { data, error } = await client.from('owners').select(OWNER_COLUMNS).eq('id', id).maybeSingle();
      throwIfError(error);
      return toOwner(data);
    },

    /**
     * @param {{ email: string, passwordHash: string, isDemo: boolean }} owner
     * @returns {Promise<{ id: string }>}
     * @throws {import('./pgErrors.js').UniqueViolation}
     */
    async insert({ email, passwordHash, isDemo }) {
      const row = { email, password_hash: passwordHash, is_demo: isDemo };
      const { data, error } = await client.from('owners').insert(row).select('id').single();
      throwIfError(error);
      return { id: data.id };
    },
  };
}
