import { throwIfError } from './pgErrors.js';
import { requireStoreId } from './requireStoreId.js';

const STORE_COLUMNS =
  'id, owner_id, slug, name, default_language, story, contact_email, tagline, accent_key, whatsapp_number, whatsapp_enabled, instagram_handle, upi_id, notify_enquiry_email, created_at, updated_at';

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
        tagline: row.tagline,
        accentKey: row.accent_key,
        whatsappNumber: row.whatsapp_number,
        whatsappEnabled: row.whatsapp_enabled,
        instagramHandle: row.instagram_handle,
        upiId: row.upi_id,
        notifyEnquiryEmail: row.notify_enquiry_email,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
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
     * @param {{ ownerId: string, slug: string, name: string, defaultLanguage: string, story: string, tagline: string, accentKey: string }} store
     * @throws {import('./pgErrors.js').UniqueViolation}
     */
    async insert({ ownerId, slug, name, defaultLanguage, story, tagline, accentKey }) {
      const row = { owner_id: ownerId, slug, name, default_language: defaultLanguage, story, tagline, accent_key: accentKey };
      const { data, error } = await client.from('stores').insert(row).select(STORE_COLUMNS).single();
      throwIfError(error);
      return toStore(data);
    },

    /**
     * Single UPDATE of the storefront settings, scoped by the store id the caller resolved from the session.
     * @param {string} storeId
     * @param {{ tagline: string, story: string, accentKey: string, whatsappNumber: string | null, whatsappEnabled: boolean,
     *   instagramHandle: string | null, upiId: string | null, notifyEnquiryEmail: boolean }} settings Already validated.
     * @returns {Promise<ReturnType<typeof toStore>>} null when the store no longer exists.
     */
    async updateSettings(storeId, settings) {
      requireStoreId(storeId);
      const changes = {
        tagline: settings.tagline,
        story: settings.story,
        accent_key: settings.accentKey,
        whatsapp_number: settings.whatsappNumber,
        whatsapp_enabled: settings.whatsappEnabled,
        instagram_handle: settings.instagramHandle,
        upi_id: settings.upiId,
        notify_enquiry_email: settings.notifyEnquiryEmail,
        updated_at: new Date().toISOString(),
      };
      const query = client.from('stores').update(changes).eq('id', storeId).select(STORE_COLUMNS);
      const { data, error } = await query.maybeSingle();
      throwIfError(error);
      return toStore(data);
    },
  };
}
