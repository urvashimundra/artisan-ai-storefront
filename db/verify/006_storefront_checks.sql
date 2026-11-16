-- Read-only checks for migration 006. Run in the Supabase SQL editor. Every row must show ok = true.
WITH cols AS (
  SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'stores'
), defs AS (
  SELECT k.conname, pg_get_constraintdef(k.oid) AS def
  FROM pg_constraint k WHERE k.conrelid = 'public.stores'::regclass AND k.contype = 'c'
)
SELECT 'column_tagline_text_not_null_default_empty' AS check_name,
       EXISTS (SELECT 1 FROM cols WHERE column_name = 'tagline' AND data_type = 'text' AND is_nullable = 'NO'
               AND column_default LIKE '''''::text%') AS ok
UNION ALL
SELECT 'column_accent_key_text_not_null_default_terracotta',
       EXISTS (SELECT 1 FROM cols WHERE column_name = 'accent_key' AND data_type = 'text' AND is_nullable = 'NO'
               AND column_default LIKE '''terracotta''%')
UNION ALL
SELECT 'column_whatsapp_number_text_nullable',
       EXISTS (SELECT 1 FROM cols WHERE column_name = 'whatsapp_number' AND data_type = 'text' AND is_nullable = 'YES')
UNION ALL
SELECT 'column_whatsapp_enabled_boolean_not_null_default_false',
       EXISTS (SELECT 1 FROM cols WHERE column_name = 'whatsapp_enabled' AND data_type = 'boolean' AND is_nullable = 'NO'
               AND column_default = 'false')
UNION ALL
SELECT 'column_instagram_handle_text_nullable',
       EXISTS (SELECT 1 FROM cols WHERE column_name = 'instagram_handle' AND data_type = 'text' AND is_nullable = 'YES')
UNION ALL
SELECT 'column_upi_id_text_nullable',
       EXISTS (SELECT 1 FROM cols WHERE column_name = 'upi_id' AND data_type = 'text' AND is_nullable = 'YES')
UNION ALL
SELECT 'constraint_exists: ' || c.name,
       EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conname = c.name AND k.conrelid = 'public.stores'::regclass AND k.contype = 'c')
FROM (VALUES ('stores_tagline_length_check'), ('stores_accent_key_check'), ('stores_whatsapp_number_format_check'),
             ('stores_whatsapp_enabled_requires_number_check'), ('stores_instagram_handle_format_check'),
             ('stores_upi_id_format_check')) AS c(name)
UNION ALL
SELECT 'constraint_definition_tagline_max_120',
       EXISTS (SELECT 1 FROM defs WHERE conname = 'stores_tagline_length_check'
               AND position('char_length(tagline) <= 120' IN def) > 0)
