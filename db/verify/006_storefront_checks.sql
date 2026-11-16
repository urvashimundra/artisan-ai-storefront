-- Read-only checks for migration 006. Run in the Supabase SQL editor. Every row must show ok = true.
WITH cols AS (
  SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'stores'
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
SELECT 'constraint_definition_whatsapp_enabled_requires_number',
       EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conname = 'stores_whatsapp_enabled_requires_number_check'
               AND pg_get_constraintdef(k.oid) LIKE '%whatsapp_number IS NOT NULL%')
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
SELECT 'products_no_privileges_for_anon_or_authenticated',
       NOT (has_table_privilege('anon', 'public.products', 'SELECT') OR has_table_privilege('authenticated', 'public.products', 'SELECT'))
ORDER BY 1;
