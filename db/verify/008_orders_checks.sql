-- Read-only checks for migration 008 (orders). Run in the Supabase SQL editor. Every row must show ok = true.
WITH tables(name) AS (
  VALUES ('store_order_counters'), ('orders'), ('order_items'), ('order_payment_attempts')
), cols(tbl, col, typ, nullable) AS (
  VALUES
    ('store_order_counters', 'store_id', 'uuid', 'NO'), ('store_order_counters', 'last_number', 'integer', 'NO'),
    ('orders', 'id', 'uuid', 'NO'), ('orders', 'store_id', 'uuid', 'NO'), ('orders', 'reference', 'text', 'NO'),
    ('orders', 'status', 'text', 'NO'), ('orders', 'cancel_reason', 'text', 'YES'), ('orders', 'status_token_hash', 'text', 'NO'),
    ('orders', 'payee_vpa', 'text', 'NO'), ('orders', 'total_paise', 'bigint', 'NO'), ('orders', 'customer_name', 'text', 'NO'),
    ('orders', 'customer_phone', 'text', 'NO'), ('orders', 'customer_email', 'text', 'YES'),
    ('orders', 'delivery_address', 'text', 'YES'), ('orders', 'language', 'text', 'NO'), ('orders', 'utr', 'text', 'YES'),
    ('orders', 'utr_submissions', 'smallint', 'NO'), ('orders', 'expires_at', 'timestamp with time zone', 'YES'),
    ('orders', 'stock_restored_at', 'timestamp with time zone', 'YES'), ('orders', 'paid_at', 'timestamp with time zone', 'YES'),
    ('orders', 'created_at', 'timestamp with time zone', 'NO'), ('orders', 'updated_at', 'timestamp with time zone', 'NO'),
    ('order_items', 'id', 'uuid', 'NO'), ('order_items', 'order_id', 'uuid', 'NO'), ('order_items', 'store_id', 'uuid', 'NO'),
    ('order_items', 'position', 'smallint', 'NO'), ('order_items', 'product_id', 'uuid', 'NO'), ('order_items', 'title', 'text', 'NO'),
    ('order_items', 'title_lang', 'text', 'NO'), ('order_items', 'unit_price_paise', 'bigint', 'NO'),
    ('order_items', 'quantity', 'integer', 'NO'), ('order_items', 'line_total_paise', 'bigint', 'NO'),
    ('order_items', 'stock_reserved', 'boolean', 'NO'),
    ('order_payment_attempts', 'id', 'uuid', 'NO'), ('order_payment_attempts', 'order_id', 'uuid', 'NO'),
    ('order_payment_attempts', 'store_id', 'uuid', 'NO'), ('order_payment_attempts', 'utr', 'text', 'NO'),
    ('order_payment_attempts', 'created_at', 'timestamp with time zone', 'NO')
), constraints(tbl, name) AS (
  VALUES
    ('store_order_counters', 'store_order_counters_last_number_check'),
    ('orders', 'orders_id_store_id_key'), ('orders', 'orders_store_reference_key'), ('orders', 'orders_status_token_hash_key'),
    ('orders', 'orders_reference_format_check'), ('orders', 'orders_status_check'), ('orders', 'orders_cancel_reason_check'),
    ('orders', 'orders_cancel_reason_matches_status_check'), ('orders', 'orders_token_hash_format_check'),
    ('orders', 'orders_payee_vpa_format_check'), ('orders', 'orders_total_paise_check'), ('orders', 'orders_customer_name_length_check'),
    ('orders', 'orders_customer_phone_format_check'), ('orders', 'orders_customer_email_check'),
    ('orders', 'orders_delivery_address_length_check'), ('orders', 'orders_language_check'), ('orders', 'orders_utr_format_check'),
    ('orders', 'orders_submitted_requires_utr_check'), ('orders', 'orders_utr_submissions_check'),
    ('orders', 'orders_expires_at_matches_status_check'), ('orders', 'orders_paid_at_matches_status_check'),
    ('orders', 'orders_stock_restored_only_when_cancelled_check'),
    ('order_items', 'order_items_order_fkey'), ('order_items', 'order_items_order_product_key'), ('order_items', 'order_items_title_length_check'),
    ('order_items', 'order_items_title_lang_check'), ('order_items', 'order_items_unit_price_check'),
    ('order_items', 'order_items_quantity_check'), ('order_items', 'order_items_line_total_check'),
    ('order_payment_attempts', 'order_payment_attempts_order_fkey'), ('order_payment_attempts', 'order_payment_attempts_store_utr_key'),
    ('order_payment_attempts', 'order_payment_attempts_utr_format_check')
), indexes(name) AS (
  VALUES ('orders_status_expires_at_idx'), ('orders_store_created_at_idx'), ('orders_store_status_idx'),
         ('order_items_product_id_idx'), ('order_payment_attempts_order_id_idx')
), fns(name) AS (
  VALUES ('place_order'), ('submit_payment_reference'), ('resolve_payment'), ('cancel_order'), ('expire_overdue_orders'),
         ('order_cancel_locked'), ('order_owner_matches'), ('order_parse_items'), ('order_expiry_interval')
), f AS (
  SELECT p.oid, p.proname, p.proconfig, p.proacl, p.proowner
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (SELECT name FROM fns)
)
SELECT 'table_exists: ' || t.name AS check_name, to_regclass('public.' || t.name) IS NOT NULL AS ok FROM tables t
UNION ALL
SELECT 'column: ' || c.tbl || '.' || c.col,
       EXISTS (SELECT 1 FROM information_schema.columns i WHERE i.table_schema = 'public' AND i.table_name = c.tbl
               AND i.column_name = c.col AND i.data_type = c.typ AND i.is_nullable = c.nullable)
