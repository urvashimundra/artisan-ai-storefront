-- Read-only checks for migration 015. Run in the Supabase SQL editor. Every row must show ok = true.
SELECT 'cancel reason check accepts utr_attempts_exhausted' AS check_name,
       EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_cancel_reason_check' AND pg_get_constraintdef(oid) LIKE '%utr_attempts_exhausted%') AS ok
UNION ALL SELECT 'resolve_payment cancels through order_cancel_locked',
       (SELECT prosrc LIKE '%utr_attempts_exhausted%' AND prosrc LIKE '%order_cancel_locked%' AND prosrc LIKE '%email_serialize()%' FROM pg_proc WHERE oid = to_regprocedure('public.resolve_payment(uuid, uuid, uuid, text)'))
UNION ALL SELECT 'email_enqueue_order puts cancel_reason in the payload',
       (SELECT prosrc LIKE '%cancel_reason%' FROM pg_proc WHERE oid = to_regprocedure('public.email_enqueue_order(uuid, text, text)'))
UNION ALL SELECT 'email_enqueue exempts order_cancelled from the hourly limit',
       (SELECT prosrc LIKE '%p_kind <> ''order_cancelled''%' AND prosrc LIKE '%email_serialize()%' FROM pg_proc WHERE oid = to_regprocedure('public.email_enqueue(uuid, text, text, text, text, text, jsonb, text, text)'))
UNION ALL SELECT 'service_role only: resolve_payment',
       has_function_privilege('service_role', 'public.resolve_payment(uuid, uuid, uuid, text)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.resolve_payment(uuid, uuid, uuid, text)', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.resolve_payment(uuid, uuid, uuid, text)', 'EXECUTE')
UNION ALL SELECT 'service_role only: email_enqueue_order',
       has_function_privilege('service_role', 'public.email_enqueue_order(uuid, text, text)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.email_enqueue_order(uuid, text, text)', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.email_enqueue_order(uuid, text, text)', 'EXECUTE');
