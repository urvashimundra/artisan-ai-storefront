-- Read-only checks for migration 011. Run in the Supabase SQL editor. Every row must show ok = true.
-- Supersedes the 010 checks that name the 4-argument submit_payment_reference / email_enqueue_order. Also confirms that the security
-- model of 008 and 009 is intact: SECURITY INVOKER, pinned search_path, EXECUTE for service_role only, same owner as the 008 functions.
WITH fns(name, args) AS (
  VALUES ('email_serialize', ''), ('email_enqueue', 'uuid, text, text, text, text, text, jsonb, text, text'),
         ('email_enqueue_order', 'uuid, text, text'), ('claim_due_emails', 'integer, integer'), ('finish_email', 'uuid, boolean, text, integer'),
         ('order_cancel_locked', 'uuid, text'), ('expire_overdue_orders', 'uuid, uuid[]'),
         ('place_order', 'uuid, text, text, text, text, text, text, text, bigint, jsonb, text'),
         ('submit_payment_reference', 'uuid, text, text'), ('resolve_payment', 'uuid, uuid, uuid, text'),
         ('cancel_order', 'uuid, uuid, text, uuid, text')
), f AS (
  SELECT fns.name, p.proconfig, p.prosrc, p.prosecdef, p.proowner, p.proacl, p.oid
  FROM fns LEFT JOIN pg_proc p ON p.oid = to_regprocedure('public.' || fns.name || '(' || fns.args || ')')
)
SELECT 'function_exists: ' || name AS check_name, oid IS NOT NULL AS ok FROM f
UNION ALL SELECT 'SECURITY INVOKER (not definer): ' || name, NOT prosecdef FROM f WHERE oid IS NOT NULL
UNION ALL SELECT 'search_path pinned: ' || name, coalesce(proconfig::text LIKE '%search_path=public, pg_temp%', false) FROM f
UNION ALL SELECT 'service_role may execute: ' || name, has_function_privilege('service_role', oid, 'EXECUTE') FROM f WHERE oid IS NOT NULL
UNION ALL SELECT 'anon and authenticated may NOT execute: ' || name,
  NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')
  FROM f WHERE oid IS NOT NULL
UNION ALL SELECT 'PUBLIC may NOT execute: ' || name,
  NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a WHERE a.grantee = 0)
  FROM f WHERE oid IS NOT NULL
UNION ALL SELECT 'only service_role and the owner hold EXECUTE: ' || name,
  NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a
               WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> f.proowner
                 AND a.grantee NOT IN (SELECT r.oid FROM pg_roles r WHERE r.rolname = 'service_role'))
  FROM f WHERE oid IS NOT NULL
UNION ALL SELECT 'same owner as the 008 helper order_owner_matches: ' || name,
  f.proowner = (SELECT proowner FROM pg_proc WHERE oid = to_regprocedure('public.order_owner_matches(uuid, uuid)'))
  FROM f WHERE oid IS NOT NULL
UNION ALL SELECT 'old 4-argument submit_payment_reference is gone', to_regprocedure('public.submit_payment_reference(uuid, text, text, text)') IS NULL
UNION ALL SELECT 'old 4-argument email_enqueue_order is gone', to_regprocedure('public.email_enqueue_order(uuid, text, text, text)') IS NULL
UNION ALL SELECT 'email_enqueue takes the lock', (SELECT prosrc LIKE '%email_serialize()%' FROM f WHERE name = 'email_enqueue')
UNION ALL SELECT 'takes the lock first: ' || name, prosrc ~ 'email_serialize\(\)'
  FROM f WHERE name IN ('place_order', 'submit_payment_reference', 'resolve_payment', 'cancel_order', 'expire_overdue_orders')
UNION ALL SELECT 'resolve_payment still uses the resubmit window', (SELECT prosrc LIKE '%order_resubmit_interval()%' FROM f WHERE name = 'resolve_payment')
UNION ALL SELECT 'orders.status_token_enc exists and is nullable',
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'status_token_enc' AND is_nullable = 'YES')
UNION ALL SELECT 'orders_status_token_enc_check exists', EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_status_token_enc_check')
UNION ALL SELECT 'no order stores the hash or a bare token in status_token_enc',
  NOT EXISTS (SELECT 1 FROM public.orders WHERE status_token_enc = status_token_hash OR char_length(status_token_enc) = 43)
UNION ALL SELECT 'no sent or dead row keeps a payload', NOT EXISTS (SELECT 1 FROM public.email_outbox WHERE status IN ('sent', 'dead') AND payload <> '{}'::jsonb)
ORDER BY 1;
