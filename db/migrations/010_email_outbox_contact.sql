-- Migration 010: email outbox, contact messages, enquiry-alert setting, and outbox hooks inside the order functions (Module 5).
-- Apply in the Supabase SQL editor AFTER migration 009. Idempotent: safe to run more than once. Forward-only: 008 and 009 are NOT edited.
-- STATUS: written, NOT applied. The developer applies it, then runs db/verify/010_email_checks.sql and db/test/010_email_smoke.sql.
--
-- Design
--   * Every email is a row in email_outbox. A worker in the app claims due rows (claim_due_emails), sends them through the hosting
--     mail relay and reports back (finish_email). The relay being down never affects orders or enquiries.
--   * Order emails are queued by the SAME Postgres function that changes the order, in the SAME transaction: if the status change
--     fails nothing is queued, and if queuing fails the whole change rolls back. Sending happens later and never inside a transaction.
--   * Order rows are queued with an empty subject and body plus a small jsonb payload (reference, shop name, slug, optional private
--     link). The worker renders the text in the customer's language at send time. Rows queued by the app itself (contact form,
--     seller enquiry alerts) are rendered by the app and carry subject and body. After a send (or death) body and payload are
--     blanked, so a private order link does not stay in the table.
--   * Abuse limits are counted from this table (email_enqueue), so they survive restarts. A limited email is simply not queued.
-- Limits and names are mirrored in src/domain/emailRules.js and src/domain/dbConstraints.js (a unit test compares them).
-- orders.language already exists (migration 008), so it is not added here.
-- Changed signatures: place_order and submit_payment_reference gain a trailing p_status_link text DEFAULT NULL (the private order
-- link, known only to the app). The old signatures are dropped; calls that omit the new argument (the 008 and 009 tests) still work.
-- db/verify/009 checks that name the old signatures are superseded by db/verify/010.

