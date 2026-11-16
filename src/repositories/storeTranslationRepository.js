import { throwIfError } from './pgErrors.js';
import { requireStoreId } from './requireStoreId.js';

const TABLE = 'store_translations';
const COLUMNS = 'language, tagline, story, source, approved';

const toTranslation = (row) => ({
  language: row.language,
  tagline: row.tagline,
  story: row.story,
  source: row.source,
  approved: row.approved,
});

const toRow = (storeId, translation, nowIso) => ({
  store_id: storeId,
  language: translation.language,
  tagline: translation.tagline,
  story: translation.story,
  source: translation.source,
  approved: translation.approved,
  updated_at: nowIso,
});

/**
 * Owner-side persistence of translated shop text. Every method takes the store id first (resolved from the session by
 * the caller, never from input), validates it, and scopes the query by it.
 * @param {{ client: any, now?: () => number }} deps
 */
export function createStoreTranslationRepository({ client, now = Date.now }) {
  const nowIso = () => new Date(now()).toISOString();

  return {
    /** @returns {Promise<{ language: string, tagline: string, story: string, source: string, approved: boolean }[]>} */
    async list(storeId) {
      requireStoreId(storeId);
      const { data, error } = await client.from(TABLE).select(COLUMNS).eq('store_id', storeId);
      throwIfError(error);
      return (data ?? []).map(toTranslation);
    },

    /** @returns {Promise<ReturnType<typeof toTranslation> | null>} */
    async find(storeId, language) {
      requireStoreId(storeId);
      const { data, error } = await client.from(TABLE).select(COLUMNS).eq('store_id', storeId).eq('language', language).maybeSingle();
      throwIfError(error);
      return data ? toTranslation(data) : null;
    },

    /**
     * One upsert statement (atomic) for one or more languages of this store.
     * @param {string} storeId
     * @param {{ language: string, tagline: string, story: string, source: string, approved: boolean }[]} translations Validated.
     */
    async upsertMany(storeId, translations) {
      requireStoreId(storeId);
      const rows = translations.map((translation) => toRow(storeId, translation, nowIso()));
      const { error } = await client.from(TABLE).upsert(rows, { onConflict: 'store_id,language' });
      throwIfError(error);
    },

    /** Withdraws every translation of this store from the public shop. Fail-closed helper for default-text changes. */
    async unapproveAll(storeId) {
      requireStoreId(storeId);
      const changes = { approved: false, updated_at: nowIso() };
      const { error } = await client.from(TABLE).update(changes).eq('store_id', storeId);
      throwIfError(error);
    },

    /**
     * One UPDATE approving every translation of this store that has a story, except the default language. Rows already
     * approved are left alone, so repeating the call changes nothing.
     * @param {string} storeId
     * @param {string} defaultLanguage The store's own language: its text lives in `stores` and never has a row to approve.
     */
    async approveAll(storeId, defaultLanguage) {
      requireStoreId(storeId);
      const changes = { approved: true, updated_at: nowIso() };
      const query = client.from(TABLE).update(changes).eq('store_id', storeId).neq('language', defaultLanguage);
      const { error } = await query.neq('story', '').eq('approved', false);
      throwIfError(error);
    },
  };
}
