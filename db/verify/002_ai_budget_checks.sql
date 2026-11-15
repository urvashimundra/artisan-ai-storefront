-- Read-only checks for migration 002. Run in the Supabase SQL editor. Every row must show ok = true.
WITH tables AS (
  SELECT unnest(ARRAY['ai_usage_daily', 'ai_usage_global_daily', 'ai_reservations']) AS name
), funcs AS (
  SELECT p.oid, p.proname, p.proconfig
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('reserve_ai_budget', 'settle_ai_budget', 'release_ai_budget')
)
SELECT 'table_exists_rls_on: ' || t.name AS check_name,
       COALESCE((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.' || t.name)), false) AS ok
FROM tables t
UNION ALL
SELECT 'no_anon_or_authenticated_table_privileges: ' || t.name,
       NOT (has_table_privilege('anon', 'public.' || t.name, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         OR has_table_privilege('authenticated', 'public.' || t.name, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
FROM tables t
UNION ALL
SELECT 'service_role_table_privileges: ' || t.name,
       has_table_privilege('service_role', 'public.' || t.name, 'SELECT,INSERT,UPDATE,DELETE')
FROM tables t
UNION ALL
SELECT 'three_functions_exist', (SELECT count(*) FROM funcs) = 3
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
FROM (VALUES ('ai_usage_daily_amounts_check'), ('ai_usage_global_daily_amounts_check'),
             ('ai_reservations_amount_check'), ('ai_reservations_status_check')) AS c(name)
UNION ALL
SELECT 'index_exists: ai_reservations_status_expires_idx',
       to_regclass('public.ai_reservations_status_expires_idx') IS NOT NULL
ORDER BY 1;
