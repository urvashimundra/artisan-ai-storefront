-- Read-only checks for migration 005. Run in the Supabase SQL editor. Every row must show ok = true.
WITH funcs AS (
  SELECT p.oid, p.proname, p.proconfig, pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('save_ai_listing', 'save_product_review')
)
SELECT 'column_ai_generation_id_uuid_nullable' AS check_name,
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products'
               AND column_name = 'ai_generation_id' AND data_type = 'uuid' AND is_nullable = 'YES') AS ok
UNION ALL
SELECT 'products_rls_still_on', COALESCE((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.products')), false)
UNION ALL
SELECT 'no_policies_on_products', NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'products')
UNION ALL
SELECT 'exactly_two_functions_old_signatures_dropped', (SELECT count(*) FROM funcs) = 2
UNION ALL
SELECT 'function_signature: save_ai_listing',
       EXISTS (SELECT 1 FROM funcs f WHERE f.proname = 'save_ai_listing'
               AND f.args = 'p_store_id uuid, p_product_id uuid, p_generation_id uuid, p_translations jsonb, p_model text, p_tokens_in integer, p_tokens_out integer, p_cost bigint')
UNION ALL
SELECT 'function_signature: save_product_review',
       EXISTS (SELECT 1 FROM funcs f WHERE f.proname = 'save_product_review'
               AND f.args = 'p_store_id uuid, p_product_id uuid, p_story text, p_stock integer, p_price_paise bigint, p_translations jsonb, p_approved_langs text[], p_publish boolean')
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
SELECT 'products_constraints_from_004_intact: ' || c.name, EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conname = c.name)
FROM (VALUES ('products_status_check'), ('products_price_paise_check'), ('products_published_requires_price_check'),
             ('products_stock_check'), ('products_story_length_check'), ('products_ai_status_check')) AS c(name)
UNION ALL
SELECT 'review_null_generation_timestamp_treated_as_abandoned',
       position('v_ai_started IS NOT NULL AND v_ai_started > now() - interval ''180 seconds'''
         IN regexp_replace(pg_get_functiondef(f.oid), '\s+', ' ', 'g')) > 0
FROM funcs f
WHERE f.proname = 'save_product_review'
UNION ALL
SELECT 'review_default_approval_checked_for_resulting_published_status',
       position('IF v_will_be_published AND NOT (v_default = ANY (p_approved_langs))'
         IN regexp_replace(pg_get_functiondef(f.oid), '\s+', ' ', 'g')) > 0
FROM funcs f
WHERE f.proname = 'save_product_review'
ORDER BY 1;
