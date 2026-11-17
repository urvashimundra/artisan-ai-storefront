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

/** Module 3 (migration 006) constraint and index names. Mirrored in db/migrations/006_storefront.sql. */
export const STOREFRONT_CONSTRAINTS = Object.freeze({
  tagline: 'stores_tagline_length_check',
  accent: 'stores_accent_key_check',
  whatsappNumber: 'stores_whatsapp_number_format_check',
  whatsappEnabled: 'stores_whatsapp_enabled_requires_number_check',
  instagram: 'stores_instagram_handle_format_check',
  upi: 'stores_upi_id_format_check',
});

export const STOREFRONT_INDEXES = Object.freeze(['products_store_id_published_created_idx']);

/** Module 3 polish (migration 007) constraint names. Mirrored in db/migrations/007_store_translations.sql. */
export const STORE_TRANSLATION_CONSTRAINTS = Object.freeze({
  pkey: 'store_translations_pkey',
  storeFkey: 'store_translations_store_fkey',
  language: 'store_translations_language_check',
  tagline: 'store_translations_tagline_length_check',
  story: 'store_translations_story_length_check',
  source: 'store_translations_source_check',
});

/** Module 4a (migration 008) constraint, index and function names. Mirrored in db/migrations/008_orders.sql. */
export const ORDER_CONSTRAINTS = Object.freeze({
  statusToken: 'orders_status_token_hash_key',
  reference: 'orders_store_reference_key',
  utr: 'order_payment_attempts_store_utr_key',
  itemsPerOrder: 'order_items_order_product_key',
});

export const ORDER_INDEXES = Object.freeze([
  'orders_status_expires_at_idx',
  'orders_store_created_at_idx',
  'orders_store_status_idx',
  'order_items_product_id_idx',
  'order_payment_attempts_order_id_idx',
]);

export const ORDER_FUNCTIONS = Object.freeze([
  'place_order',
  'submit_payment_reference',
  'resolve_payment',
  'cancel_order',
  'expire_overdue_orders',
]);

/** Module 5 (migration 010) constraint, index and function names. Mirrored in db/migrations/010_email_outbox_contact.sql. */
export const EMAIL_CONSTRAINTS = Object.freeze({
  dedupeKey: 'email_outbox_dedupe_key_key',
  kind: 'email_outbox_kind_check',
  toEmail: 'email_outbox_to_email_check',
  replyTo: 'email_outbox_reply_to_check',
  language: 'email_outbox_language_check',
  subject: 'email_outbox_subject_check',
  body: 'email_outbox_body_check',
  dedupeKeyLength: 'email_outbox_dedupe_key_length_check',
  status: 'email_outbox_status_check',
  attempts: 'email_outbox_attempts_check',
  errorCode: 'email_outbox_error_code_check',
  contactName: 'contact_messages_name_check',
  contactEmail: 'contact_messages_email_check',
  contactMessage: 'contact_messages_message_check',
});

export const EMAIL_INDEXES = Object.freeze([
  'email_outbox_status_next_attempt_idx',
  'email_outbox_recipient_created_idx',
  'email_outbox_created_at_idx',
  'contact_messages_email_created_idx',
]);

export const EMAIL_FUNCTIONS = Object.freeze(['email_enqueue', 'email_enqueue_order', 'claim_due_emails', 'finish_email']);

/** Module 6 (migration 012) constraint, index and table names. Mirrored in db/migrations/012_assistant.sql. */
export const ASSISTANT_CONSTRAINTS = Object.freeze({
  knowledgePkey: 'store_knowledge_pkey',
  knowledgeStoreFkey: 'store_knowledge_store_fkey',
  knowledgeContent: 'store_knowledge_content_length_check',
  knowledgeBulkRules: 'store_knowledge_bulk_rules_check',
  enquiryPkey: 'enquiries_pkey',
  enquiryStoreFkey: 'enquiries_store_fkey',
  enquiryProductFkey: 'enquiries_product_fkey',
  enquiryTokenHash: 'enquiries_token_hash_key',
  enquiryLanguage: 'enquiries_language_check',
  enquiryCustomerName: 'enquiries_customer_name_check',
  enquiryCustomerPhone: 'enquiries_customer_phone_check',
  enquiryQuestion: 'enquiries_question_check',
  enquiryStatus: 'enquiries_status_check',
  enquiryAnswerText: 'enquiries_answer_text_check',
  enquiryAnsweredHasAnswer: 'enquiries_answered_has_answer_check',
  enquiryFlagReason: 'enquiries_flag_reason_check',
  enquiryTrace: 'enquiries_trace_check',
  enquirySellerReply: 'enquiries_seller_reply_check',
  enquiryReplyPair: 'enquiries_reply_pair_check',
  enquiryTokenHashFormat: 'enquiries_token_hash_format_check',
  enquiryTokenEnc: 'enquiries_token_enc_check',
});

export const ASSISTANT_INDEXES = Object.freeze(['enquiries_store_status_created_idx', 'enquiries_store_phone_created_idx']);
