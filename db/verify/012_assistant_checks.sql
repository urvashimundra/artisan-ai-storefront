-- Read-only checks for migration 012. Run in the Supabase SQL editor. Every row must show ok = true.
WITH defs AS (
  SELECT k.conrelid::regclass::text AS tbl, k.conname, pg_get_constraintdef(k.oid) AS def
  FROM pg_constraint k WHERE k.conrelid IN (to_regclass('public.store_knowledge'), to_regclass('public.enquiries'))
), cols AS (
  SELECT table_name, column_name, data_type, is_nullable, column_default
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('store_knowledge', 'enquiries')
), tbls(name) AS (VALUES ('store_knowledge'), ('enquiries'))
SELECT 'table_exists: ' || name AS check_name, to_regclass('public.' || name) IS NOT NULL AS ok FROM tbls
UNION ALL
SELECT 'column: ' || c.t || '.' || c.col,
       EXISTS (SELECT 1 FROM cols WHERE table_name = c.t AND column_name = c.col AND data_type = c.typ AND is_nullable = c.nullable)
FROM (VALUES
  ('store_knowledge', 'store_id', 'uuid', 'NO'), ('store_knowledge', 'content', 'text', 'NO'), ('store_knowledge', 'bulk_rules', 'jsonb', 'NO'),
  ('store_knowledge', 'updated_at', 'timestamp with time zone', 'NO'),
  ('enquiries', 'id', 'uuid', 'NO'), ('enquiries', 'store_id', 'uuid', 'NO'), ('enquiries', 'product_id', 'uuid', 'YES'),
  ('enquiries', 'language', 'text', 'NO'), ('enquiries', 'customer_name', 'text', 'NO'), ('enquiries', 'customer_phone', 'text', 'NO'),
  ('enquiries', 'question', 'text', 'NO'), ('enquiries', 'status', 'text', 'NO'), ('enquiries', 'answer_text', 'text', 'YES'),
  ('enquiries', 'flag_reason', 'text', 'YES'), ('enquiries', 'trace', 'jsonb', 'NO'), ('enquiries', 'seller_reply', 'text', 'YES'),
  ('enquiries', 'replied_at', 'timestamp with time zone', 'YES'), ('enquiries', 'token_hash', 'text', 'NO'), ('enquiries', 'token_enc', 'text', 'YES'),
  ('enquiries', 'claimed_at', 'timestamp with time zone', 'YES'), ('enquiries', 'created_at', 'timestamp with time zone', 'NO'),
  ('enquiries', 'updated_at', 'timestamp with time zone', 'NO')
) AS c(t, col, typ, nullable)
UNION ALL
SELECT 'default: store_knowledge.bulk_rules is []',
       EXISTS (SELECT 1 FROM cols WHERE table_name = 'store_knowledge' AND column_name = 'bulk_rules' AND column_default LIKE '''[]''::jsonb%')
UNION ALL
SELECT 'default: enquiries.trace is []',
       EXISTS (SELECT 1 FROM cols WHERE table_name = 'enquiries' AND column_name = 'trace' AND column_default LIKE '''[]''::jsonb%')
UNION ALL
SELECT 'default: enquiries.status is pending',
       EXISTS (SELECT 1 FROM cols WHERE table_name = 'enquiries' AND column_name = 'status' AND column_default LIKE '''pending''%')
UNION ALL
SELECT 'constraint_exists: ' || c.name, EXISTS (SELECT 1 FROM defs WHERE conname = c.name)
FROM (VALUES
  ('store_knowledge_pkey'), ('store_knowledge_store_fkey'), ('store_knowledge_content_length_check'), ('store_knowledge_bulk_rules_check'),
  ('enquiries_pkey'), ('enquiries_store_fkey'), ('enquiries_product_fkey'), ('enquiries_token_hash_key'), ('enquiries_language_check'),
  ('enquiries_customer_name_check'), ('enquiries_customer_phone_check'), ('enquiries_question_check'), ('enquiries_status_check'),
  ('enquiries_answer_text_check'), ('enquiries_answered_has_answer_check'), ('enquiries_flag_reason_check'), ('enquiries_trace_check'),
  ('enquiries_seller_reply_check'), ('enquiries_reply_pair_check'), ('enquiries_token_hash_format_check'), ('enquiries_token_enc_check')
) AS c(name)
UNION ALL
SELECT 'store_knowledge store_fkey cascades',
       EXISTS (SELECT 1 FROM defs WHERE conname = 'store_knowledge_store_fkey' AND position('ON DELETE CASCADE' IN def) > 0)
UNION ALL
SELECT 'enquiries store_fkey cascades',
       EXISTS (SELECT 1 FROM defs WHERE conname = 'enquiries_store_fkey' AND position('ON DELETE CASCADE' IN def) > 0)
UNION ALL
SELECT 'enquiries product_fkey is (product_id, store_id) to products',
       EXISTS (SELECT 1 FROM defs WHERE conname = 'enquiries_product_fkey' AND position('FOREIGN KEY (product_id, store_id)' IN def) > 0
               AND position('REFERENCES products(id, store_id)' IN def) > 0)
UNION ALL
SELECT 'content_max_20000',
       EXISTS (SELECT 1 FROM defs WHERE conname = 'store_knowledge_content_length_check' AND position('char_length(content) <= 20000' IN def) > 0)
UNION ALL
SELECT 'bulk_rules_max_5_array',
       EXISTS (SELECT 1 FROM defs WHERE conname = 'store_knowledge_bulk_rules_check' AND position('<= 5' IN def) > 0 AND position('array' IN def) > 0)
UNION ALL
SELECT 'question_1_to_500',
       EXISTS (SELECT 1 FROM defs WHERE conname = 'enquiries_question_check' AND position('char_length(question) >= 1' IN def) > 0
               AND position('char_length(question) <= 500' IN def) > 0)
UNION ALL
SELECT 'status_five_values',
       EXISTS (SELECT 1 FROM defs WHERE conname = 'enquiries_status_check' AND (length(def) - length(replace(def, '::text', ''))) / length('::text') = 5)
UNION ALL
SELECT 'flag_reason_six_values',
       EXISTS (SELECT 1 FROM defs WHERE conname = 'enquiries_flag_reason_check' AND (length(def) - length(replace(def, '::text', ''))) / length('::text') = 6)
UNION ALL
SELECT 'index_exists: ' || i.name, to_regclass('public.' || i.name) IS NOT NULL
FROM (VALUES ('enquiries_store_status_created_idx'), ('enquiries_store_phone_created_idx')) AS i(name)
UNION ALL
SELECT 'rls_enabled: ' || name, COALESCE((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.' || name)), false) FROM tbls
UNION ALL
SELECT 'no_policies: ' || name, NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = name) FROM tbls
UNION ALL
SELECT 'anon_and_authenticated_have_no_privileges: ' || name,
       NOT (has_table_privilege('anon', 'public.' || name, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         OR has_table_privilege('authenticated', 'public.' || name, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
FROM tbls
UNION ALL
SELECT 'service_role_has_crud: ' || name, has_table_privilege('service_role', 'public.' || name, 'SELECT,INSERT,UPDATE,DELETE') FROM tbls
UNION ALL
SELECT 'no_functions_added_by_012',
       NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = 'public' AND (p.proname LIKE '%enquir%' OR p.proname LIKE '%knowledge%'))
ORDER BY check_name;
