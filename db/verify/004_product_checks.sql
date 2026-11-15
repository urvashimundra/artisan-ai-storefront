-- Read-only checks for migration 004. Run in the Supabase SQL editor. Every row must show ok = true.
WITH tables AS (
  SELECT unnest(ARRAY['products', 'product_translations', 'ai_drafts']) AS name
), funcs AS (
  SELECT p.oid, p.proname, p.proconfig, pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('save_ai_listing', 'save_product_review')
)
SELECT 'table_exists_rls_on: ' || t.name AS check_name,
       COALESCE((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.' || t.name)), false) AS ok
FROM tables t
UNION ALL
SELECT 'no_policies: ' || t.name,
       NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t.name)
FROM tables t
UNION ALL
SELECT 'no_public_anon_or_authenticated_table_privileges: ' || t.name,
       NOT (has_table_privilege('anon', 'public.' || t.name, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         OR has_table_privilege('authenticated', 'public.' || t.name, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
       AND NOT EXISTS (SELECT 1 FROM pg_class c, aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
                       WHERE c.oid = to_regclass('public.' || t.name) AND a.grantee = 0)
FROM tables t
UNION ALL
SELECT 'service_role_table_privileges: ' || t.name,
       has_table_privilege('service_role', 'public.' || t.name, 'SELECT,INSERT,UPDATE,DELETE')
FROM tables t
UNION ALL
SELECT 'exactly_two_functions', (SELECT count(*) FROM funcs) = 2
UNION ALL
SELECT 'function_signature: save_ai_listing',
       EXISTS (SELECT 1 FROM funcs f WHERE f.proname = 'save_ai_listing'
               AND f.args = 'p_store_id uuid, p_product_id uuid, p_translations jsonb, p_model text, p_tokens_in integer, p_tokens_out integer, p_cost bigint')
UNION ALL
SELECT 'function_signature: save_product_review',
       EXISTS (SELECT 1 FROM funcs f WHERE f.proname = 'save_product_review'
               AND f.args = 'p_store_id uuid, p_product_id uuid, p_price_paise bigint, p_translations jsonb, p_approved_langs text[], p_publish boolean')
UNION ALL
SELECT 'function_not_executable_by_public_anon_authenticated: ' || f.proname,
       NOT (has_function_privilege('anon', f.oid, 'EXECUTE') OR has_function_privilege('authenticated', f.oid, 'EXECUTE'))
       AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                       WHERE p.oid = f.oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
FROM funcs f
UNION ALL
SELECT 'function_executable_by_service_role: ' || f.proname, has_function_privilege('service_role', f.oid, 'EXECUTE')
FROM funcs f
UNION ALL
SELECT 'function_search_path_pinned: ' || f.proname,
       COALESCE(f.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=public, pg_temp']
FROM funcs f
UNION ALL
SELECT 'constraint_exists: ' || c.name,
       EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conname = c.name)
FROM (VALUES
  ('products_id_store_id_key'), ('products_status_check'), ('products_price_paise_check'),
  ('products_published_requires_price_check'), ('products_stock_check'), ('products_story_length_check'),
  ('products_image_path_length_check'), ('products_image_content_type_check'), ('products_ai_status_check'),
  ('product_translations_pkey'), ('product_translations_product_fkey'), ('product_translations_language_check'),
  ('product_translations_title_length_check'), ('product_translations_description_length_check'),
  ('product_translations_alt_text_length_check'), ('product_translations_source_check'),
  ('product_translations_approved_complete_check'),
  ('ai_drafts_kind_check'), ('ai_drafts_status_check'), ('ai_drafts_model_length_check'), ('ai_drafts_usage_check')
) AS c(name)
UNION ALL
SELECT 'foreign_key_cascades: ' || c.name,
       EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conname = c.name AND k.contype = 'f' AND k.confdeltype = 'c')
FROM (VALUES ('product_translations_product_fkey'), ('products_store_id_fkey'), ('ai_drafts_store_id_fkey')) AS c(name)
UNION ALL
SELECT 'index_exists: ' || i.name, to_regclass('public.' || i.name) IS NOT NULL
FROM (VALUES ('products_store_id_created_at_idx'), ('ai_drafts_store_id_created_at_idx')) AS i(name)
UNION ALL
SELECT 'products_index_orders_created_at_desc',
       EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'products_store_id_created_at_idx'
               AND indexdef LIKE '%(store_id, created_at DESC)%')
UNION ALL
SELECT 'products_image_path_not_null',
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products'
               AND column_name = 'image_path' AND is_nullable = 'NO')
ORDER BY 1;
