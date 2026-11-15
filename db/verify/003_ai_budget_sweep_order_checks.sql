-- Read-only checks for migration 003. Run in the Supabase SQL editor. Every row must show ok = true.
WITH f AS (
  SELECT p.oid, p.proconfig, pg_get_functiondef(p.oid) AS def
  FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.reserve_ai_budget(uuid, bigint, bigint, bigint, integer)')
)
SELECT 'function_exists_with_expected_signature' AS check_name,
       EXISTS (SELECT 1 FROM f) AS ok
UNION ALL
SELECT 'returns_jsonb',
       COALESCE((SELECT p.prorettype = 'jsonb'::regtype FROM pg_proc p JOIN f ON f.oid = p.oid), false)
UNION ALL
SELECT 'sweep_orders_by_usage_date_desc_then_id',
       COALESCE(
         (SELECT def ~ 'ORDER BY usage_date[[:space:]]+DESC,[[:space:]]*id'
          FROM f),
         false
       )
UNION ALL
SELECT 'old_ascending_sweep_order_absent',
       COALESCE(
         (SELECT def !~ 'ORDER BY usage_date,[[:space:]]*id'
          FROM f),
         false
       )
UNION ALL
SELECT 'global_row_locked_before_owner_row_insert',
       COALESCE((SELECT def ~ '(?s)INSERT INTO public\.ai_usage_global_daily.*?FROM public\.ai_usage_global_daily\s+WHERE usage_date = v_today FOR UPDATE.*?INSERT INTO public\.ai_usage_daily' FROM f), false)
UNION ALL
SELECT 'search_path_pinned',
       COALESCE((SELECT COALESCE(proconfig, ARRAY[]::text[]) @> ARRAY['search_path=public, pg_temp'] FROM f), false)
UNION ALL
SELECT 'not_executable_by_public',
       COALESCE((SELECT NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                                    WHERE p.oid = f.oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') FROM f), false)
UNION ALL
SELECT 'not_executable_by_anon',
       COALESCE((SELECT NOT has_function_privilege('anon', f.oid, 'EXECUTE') FROM f), false)
UNION ALL
SELECT 'not_executable_by_authenticated',
       COALESCE((SELECT NOT has_function_privilege('authenticated', f.oid, 'EXECUTE') FROM f), false)
UNION ALL
SELECT 'executable_by_service_role',
       COALESCE((SELECT has_function_privilege('service_role', f.oid, 'EXECUTE') FROM f), false)
ORDER BY 1;
