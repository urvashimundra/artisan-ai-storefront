-- Read-only checks for migration 016. Run in the Supabase SQL editor. Every row must show ok = true.
WITH f AS (
  SELECT p.proconfig, p.prosrc, p.prosecdef, p.oid
  FROM (SELECT to_regprocedure('public.save_product_translation_drafts(uuid, uuid, jsonb)') AS oid) x
  LEFT JOIN pg_proc p ON p.oid = x.oid
)
SELECT 'function exists' AS check_name, oid IS NOT NULL AS ok FROM f
UNION ALL SELECT 'SECURITY INVOKER (not definer)', NOT prosecdef FROM f WHERE oid IS NOT NULL
UNION ALL SELECT 'search_path pinned', coalesce(proconfig::text LIKE '%search_path=public, pg_temp%', false) FROM f WHERE oid IS NOT NULL
UNION ALL SELECT 'locks the product row first', prosrc LIKE '%FOR UPDATE%' FROM f WHERE oid IS NOT NULL
UNION ALL SELECT 'never writes alt_text on update', prosrc NOT LIKE '%alt_text = EXCLUDED%' FROM f WHERE oid IS NOT NULL
UNION ALL SELECT 'service_role may execute', has_function_privilege('service_role', oid, 'EXECUTE') FROM f WHERE oid IS NOT NULL
UNION ALL SELECT 'anon and authenticated may NOT execute',
  NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE') FROM f WHERE oid IS NOT NULL
UNION ALL SELECT 'PUBLIC may NOT execute',
  NOT EXISTS (SELECT 1 FROM pg_proc p2, aclexplode(coalesce(p2.proacl, acldefault('f', p2.proowner))) a WHERE p2.oid = f.oid AND a.grantee = 0)
  FROM f WHERE oid IS NOT NULL;