-- email_outbox ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.email_outbox (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        uuid        REFERENCES public.stores (id) ON DELETE CASCADE,
  kind            text        NOT NULL,
  to_email        text        NOT NULL,
  language        text        NOT NULL DEFAULT 'en',
  subject         text        NOT NULL DEFAULT '',
  body            text        NOT NULL DEFAULT '',
  payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  reply_to        text,
  dedupe_key      text        NOT NULL,
  status          text        NOT NULL DEFAULT 'queued',
  attempts        integer     NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until     timestamptz,
  last_error_code text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  CONSTRAINT email_outbox_dedupe_key_key UNIQUE (dedupe_key),
  CONSTRAINT email_outbox_kind_check CHECK (kind IN ('order_placed', 'order_payment_received', 'order_confirmed', 'order_payment_not_found',
    'order_cancelled', 'order_expired', 'seller_payment_submitted', 'seller_enquiry_needs_you', 'contact_inbox')),
  CONSTRAINT email_outbox_to_email_check CHECK (char_length(to_email) <= 254 AND to_email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  CONSTRAINT email_outbox_reply_to_check CHECK (reply_to IS NULL OR (char_length(reply_to) <= 254 AND reply_to ~ '^[^@[:space:]]+@[^@[:space:]]+$')),
  CONSTRAINT email_outbox_language_check CHECK (language IN ('en', 'gu', 'hi')),
  CONSTRAINT email_outbox_subject_check CHECK (char_length(subject) <= 200 AND subject !~ '[\r\n]'),
  CONSTRAINT email_outbox_body_check CHECK (char_length(body) <= 4000),
  CONSTRAINT email_outbox_dedupe_key_length_check CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
  CONSTRAINT email_outbox_status_check CHECK (status IN ('queued', 'sending', 'sent', 'dead')),
  CONSTRAINT email_outbox_attempts_check CHECK (attempts BETWEEN 0 AND 5),
  CONSTRAINT email_outbox_error_code_check CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{1,40}$')
);

CREATE INDEX IF NOT EXISTS email_outbox_status_next_attempt_idx ON public.email_outbox (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS email_outbox_recipient_created_idx ON public.email_outbox (lower(to_email), created_at);
CREATE INDEX IF NOT EXISTS email_outbox_created_at_idx ON public.email_outbox (created_at);

-- contact_messages -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.contact_messages (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL,
  email      text        NOT NULL,
  message    text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_messages_name_check CHECK (char_length(name) BETWEEN 1 AND 80),
  CONSTRAINT contact_messages_email_check CHECK (char_length(email) <= 254 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  CONSTRAINT contact_messages_message_check CHECK (char_length(message) BETWEEN 1 AND 2000)
);

CREATE INDEX IF NOT EXISTS contact_messages_email_created_idx ON public.contact_messages (lower(email), created_at);

-- stores.notify_enquiry_email ------------------------------------------------------------------
ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS notify_enquiry_email boolean NOT NULL DEFAULT true;

-- Row level security and privileges ------------------------------------------------------------
ALTER TABLE public.email_outbox     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_messages ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.email_outbox, public.contact_messages FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.email_outbox, public.contact_messages TO service_role;

-- email_enqueue --------------------------------------------------------------------------------
-- The ONLY way a row enters the outbox. Returns 'queued', 'duplicate' (the dedupe key exists: a no-op), 'limited_global' or
-- 'limited_recipient' (nothing queued). Never raises for a limit. A bad row (a CHECK fails) raises, which rolls back the caller.
-- Customer-facing kinds: 6 per recipient per rolling hour and 20 per rolling day. Seller alerts: 30 per recipient per hour.
-- contact_inbox goes to our own inbox, so only the global cap applies to it. Global cap: 150 rows per rolling hour.
CREATE OR REPLACE FUNCTION public.email_enqueue(
  p_store_id uuid, p_kind text, p_to_email text, p_language text, p_subject text, p_body text,
  p_payload jsonb, p_reply_to text, p_dedupe_key text
) RETURNS text
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  c_customer_per_hour CONSTANT integer := 6;
  c_customer_per_day  CONSTANT integer := 20;
  c_seller_per_hour   CONSTANT integer := 30;
  c_global_per_hour   CONSTANT integer := 150;
  v_recipient text := lower(p_to_email);
  v_hour_limit integer;
BEGIN
  IF EXISTS (SELECT 1 FROM public.email_outbox WHERE dedupe_key = p_dedupe_key) THEN
    RETURN 'duplicate';
  END IF;
  IF (SELECT count(*) FROM public.email_outbox WHERE created_at > now() - interval '1 hour') >= c_global_per_hour THEN
    RETURN 'limited_global';
  END IF;
  IF p_kind <> 'contact_inbox' THEN
    v_hour_limit := CASE WHEN left(p_kind, 7) = 'seller_' THEN c_seller_per_hour ELSE c_customer_per_hour END;
    IF (SELECT count(*) FROM public.email_outbox WHERE lower(to_email) = v_recipient AND created_at > now() - interval '1 hour') >= v_hour_limit THEN
      RETURN 'limited_recipient';
    END IF;
    IF left(p_kind, 7) <> 'seller_'
       AND (SELECT count(*) FROM public.email_outbox WHERE lower(to_email) = v_recipient AND created_at > now() - interval '1 day') >= c_customer_per_day THEN
      RETURN 'limited_recipient';
    END IF;
  END IF;
  INSERT INTO public.email_outbox (store_id, kind, to_email, language, subject, body, payload, reply_to, dedupe_key)
    VALUES (p_store_id, p_kind, p_to_email, p_language, p_subject, p_body, coalesce(p_payload, '{}'::jsonb), p_reply_to, p_dedupe_key)
    ON CONFLICT (dedupe_key) DO NOTHING;
  IF NOT FOUND THEN
    RETURN 'duplicate';
  END IF;
  RETURN 'queued';
END;
$$;

-- email_enqueue_order --------------------------------------------------------------------------
-- Queues the email for one order event, inside the caller's transaction. Customer kinds go to orders.customer_email in the order's
-- language (an order without a usable email address queues nothing). seller_* kinds go to the owner's ACCOUNT email, in English.
-- p_suffix makes the dedupe key unique for a state that can repeat (for example the payment attempt number).
-- p_link is the customer's private order link, known only to the app, passed on by place_order and submit_payment_reference.
CREATE OR REPLACE FUNCTION public.email_enqueue_order(p_order_id uuid, p_kind text, p_suffix text, p_link text) RETURNS text
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_shop record;
  v_seller boolean := left(p_kind, 7) = 'seller_';
  v_to text;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RETURN 'skipped';
  END IF;
  SELECT s.name AS name, s.slug AS slug, ow.email AS owner_email INTO v_shop
    FROM public.stores s JOIN public.owners ow ON ow.id = s.owner_id WHERE s.id = v_order.store_id;
  v_to := CASE WHEN v_seller THEN v_shop.owner_email ELSE v_order.customer_email END;
  IF v_to IS NULL OR char_length(v_to) > 254 OR v_to !~ '^[^@[:space:]]+@[^@[:space:]]+$' THEN
    RETURN 'skipped';
  END IF;
  RETURN public.email_enqueue(
    v_order.store_id, p_kind, v_to, CASE WHEN v_seller THEN 'en' ELSE v_order.language END, '', '',
    jsonb_build_object('reference', v_order.reference, 'shop', v_shop.name, 'slug', v_shop.slug, 'link', p_link),
    NULL, p_kind || ':' || p_order_id::text || coalesce(':' || p_suffix, ''));
END;
$$;

-- claim_due_emails -----------------------------------------------------------------------------
-- Atomically takes up to p_limit due rows: queued rows whose time has come, and rows whose lease expired (a worker died). Sets
-- them to sending with a lease and attempts + 1. FOR UPDATE SKIP LOCKED means two workers never get the same row. A row whose
-- lease expired on its last allowed attempt is marked dead instead of being claimed again (the maximum is 5 attempts).
CREATE OR REPLACE FUNCTION public.claim_due_emails(p_limit integer, p_lease_seconds integer) RETURNS SETOF public.email_outbox
LANGUAGE sql SET search_path = public, pg_temp
AS $$
  UPDATE public.email_outbox
     SET status = 'dead', body = '', payload = '{}'::jsonb, lease_until = NULL, last_error_code = 'LEASE_EXPIRED'
   WHERE status = 'sending' AND lease_until <= now() AND attempts >= 5;
  WITH due AS (
    SELECT id FROM public.email_outbox
     WHERE (status = 'queued' AND next_attempt_at <= now()) OR (status = 'sending' AND lease_until <= now())
     ORDER BY next_attempt_at, id
     LIMIT greatest(p_limit, 0)
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.email_outbox e
     SET status = 'sending', lease_until = now() + make_interval(secs => p_lease_seconds), attempts = e.attempts + 1
    FROM due
   WHERE e.id = due.id
  RETURNING e.*;
$$;

-- finish_email ---------------------------------------------------------------------------------
-- Reports the result of one send. Only a row that is still 'sending' is changed. Sent: status sent, body and payload blanked.
-- Failed with p_retry_seconds NULL: dead at once (the relay refused it). Failed otherwise: queued again after p_retry_seconds, or
-- dead when attempts has reached the maximum (5). p_error_code is a short code, never provider text.
-- Returns the new status ('sent', 'queued' or 'dead'), or NULL when the row was not in the sending state.
CREATE OR REPLACE FUNCTION public.finish_email(p_id uuid, p_sent boolean, p_error_code text, p_retry_seconds integer) RETURNS text
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  c_max_attempts CONSTANT integer := 5;
  v_row public.email_outbox%ROWTYPE;
  v_status text;
BEGIN
  SELECT * INTO v_row FROM public.email_outbox WHERE id = p_id AND status = 'sending' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF p_sent THEN
    v_status := 'sent';
  ELSIF p_retry_seconds IS NULL OR v_row.attempts >= c_max_attempts THEN
    v_status := 'dead';
  ELSE
    v_status := 'queued';
  END IF;
  UPDATE public.email_outbox
     SET status = v_status,
         lease_until = NULL,
         last_error_code = CASE WHEN p_sent THEN NULL ELSE left(coalesce(p_error_code, 'UNKNOWN'), 40) END,
         sent_at = CASE WHEN p_sent THEN now() ELSE sent_at END,
         next_attempt_at = CASE WHEN v_status = 'queued' THEN now() + make_interval(secs => p_retry_seconds) ELSE next_attempt_at END,
         body = CASE WHEN v_status = 'queued' THEN body ELSE '' END,
         payload = CASE WHEN v_status = 'queued' THEN payload ELSE '{}'::jsonb END
   WHERE id = p_id;
  RETURN v_status;
END;
$$;

-- Order functions with outbox hooks ------------------------------------------------------------
-- The bodies below are the 008 / 009 definitions plus ONE added PERFORM public.email_enqueue_order(...) each (marked "email:").

-- order_cancel_locked: the single point where an order becomes cancelled (owner cancel, customer cancel, sweep, lazy expiry).
CREATE OR REPLACE FUNCTION public.order_cancel_locked(p_order_id uuid, p_reason text) RETURNS boolean
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  v_item record;
BEGIN
  UPDATE public.orders
     SET status = 'cancelled', cancel_reason = p_reason, expires_at = NULL, stock_restored_at = now(), updated_at = now()
   WHERE id = p_order_id AND status IN ('awaiting_payment', 'payment_submitted', 'not_received') AND stock_restored_at IS NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  FOR v_item IN
    SELECT product_id, store_id, quantity FROM public.order_items
     WHERE order_id = p_order_id AND stock_reserved ORDER BY product_id
  LOOP
    UPDATE public.products SET stock = stock + v_item.quantity
     WHERE id = v_item.product_id AND store_id = v_item.store_id AND stock IS NOT NULL;
  END LOOP;
  -- email: order_expired for a timeout, order_cancelled for an owner or customer cancel.
  PERFORM public.email_enqueue_order(p_order_id, CASE WHEN p_reason = 'expired' THEN 'order_expired' ELSE 'order_cancelled' END, NULL, NULL);
  RETURN true;
END;
$$;

DROP FUNCTION IF EXISTS public.place_order(uuid, text, text, text, text, text, text, text, bigint, jsonb);
DROP FUNCTION IF EXISTS public.submit_payment_reference(uuid, text, text);

-- place_order: identical to 008 plus p_status_link and the order_placed email.
CREATE OR REPLACE FUNCTION public.place_order(
  p_store_id uuid, p_token_hash text, p_payee_vpa text, p_customer_name text, p_customer_phone text,
  p_customer_email text, p_delivery_address text, p_language text, p_expected_total bigint, p_items jsonb,
  p_status_link text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  v_ids uuid[];
  v_lines int;
  v_upi text;
  v_row record;
  v_seen int := 0;
  v_total bigint := 0;
  v_number int;
  v_order_id uuid;
  v_reference text;
  v_expires timestamptz;
BEGIN
  IF p_store_id IS NULL OR p_token_hash IS NULL OR p_payee_vpa IS NULL OR p_customer_name IS NULL OR p_customer_phone IS NULL
     OR p_language IS NULL OR p_expected_total IS NULL OR p_items IS NULL OR jsonb_typeof(p_items) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 20 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;

  SELECT array_agg(product_id), count(*) INTO v_ids, v_lines FROM public.order_parse_items(p_items);
  IF v_lines <> jsonb_array_length(p_items) OR (SELECT count(DISTINCT x) FROM unnest(v_ids) AS x) <> v_lines
     OR EXISTS (SELECT 1 FROM public.order_parse_items(p_items) i WHERE i.quantity NOT BETWEEN 1 AND 20) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;

  PERFORM public.expire_overdue_orders(p_store_id, v_ids);

  SELECT upi_id INTO v_upi FROM public.stores WHERE id = p_store_id FOR SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'store_not_found');
  END IF;
  IF v_upi IS DISTINCT FROM p_payee_vpa THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'payee_changed');
  END IF;

  FOR v_row IN
    SELECT p.id, p.status, p.price_paise, p.stock, i.quantity, i.expected_price_paise
      FROM public.products p JOIN public.order_parse_items(p_items) i ON i.product_id = p.id
     WHERE p.store_id = p_store_id ORDER BY p.id FOR UPDATE OF p
  LOOP
    v_seen := v_seen + 1;
    IF v_row.status <> 'published' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'product_unavailable');
    ELSIF v_row.price_paise IS DISTINCT FROM v_row.expected_price_paise THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'price_changed');
    ELSIF v_row.stock IS NOT NULL AND v_row.stock < v_row.quantity THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_stock');
    END IF;
    v_total := v_total + v_row.price_paise * v_row.quantity;
  END LOOP;
  IF v_seen <> v_lines THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'product_unavailable');
  END IF;
  IF v_total <> p_expected_total THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'total_mismatch');
  END IF;

  INSERT INTO public.store_order_counters (store_id, last_number) VALUES (p_store_id, 1001)
    ON CONFLICT (store_id) DO UPDATE SET last_number = public.store_order_counters.last_number + 1
    RETURNING last_number INTO v_number;
  v_reference := 'AS' || v_number::text;
  v_expires := now() + public.order_expiry_interval();

  INSERT INTO public.orders (store_id, reference, status_token_hash, payee_vpa, total_paise, customer_name, customer_phone,
                             customer_email, delivery_address, language, expires_at)
    VALUES (p_store_id, v_reference, p_token_hash, p_payee_vpa, v_total, p_customer_name, p_customer_phone,
            p_customer_email, p_delivery_address, p_language, v_expires)
    RETURNING id INTO v_order_id;

  INSERT INTO public.order_items (order_id, store_id, position, product_id, title, title_lang, unit_price_paise, quantity,
                                  line_total_paise, stock_reserved)
    SELECT v_order_id, p_store_id, i.item_position, p.id, i.title, i.title_lang, p.price_paise, i.quantity,
           p.price_paise * i.quantity, p.stock IS NOT NULL
      FROM public.products p JOIN public.order_parse_items(p_items) i ON i.product_id = p.id
     WHERE p.store_id = p_store_id;

  UPDATE public.products p SET stock = p.stock - i.quantity
    FROM public.order_parse_items(p_items) i
   WHERE p.id = i.product_id AND p.store_id = p_store_id AND p.stock IS NOT NULL;

  -- email: order_placed (the customer's private link is only known to the app).
  PERFORM public.email_enqueue_order(v_order_id, 'order_placed', NULL, p_status_link);

  RETURN jsonb_build_object('ok', true, 'order_id', v_order_id, 'reference', v_reference, 'expires_at', v_expires);
END;
$$;

-- submit_payment_reference: identical to 008 plus p_status_link and two emails (customer: payment reference received;
-- owner: check your bank app). The dedupe suffix is the attempt number, because an order can be submitted up to 3 times.
CREATE OR REPLACE FUNCTION public.submit_payment_reference(p_store_id uuid, p_token_hash text, p_utr text, p_status_link text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
BEGIN
  IF p_store_id IS NULL OR p_token_hash IS NULL OR p_utr IS NULL OR p_utr !~ '^[0-9]{12}$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;
  SELECT * INTO v_order FROM public.orders WHERE store_id = p_store_id AND status_token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF v_order.status = 'payment_submitted' AND v_order.utr = p_utr THEN
    RETURN jsonb_build_object('ok', true, 'already', true);
  END IF;
  IF v_order.status NOT IN ('awaiting_payment', 'not_received') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_transition');
  END IF;
  IF v_order.expires_at <= now() THEN
    PERFORM public.order_cancel_locked(v_order.id, 'expired');
    RETURN jsonb_build_object('ok', false, 'reason', 'expired');
  END IF;
  IF v_order.utr_submissions >= 3 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'attempt_limit');
  END IF;
  BEGIN
    INSERT INTO public.order_payment_attempts (order_id, store_id, utr) VALUES (v_order.id, p_store_id, p_utr);
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'utr_in_use');
  END;
  UPDATE public.orders
     SET status = 'payment_submitted', utr = p_utr, utr_submissions = utr_submissions + 1, expires_at = NULL, updated_at = now()
   WHERE id = v_order.id;
  -- email: customer and owner, once per attempt.
  PERFORM public.email_enqueue_order(v_order.id, 'order_payment_received', (v_order.utr_submissions + 1)::text, p_status_link);
  PERFORM public.email_enqueue_order(v_order.id, 'seller_payment_submitted', (v_order.utr_submissions + 1)::text, NULL);
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- resolve_payment: identical to 009 plus the order_confirmed / order_payment_not_found email.
CREATE OR REPLACE FUNCTION public.resolve_payment(p_store_id uuid, p_owner_id uuid, p_order_id uuid, p_outcome text) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
BEGIN
  IF p_store_id IS NULL OR p_owner_id IS NULL OR p_order_id IS NULL OR p_outcome IS NULL OR p_outcome NOT IN ('paid', 'not_received') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;
  IF NOT public.order_owner_matches(p_store_id, p_owner_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id AND store_id = p_store_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF v_order.status = p_outcome THEN
    RETURN jsonb_build_object('ok', true, 'already', true);
  END IF;
  IF v_order.status <> 'payment_submitted' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_transition');
  END IF;
  IF p_outcome = 'paid' THEN
    UPDATE public.orders SET status = 'paid', paid_at = now(), expires_at = NULL, updated_at = now() WHERE id = v_order.id;
    -- email: order_confirmed (once: paid is terminal).
    PERFORM public.email_enqueue_order(v_order.id, 'order_confirmed', NULL, NULL);
  ELSE
    UPDATE public.orders SET status = 'not_received', expires_at = now() + public.order_resubmit_interval(), updated_at = now()
     WHERE id = v_order.id;
    -- email: order_payment_not_found, once per attempt.
    PERFORM public.email_enqueue_order(v_order.id, 'order_payment_not_found', v_order.utr_submissions::text, NULL);
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Function privileges --------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.email_enqueue(uuid, text, text, text, text, text, jsonb, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.email_enqueue_order(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_due_emails(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.finish_email(uuid, boolean, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.order_cancel_locked(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.place_order(uuid, text, text, text, text, text, text, text, bigint, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.submit_payment_reference(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.resolve_payment(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.email_enqueue(uuid, text, text, text, text, text, jsonb, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.email_enqueue_order(uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_due_emails(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_email(uuid, boolean, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_cancel_locked(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.place_order(uuid, text, text, text, text, text, text, text, bigint, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.submit_payment_reference(uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_payment(uuid, uuid, uuid, text) TO service_role;

-- Rollback (manual, only if needed): re-create place_order, submit_payment_reference, order_cancel_locked from 008 and
-- resolve_payment from 009, then
--   DROP FUNCTION public.finish_email(uuid, boolean, text, integer); DROP FUNCTION public.claim_due_emails(integer, integer);
--   DROP FUNCTION public.email_enqueue_order(uuid, text, text, text);
--   DROP FUNCTION public.email_enqueue(uuid, text, text, text, text, text, jsonb, text, text);
--   DROP TABLE public.contact_messages; DROP TABLE public.email_outbox; ALTER TABLE public.stores DROP COLUMN notify_enquiry_email;
