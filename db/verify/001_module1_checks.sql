-- Verification for migration 001. READ-ONLY: every statement is a SELECT. Run each block in the SQL editor.
-- Each block says what a healthy result looks like.
--
-- NOTE: rows for the older `godaddy_probe` table (Module 0 connectivity probe) may appear in blocks 1, 2 and 7.
-- They are expected and unrelated to Module 1. Judge only the owners, sessions and stores rows.

-- 1. RLS status. Expect rls_enabled = true for owners, sessions and stores.
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname IN ('owners', 'sessions', 'stores')
ORDER BY c.relname;

-- 2. Public tables with RLS DISABLED. Expect zero rows (a godaddy_probe row is expected and unrelated).
SELECT schemaname, tablename
FROM pg_tables
WHERE schemaname = 'public' AND NOT rowsecurity
ORDER BY tablename;

-- 3. Policies. Expect zero rows for owners, sessions and stores (no policies in this module).
SELECT schemaname, tablename, policyname
FROM pg_policies
WHERE schemaname = 'public' AND tablename IN ('owners', 'sessions', 'stores');

-- 4. Table privileges for anon and authenticated on the three tables. Expect zero rows.
SELECT c.relname AS table_name, r.rolname AS grantee, a.privilege_type
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(c.relacl) a
JOIN pg_roles r ON r.oid = a.grantee
WHERE n.nspname = 'public' AND c.relname IN ('owners', 'sessions', 'stores') AND r.rolname IN ('anon', 'authenticated')
ORDER BY c.relname, r.rolname, a.privilege_type;

-- 5. service_role privileges. Expect select, insert, update and delete all true for every table.
SELECT t.table_name,
       has_table_privilege('service_role', format('public.%I', t.table_name), 'SELECT') AS can_select,
       has_table_privilege('service_role', format('public.%I', t.table_name), 'INSERT') AS can_insert,
       has_table_privilege('service_role', format('public.%I', t.table_name), 'UPDATE') AS can_update,
       has_table_privilege('service_role', format('public.%I', t.table_name), 'DELETE') AS can_delete
FROM (VALUES ('owners'), ('sessions'), ('stores')) AS t (table_name);

-- 6. Required constraints. Expect these 10 names plus 2 foreign keys (sessions, stores); stores_slug_format_check and stores_slug_not_reserved must show
--    the exact regex and reserved list from the migration.
SELECT conrelid::regclass AS table_name, conname, contype, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid IN ('public.owners'::regclass, 'public.sessions'::regclass, 'public.stores'::regclass)
  AND conname IN (
    'owners_email_length_check', 'owners_email_lowercase_check',
    'sessions_token_hash_key',
    'stores_owner_id_key', 'stores_slug_key', 'stores_slug_format_check', 'stores_slug_not_reserved',
    'stores_default_language_check', 'stores_name_length_check', 'stores_story_length_check'
  )
   OR (contype = 'f' AND conrelid IN ('public.sessions'::regclass, 'public.stores'::regclass))
ORDER BY conrelid::regclass::text, conname;

-- 7. Required indexes. Expect owners_email_lower_key (unique, on lower(email)), sessions_expires_at_idx,
--    sessions_owner_id_idx, plus the unique indexes behind the constraints above.
SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename IN ('owners', 'sessions', 'stores')
ORDER BY tablename, indexname;

-- 8. Every grant held by anon or authenticated on ANY relation in the public schema. Expect zero rows for the Module 1
--    tables; rows for godaddy_probe (and any table you created earlier) are expected and unrelated.
SELECT n.nspname AS schema_name, c.relname AS relation, c.relkind, r.rolname AS grantee, a.privilege_type
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(c.relacl) a
JOIN pg_roles r ON r.oid = a.grantee
WHERE n.nspname = 'public' AND r.rolname IN ('anon', 'authenticated')
ORDER BY c.relname, r.rolname, a.privilege_type;

-- 9. Every EXECUTE grant held by anon or authenticated on functions in the public schema. Module 1 creates no
--    functions, so expect zero rows unless you created functions earlier.
SELECT n.nspname AS schema_name, p.proname AS function_name, r.rolname AS grantee, a.privilege_type
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN LATERAL aclexplode(p.proacl) a
JOIN pg_roles r ON r.oid = a.grantee
WHERE n.nspname = 'public' AND r.rolname IN ('anon', 'authenticated')
ORDER BY p.proname, r.rolname;
