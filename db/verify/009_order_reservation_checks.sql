-- Read-only checks for migration 009. Run in the Supabase SQL editor. Every row must show ok = true.
WITH fns(name, args) AS (
  VALUES ('order_expiry_interval', ''), ('order_resubmit_interval', ''), ('resolve_payment', 'uuid, uuid, uuid, text'),
         ('submit_payment_reference', 'uuid, text, text'), ('expire_overdue_orders', 'uuid, uuid[]'),
         ('place_order', 'uuid, text, text, text, text, text, text, text, bigint, jsonb')
), f AS (
  SELECT fns.name, p.proconfig, p.prosrc, p.oid
  FROM fns LEFT JOIN pg_proc p ON p.oid = to_regprocedure('public.' || fns.name || '(' || fns.args || ')')
)
SELECT 'function_exists: ' || name AS check_name, oid IS NOT NULL AS ok FROM f
UNION ALL SELECT 'awaiting_payment window is 10 minutes', public.order_expiry_interval() = interval '10 minutes'
UNION ALL SELECT 'not_received window is 1 hour', public.order_resubmit_interval() = interval '1 hour'
UNION ALL SELECT 'resolve_payment uses the resubmit window',
  (SELECT prosrc LIKE '%order_resubmit_interval()%' FROM f WHERE name = 'resolve_payment')
UNION ALL SELECT 'place_order uses the 10 minute window',
  (SELECT prosrc LIKE '%order_expiry_interval()%' FROM f WHERE name = 'place_order')
UNION ALL SELECT 'submit_payment_reference rejects overdue orders by database time',
  (SELECT prosrc LIKE '%expires_at <= now()%' FROM f WHERE name = 'submit_payment_reference')
UNION ALL SELECT 'search_path pinned: ' || name, coalesce(proconfig::text LIKE '%search_path=public, pg_temp%', false) FROM f
UNION ALL SELECT 'service_role may execute: ' || name, has_function_privilege('service_role', oid, 'EXECUTE') FROM f WHERE oid IS NOT NULL
UNION ALL SELECT 'anon and authenticated may NOT execute: ' || name,
  NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')
  FROM f WHERE oid IS NOT NULL
UNION ALL SELECT 'RLS enabled: ' || c.relname, c.relrowsecurity
  FROM pg_class c
 WHERE c.oid IN (to_regclass('public.orders'), to_regclass('public.order_items'), to_regclass('public.order_payment_attempts'), to_regclass('public.store_order_counters'))
UNION ALL SELECT 'no awaiting_payment order has a deadline later than created_at + 10 minutes',
  NOT EXISTS (SELECT 1 FROM public.orders WHERE status = 'awaiting_payment' AND expires_at > created_at + interval '10 minutes')
UNION ALL SELECT 'stock restore marker matches cancelled status on every order',
  NOT EXISTS (SELECT 1 FROM public.orders WHERE (status = 'cancelled') <> (stock_restored_at IS NOT NULL))
UNION ALL SELECT 'no finite stock is negative', NOT EXISTS (SELECT 1 FROM public.products WHERE stock < 0)
ORDER BY 1;