FROM cols c
UNION ALL
SELECT 'constraint: ' || k.name,
       EXISTS (SELECT 1 FROM pg_constraint x WHERE x.conname = k.name AND x.conrelid = to_regclass('public.' || k.tbl))
FROM constraints k
UNION ALL
SELECT 'index: ' || i.name, EXISTS (SELECT 1 FROM pg_indexes x WHERE x.schemaname = 'public' AND x.indexname = i.name)
FROM indexes i
UNION ALL
SELECT 'index_status_expires_at_columns_in_order',
       EXISTS (SELECT 1 FROM pg_indexes x WHERE x.indexname = 'orders_status_expires_at_idx' AND x.indexdef LIKE '%(status, expires_at)%')
UNION ALL
SELECT 'utr_unique_per_store_definition',
       EXISTS (SELECT 1 FROM pg_constraint x WHERE x.conname = 'order_payment_attempts_store_utr_key' AND x.contype = 'u'
               AND pg_get_constraintdef(x.oid) = 'UNIQUE (store_id, utr)')
UNION ALL
SELECT 'status_values_exact',
       EXISTS (SELECT 1 FROM pg_constraint x WHERE x.conname = 'orders_status_check'
               AND pg_get_constraintdef(x.oid) LIKE '%awaiting_payment%' AND pg_get_constraintdef(x.oid) LIKE '%payment_submitted%'
               AND pg_get_constraintdef(x.oid) LIKE '%''paid''%' AND pg_get_constraintdef(x.oid) LIKE '%not_received%'
               AND pg_get_constraintdef(x.oid) LIKE '%cancelled%')
UNION ALL
SELECT 'rls_enabled: ' || t.name, COALESCE((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.' || t.name)), false)
FROM tables t
UNION ALL
SELECT 'no_policies: ' || t.name, NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t.name)
FROM tables t
UNION ALL
SELECT 'no_anon_or_authenticated_privileges: ' || t.name,
       NOT (has_table_privilege('anon', 'public.' || t.name, 'SELECT,INSERT,UPDATE,DELETE')
         OR has_table_privilege('authenticated', 'public.' || t.name, 'SELECT,INSERT,UPDATE,DELETE'))
FROM tables t
UNION ALL
SELECT 'service_role_has_all_privileges: ' || t.name,
       has_table_privilege('service_role', 'public.' || t.name, 'SELECT') AND has_table_privilege('service_role', 'public.' || t.name, 'INSERT')
       AND has_table_privilege('service_role', 'public.' || t.name, 'UPDATE') AND has_table_privilege('service_role', 'public.' || t.name, 'DELETE')
FROM tables t
UNION ALL
SELECT 'function_exists: ' || n.name, EXISTS (SELECT 1 FROM f WHERE f.proname = n.name) FROM fns n
UNION ALL
SELECT 'function_search_path_pinned: ' || f.proname, COALESCE(f.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=public, pg_temp'] FROM f
UNION ALL
SELECT 'function_not_executable_by_anon_or_authenticated: ' || f.proname,
       NOT (has_function_privilege('anon', f.oid, 'EXECUTE') OR has_function_privilege('authenticated', f.oid, 'EXECUTE'))
FROM f
UNION ALL
SELECT 'function_not_executable_by_public: ' || f.proname,
       NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(f.proacl, acldefault('f', f.proowner))) a WHERE a.grantee = 0)
FROM f
UNION ALL
SELECT 'function_executable_by_service_role: ' || f.proname, has_function_privilege('service_role', f.oid, 'EXECUTE') FROM f
UNION ALL
SELECT 'only_one_place_order_overload', (SELECT count(*) FROM f WHERE f.proname = 'place_order') = 1
UNION ALL
SELECT 'expiry_window_is_one_hour', public.order_expiry_interval() = interval '1 hour'
ORDER BY 1;
