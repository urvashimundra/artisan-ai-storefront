-- Read-only checks for migration 013. Run in the Supabase SQL editor (staging first). Every row must show ok = true.
WITH tbls(name) AS (VALUES ('conversations'), ('conversation_messages'), ('conversation_usage')),
fns(name, args) AS (VALUES
  ('conversation_india_day', ''), ('conversation_take_customer_slot', 'uuid, text'), ('conversation_reserve_ai', 'uuid'),
  ('conversation_settle_ai', 'uuid, date, boolean'), ('conversation_begin_run', 'uuid, uuid, text'),
  ('conversation_start', 'uuid, uuid, text, text, text, text, text, uuid, uuid, text, text'),
  ('conversation_post_message', 'uuid, uuid, uuid, text, text'),
  ('conversation_finish_run', 'uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, jsonb'),
  ('conversation_seller_reply', 'uuid, uuid, uuid, text'), ('conversation_delete', 'uuid, uuid'), ('conversation_purge_expired', 'integer, boolean')),
cons AS (
  SELECT conname FROM pg_constraint WHERE conrelid IN (to_regclass('public.conversations'), to_regclass('public.conversation_messages'), to_regclass('public.conversation_usage'))
)
SELECT 'table_exists: ' || name AS check_name, to_regclass('public.' || name) IS NOT NULL AS ok FROM tbls
UNION ALL
SELECT 'constraint_exists: ' || c.name, EXISTS (SELECT 1 FROM cons WHERE conname = c.name)
FROM (VALUES
  ('conversations_pkey'), ('conversations_id_store_key'), ('conversations_store_fkey'), ('conversations_product_fkey'), ('conversations_token_hash_key'),
  ('conversations_start_key_key'), ('conversations_legacy_enquiry_key'), ('conversations_language_check'), ('conversations_customer_name_check'),
  ('conversations_customer_phone_check'), ('conversations_status_check'), ('conversations_flag_reason_check'), ('conversations_token_hash_format_check'),
  ('conversations_token_enc_check'), ('conversations_message_count_check'), ('conversations_last_role_check'), ('conversations_preview_check'),
  ('conversations_escalation_count_check'), ('conversations_ai_run_check'),
  ('conversation_messages_pkey'), ('conversation_messages_conversation_fkey'), ('conversation_messages_seq_key'), ('conversation_messages_seq_check'),
  ('conversation_messages_role_check'), ('conversation_messages_kind_check'), ('conversation_messages_body_check'),
  ('conversation_messages_customer_body_check'), ('conversation_messages_seller_body_check'), ('conversation_messages_kind_role_check'),
  ('conversation_messages_flag_reason_check'), ('conversation_messages_sources_check'), ('conversation_messages_conflict_check'),
  ('conversation_messages_trace_check'),
  ('conversation_usage_pkey'), ('conversation_usage_store_fkey'), ('conversation_usage_scope_check'), ('conversation_usage_counts_check')
) AS c(name)
UNION ALL
SELECT 'index_exists: ' || i.name, to_regclass('public.' || i.name) IS NOT NULL
FROM (VALUES ('conversations_store_activity_idx'), ('conversations_store_status_activity_idx'), ('conversations_activity_idx'),
  ('conversation_messages_conversation_seq_idx'), ('conversation_messages_client_msg_key')) AS i(name)
UNION ALL
SELECT 'rls_enabled: ' || name, COALESCE((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.' || name)), false) FROM tbls
UNION ALL
SELECT 'no_policies: ' || name, NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = name) FROM tbls
UNION ALL
SELECT 'browser_roles_have_no_table_privileges: ' || name,
       NOT (has_table_privilege('anon', 'public.' || name, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         OR has_table_privilege('authenticated', 'public.' || name, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
FROM tbls
UNION ALL
SELECT 'service_role_has_crud: ' || name, has_table_privilege('service_role', 'public.' || name, 'SELECT,INSERT,UPDATE,DELETE') FROM tbls
UNION ALL
SELECT 'function_exists: ' || name, to_regprocedure('public.' || name || '(' || args || ')') IS NOT NULL FROM fns
UNION ALL
SELECT 'function_pinned_search_path_and_invoker: ' || name,
       COALESCE((SELECT NOT p.prosecdef AND p.proconfig::text LIKE '%search_path=public, pg_temp%'
                 FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || name || '(' || args || ')')), false)
FROM fns
UNION ALL
SELECT 'function_execute_service_role_only: ' || name,
       COALESCE(has_function_privilege('service_role', to_regprocedure('public.' || name || '(' || args || ')'), 'EXECUTE')
         AND NOT has_function_privilege('anon', to_regprocedure('public.' || name || '(' || args || ')'), 'EXECUTE')
         AND NOT has_function_privilege('authenticated', to_regprocedure('public.' || name || '(' || args || ')'), 'EXECUTE')
         AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                         WHERE p.oid = to_regprocedure('public.' || name || '(' || args || ')') AND a.grantee = 0), false)
FROM fns
UNION ALL
SELECT 'legacy_tables_untouched: enquiries', to_regclass('public.enquiries') IS NOT NULL
UNION ALL
SELECT 'legacy_tables_untouched: store_knowledge', to_regclass('public.store_knowledge') IS NOT NULL
ORDER BY check_name;
