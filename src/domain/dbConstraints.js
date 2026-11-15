/** Database constraint and index names. Mirrored in db/migrations/001_owners_sessions_stores.sql. */
export const OWNERS_EMAIL_LOWER_KEY = 'owners_email_lower_key';
export const STORES_OWNER_ID_KEY = 'stores_owner_id_key';
export const STORES_SLUG_KEY = 'stores_slug_key';
export const SESSIONS_TOKEN_HASH_KEY = 'sessions_token_hash_key';

/** PostgreSQL SQLSTATE for a unique violation. */
export const PG_UNIQUE_VIOLATION = '23505';

/** Slug format; identical to the CHECK in the migration: 1-40 chars, no leading or trailing hyphen. */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** Slugs nobody may register. Mirrored in the stores_slug_not_reserved CHECK. */
export const RESERVED_SLUGS = Object.freeze(['admin', 'support', 'api', 'internal', 'www']);

/** Module 2b (migration 004) constraint and index names. Mirrored in db/migrations/004_products.sql. */
export const PRODUCT_CONSTRAINTS = Object.freeze([
  'products_id_store_id_key',
  'products_status_check',
  'products_price_paise_check',
  'products_published_requires_price_check',
  'products_stock_check',
  'products_story_length_check',
  'products_image_path_length_check',
  'products_image_content_type_check',
  'products_ai_status_check',
  'product_translations_pkey',
  'product_translations_product_fkey',
  'product_translations_language_check',
  'product_translations_title_length_check',
  'product_translations_description_length_check',
  'product_translations_alt_text_length_check',
  'product_translations_source_check',
  'product_translations_approved_complete_check',
  'ai_drafts_kind_check',
  'ai_drafts_status_check',
  'ai_drafts_model_length_check',
  'ai_drafts_usage_check',
]);

export const PRODUCT_INDEXES = Object.freeze(['products_store_id_created_at_idx', 'ai_drafts_store_id_created_at_idx']);
