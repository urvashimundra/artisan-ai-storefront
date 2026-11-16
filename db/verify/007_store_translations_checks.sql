-- Read-only checks for migration 007. Run in the Supabase SQL editor. Every row must show ok = true.
WITH cols AS (
  SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'store_translations'
), defs AS (
  SELECT k.conname, pg_get_constraintdef(k.oid) AS def
  FROM pg_constraint k WHERE k.conrelid = to_regclass('public.store_translations')
)
SELECT 'table_exists' AS check_name, to_regclass('public.store_translations') IS NOT NULL AS ok
UNION ALL
SELECT 'column_store_id_uuid_not_null',
       EXISTS (SELECT 1 FROM cols WHERE column_name = 'store_id' AND data_type = 'uuid' AND is_nullable = 'NO')
UNION ALL
SELECT 'column_language_text_not_null',
       EXISTS (SELECT 1 FROM cols WHERE column_name = 'language' AND data_type = 'text' AND is_nullable = 'NO')
UNION ALL
SELECT 'column_tagline_text_not_null_default_empty',
       EXISTS (SELECT 1 FROM cols WHERE column_name = 'tagline' AND data_type = 'text' AND is_nullable = 'NO'
               AND column_default LIKE '''''::text%')
UNION ALL
SELECT 'column_story_text_not_null_default_empty',
       EXISTS (SELECT 1 FROM cols WHERE column_name = 'story' AND data_type = 'text' AND is_nullable = 'NO'
               AND column_default LIKE '''''::text%')
UNION ALL
SELECT 'column_source_text_not_null',
       EXISTS (SELECT 1 FROM cols WHERE column_name = 'source' AND data_type = 'text' AND is_nullable = 'NO')
UNION ALL
SELECT 'column_approved_boolean_not_null_default_false',
       EXISTS (SELECT 1 FROM cols WHERE column_name = 'approved' AND data_type = 'boolean' AND is_nullable = 'NO'
               AND column_default = 'false')
UNION ALL
SELECT 'column_updated_at_timestamptz_not_null_default_now',
       EXISTS (SELECT 1 FROM cols WHERE column_name = 'updated_at' AND data_type = 'timestamp with time zone'
               AND is_nullable = 'NO' AND column_default = 'now()')
UNION ALL
SELECT 'constraint_exists: ' || c.name, EXISTS (SELECT 1 FROM defs WHERE conname = c.name)
FROM (VALUES ('store_translations_pkey'), ('store_translations_store_fkey'), ('store_translations_language_check'),
             ('store_translations_tagline_length_check'), ('store_translations_story_length_check'),
             ('store_translations_source_check')) AS c(name)
UNION ALL
SELECT 'primary_key_is_store_id_language',
       EXISTS (SELECT 1 FROM defs WHERE conname = 'store_translations_pkey' AND def = 'PRIMARY KEY (store_id, language)')
UNION ALL
SELECT 'foreign_key_references_stores_on_delete_cascade',
       EXISTS (SELECT 1 FROM defs WHERE conname = 'store_translations_store_fkey'
               AND position('REFERENCES stores(id)' IN def) > 0 AND position('ON DELETE CASCADE' IN def) > 0)
UNION ALL
SELECT 'constraint_definition_language_en_gu_hi',
       EXISTS (SELECT 1 FROM defs WHERE conname = 'store_translations_language_check'
               AND position('''en''::text' IN def) > 0 AND position('''gu''::text' IN def) > 0
               AND position('''hi''::text' IN def) > 0
               AND (length(def) - length(replace(def, '::text', ''))) / length('::text') = 3)
UNION ALL
SELECT 'constraint_definition_tagline_max_120',
       EXISTS (SELECT 1 FROM defs WHERE conname = 'store_translations_tagline_length_check'
               AND position('char_length(tagline) <= 120' IN def) > 0)
UNION ALL
SELECT 'constraint_definition_story_max_2000',
       EXISTS (SELECT 1 FROM defs WHERE conname = 'store_translations_story_length_check'
               AND position('char_length(story) <= 2000' IN def) > 0)
UNION ALL
SELECT 'constraint_definition_source_owner_or_ai',
       EXISTS (SELECT 1 FROM defs WHERE conname = 'store_translations_source_check'
               AND position('''owner''::text' IN def) > 0 AND position('''ai''::text' IN def) > 0
               AND (length(def) - length(replace(def, '::text', ''))) / length('::text') = 2)
UNION ALL
SELECT 'rls_enabled',
       COALESCE((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.store_translations')), false)
UNION ALL
SELECT 'no_policies',
       NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'store_translations')
UNION ALL
SELECT 'anon_and_authenticated_have_no_privileges',
       NOT (has_table_privilege('anon', 'public.store_translations', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         OR has_table_privilege('authenticated', 'public.store_translations', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
UNION ALL
SELECT 'service_role_has_crud',
       has_table_privilege('service_role', 'public.store_translations', 'SELECT,INSERT,UPDATE,DELETE')
UNION ALL
SELECT 'no_functions_added_for_this_table',
       NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = 'public' AND p.proname LIKE '%store_translation%')
ORDER BY check_name;
