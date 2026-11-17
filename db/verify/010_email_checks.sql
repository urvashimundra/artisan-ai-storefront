-- Read-only checks for migration 010 (email outbox, contact messages, order outbox hooks). Run in the Supabase SQL editor.
-- Every row must show ok = true. This supersedes the 009 checks that name the old place_order / submit_payment_reference signatures.
WITH fns(name, args) AS (
  VALUES ('email_enqueue', 'uuid, text, text, text, text, text, jsonb, text, text'), ('email_enqueue_order', 'uuid, text, text, text'),
         ('claim_due_emails', 'integer, integer'), ('finish_email', 'uuid, boolean, text, integer'),
         ('order_cancel_locked', 'uuid, text'), ('resolve_payment', 'uuid, uuid, uuid, text'),
         ('submit_payment_reference', 'uuid, text, text, text'),
         ('place_order', 'uuid, text, text, text, text, text, text, text, bigint, jsonb, text')
), f AS (
  SELECT fns.name, p.proconfig, p.prosrc, p.oid
  FROM fns LEFT JOIN pg_proc p ON p.oid = to_regprocedure('public.' || fns.name || '(' || fns.args || ')')
)
SELECT 'function_exists: ' || name AS check_name, oid IS NOT NULL AS ok FROM f
UNION ALL SELECT 'search_path pinned: ' || name, coalesce(proconfig::text LIKE '%search_path=public, pg_temp%', false) FROM f
UNION ALL SELECT 'service_role may execute: ' || name, has_function_privilege('service_role', oid, 'EXECUTE') FROM f WHERE oid IS NOT NULL
UNION ALL SELECT 'anon and authenticated may NOT execute: ' || name,
  NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')
  FROM f WHERE oid IS NOT NULL
UNION ALL SELECT 'PUBLIC may NOT execute: ' || name,
  NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE p.oid = f.oid AND a.grantee = 0)
  FROM f WHERE oid IS NOT NULL
UNION ALL SELECT 'old place_order signature is gone',
  to_regprocedure('public.place_order(uuid, text, text, text, text, text, text, text, bigint, jsonb)') IS NULL
UNION ALL SELECT 'old submit_payment_reference signature is gone',
  to_regprocedure('public.submit_payment_reference(uuid, text, text)') IS NULL
UNION ALL SELECT 'place_order queues order_placed', (SELECT prosrc LIKE '%email_enqueue_order(v_order_id, ''order_placed''%' FROM f WHERE name = 'place_order')
UNION ALL SELECT 'submit_payment_reference queues both emails',
  (SELECT prosrc LIKE '%''order_payment_received''%' AND prosrc LIKE '%''seller_payment_submitted''%' FROM f WHERE name = 'submit_payment_reference')
UNION ALL SELECT 'resolve_payment queues confirmed and not-found',
  (SELECT prosrc LIKE '%''order_confirmed''%' AND prosrc LIKE '%''order_payment_not_found''%' FROM f WHERE name = 'resolve_payment')
UNION ALL SELECT 'resolve_payment still uses the resubmit window', (SELECT prosrc LIKE '%order_resubmit_interval()%' FROM f WHERE name = 'resolve_payment')
UNION ALL SELECT 'order_cancel_locked queues cancelled and expired',
  (SELECT prosrc LIKE '%''order_expired''%' AND prosrc LIKE '%''order_cancelled''%' FROM f WHERE name = 'order_cancel_locked')
UNION ALL SELECT 'claim_due_emails uses SKIP LOCKED', (SELECT prosrc LIKE '%FOR UPDATE SKIP LOCKED%' FROM f WHERE name = 'claim_due_emails')
UNION ALL SELECT 'RLS enabled: ' || c.relname, c.relrowsecurity
  FROM pg_class c WHERE c.oid IN (to_regclass('public.email_outbox'), to_regclass('public.contact_messages'))
UNION ALL SELECT 'no policies on ' || t.tablename, NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t.tablename)
  FROM (VALUES ('email_outbox'), ('contact_messages')) AS t(tablename)
UNION ALL SELECT 'anon and authenticated have no table access: ' || t.tablename,
  NOT has_table_privilege('anon', 'public.' || t.tablename, 'SELECT') AND NOT has_table_privilege('authenticated', 'public.' || t.tablename, 'SELECT')
  FROM (VALUES ('email_outbox'), ('contact_messages')) AS t(tablename)
UNION ALL SELECT 'constraint exists: ' || n.name, EXISTS (SELECT 1 FROM pg_constraint WHERE conname = n.name)
  FROM (VALUES ('email_outbox_dedupe_key_key'), ('email_outbox_kind_check'), ('email_outbox_to_email_check'), ('email_outbox_reply_to_check'),
    ('email_outbox_language_check'), ('email_outbox_subject_check'), ('email_outbox_body_check'), ('email_outbox_dedupe_key_length_check'),
    ('email_outbox_status_check'), ('email_outbox_attempts_check'), ('email_outbox_error_code_check'),
    ('contact_messages_name_check'), ('contact_messages_email_check'), ('contact_messages_message_check')) AS n(name)
UNION ALL SELECT 'index exists: ' || n.name, to_regclass('public.' || n.name) IS NOT NULL
  FROM (VALUES ('email_outbox_status_next_attempt_idx'), ('email_outbox_recipient_created_idx'), ('email_outbox_created_at_idx'),
    ('contact_messages_email_created_idx')) AS n(name)
UNION ALL SELECT 'stores.notify_enquiry_email is boolean NOT NULL DEFAULT true',
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'stores' AND column_name = 'notify_enquiry_email'
          AND data_type = 'boolean' AND is_nullable = 'NO' AND column_default = 'true')
UNION ALL SELECT 'orders.language check restricts to en, gu, hi (from 008)', EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_language_check')
UNION ALL SELECT 'no sent or dead row keeps a body', NOT EXISTS (SELECT 1 FROM public.email_outbox WHERE status IN ('sent', 'dead') AND body <> '')
UNION ALL SELECT 'no sending row lacks a lease', NOT EXISTS (SELECT 1 FROM public.email_outbox WHERE status = 'sending' AND lease_until IS NULL)
ORDER BY 1;