UNION ALL
SELECT 'constraint_definition_accent_key_exactly_the_six_keys',
       EXISTS (SELECT 1 FROM defs WHERE conname = 'stores_accent_key_check'
               AND position('accent_key' IN def) > 0
               AND position('''terracotta''::text' IN def) > 0 AND position('''indigo''::text' IN def) > 0
               AND position('''forest''::text' IN def) > 0 AND position('''plum''::text' IN def) > 0
               AND position('''teal''::text' IN def) > 0 AND position('''saffron''::text' IN def) > 0
               AND (length(def) - length(replace(def, '::text', ''))) / length('::text') = 6)
UNION ALL
SELECT 'constraint_definition_whatsapp_number_nullable_10_to_15_digits',
       EXISTS (SELECT 1 FROM defs WHERE conname = 'stores_whatsapp_number_format_check'
               AND position('whatsapp_number IS NULL' IN def) > 0
               AND position('''^[0-9]{10,15}$''' IN def) > 0)
UNION ALL
SELECT 'constraint_definition_whatsapp_enabled_requires_non_null_number',
       EXISTS (SELECT 1 FROM defs WHERE conname = 'stores_whatsapp_enabled_requires_number_check'
               AND position('NOT whatsapp_enabled' IN def) > 0
               AND position('whatsapp_number IS NOT NULL' IN def) > 0)
UNION ALL
SELECT 'constraint_definition_instagram_handle_nullable_1_to_30',
       EXISTS (SELECT 1 FROM defs WHERE conname = 'stores_instagram_handle_format_check'
               AND position('instagram_handle IS NULL' IN def) > 0
               AND position('''^[A-Za-z0-9._]{1,30}$''' IN def) > 0)
UNION ALL
SELECT 'constraint_definition_upi_id_nullable_pattern_and_max_100',
       EXISTS (SELECT 1 FROM defs WHERE conname = 'stores_upi_id_format_check'
               AND position('upi_id IS NULL' IN def) > 0
               AND position('char_length(upi_id) <= 100' IN def) > 0
               AND position('''^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9.]{1,63}$''' IN def) > 0)
UNION ALL
SELECT 'index_products_store_id_published_created_idx_partial_newest_first',
       EXISTS (SELECT 1 FROM pg_indexes i WHERE i.schemaname = 'public' AND i.indexname = 'products_store_id_published_created_idx'
               AND i.indexdef LIKE '%(store_id, created_at DESC, id DESC)%' AND i.indexdef LIKE '%WHERE%published%')
UNION ALL
SELECT 'stores_rls_still_on', COALESCE((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.stores')), false)
UNION ALL
SELECT 'no_policies_on_stores', NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'stores')
UNION ALL
SELECT 'stores_no_privileges_for_anon_or_authenticated',
       NOT (has_table_privilege('anon', 'public.stores', 'SELECT') OR has_table_privilege('anon', 'public.stores', 'INSERT')
         OR has_table_privilege('anon', 'public.stores', 'UPDATE') OR has_table_privilege('anon', 'public.stores', 'DELETE')
         OR has_table_privilege('authenticated', 'public.stores', 'SELECT') OR has_table_privilege('authenticated', 'public.stores', 'INSERT')
         OR has_table_privilege('authenticated', 'public.stores', 'UPDATE') OR has_table_privilege('authenticated', 'public.stores', 'DELETE'))
UNION ALL
SELECT 'stores_service_role_can_read_write',
       has_table_privilege('service_role', 'public.stores', 'SELECT') AND has_table_privilege('service_role', 'public.stores', 'UPDATE')
UNION ALL
SELECT 'products_rls_still_on', COALESCE((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.products')), false)
UNION ALL
SELECT 'no_policies_on_products', NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'products')
UNION ALL
SELECT 'products_no_privileges_for_anon_or_authenticated',
       NOT (has_table_privilege('anon', 'public.products', 'SELECT') OR has_table_privilege('anon', 'public.products', 'INSERT')
         OR has_table_privilege('anon', 'public.products', 'UPDATE') OR has_table_privilege('anon', 'public.products', 'DELETE')
         OR has_table_privilege('authenticated', 'public.products', 'SELECT') OR has_table_privilege('authenticated', 'public.products', 'INSERT')
         OR has_table_privilege('authenticated', 'public.products', 'UPDATE') OR has_table_privilege('authenticated', 'public.products', 'DELETE'))
UNION ALL
SELECT 'stores_service_role_has_select_insert_update',
       has_table_privilege('service_role', 'public.stores', 'SELECT') AND has_table_privilege('service_role', 'public.stores', 'INSERT')
       AND has_table_privilege('service_role', 'public.stores', 'UPDATE')
UNION ALL
SELECT 'products_service_role_has_select_insert_update_delete',
       has_table_privilege('service_role', 'public.products', 'SELECT') AND has_table_privilege('service_role', 'public.products', 'INSERT')
       AND has_table_privilege('service_role', 'public.products', 'UPDATE') AND has_table_privilege('service_role', 'public.products', 'DELETE')
ORDER BY 1;
