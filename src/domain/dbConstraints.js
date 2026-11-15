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
