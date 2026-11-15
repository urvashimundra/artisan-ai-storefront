import { throwIfError } from './pgErrors.js';

const STORE_COLUMNS = 'id, owner_id, slug, name, default_language, story, contact_email, created_at';

const toStore = (row) =>
  row
    ? {
        id: row.id,
        ownerId: row.owner_id,
        slug: row.slug,
        name: row.name,
        defaultLanguage: row.default_language,
        story: row.story,
        contactEmail: row.contact_email,
        createdAt: row.created_at,
      }
    : null;

/**
 * Store persistence. The stores table is resolved by owner id (from the session), never by a request-supplied
 * store id. Store-scoped tables added later must take storeId first and call requireStoreId.
 * @param {{ client: any }} deps
 */
export function createStoreRepository({ client }) {
  return {
    /** @param {string} ownerId @returns {Promise<ReturnType<typeof toStore>>} */
    async findByOwnerId(ownerId) {
      const { data, error } = await client.from('stores').select(STORE_COLUMNS).eq('owner_id', ownerId).maybeSingle();
      throwIfError(error);
      return toStore(data);
    },

    /**
     * @param {{ ownerId: string, slug: string, name: string, defaultLanguage: string, story: string }} store
     * @throws {import('./pgErrors.js').UniqueViolation}
     */
    async insert({ ownerId, slug, name, defaultLanguage, story }) {
      const row = { owner_id: ownerId, slug, name, default_language: defaultLanguage, story };
      const { data, error } = await client.from('stores').insert(row).select(STORE_COLUMNS).single();
      throwIfError(error);
      return toStore(data);
    },
  };
}
