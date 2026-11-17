-- Migration 011: concurrency-safe email limits, and a private order link in every customer order email (Module 5 review).
-- Apply in the Supabase SQL editor AFTER migration 010. Idempotent: safe to run more than once. Forward-only: 008, 009 and 010 are NOT edited.
-- STATUS: written, NOT applied. The developer applies it, then runs db/verify/011_email_hardening_checks.sql and
-- db/test/011_email_hardening_smoke.sql (and the two-session tests in db/test/011_email_races.sql).
--
-- 1. Concurrency. email_enqueue counted rows and then inserted, so two transactions running at the same time could both pass the
--    per-recipient or the global limit (READ COMMITTED does not see the other's uncommitted row). Fix: every transaction that can
--    queue an email first takes ONE transaction-level advisory lock (email_serialize), so queuing is serialized and the counts are
--    exact. To keep the lock order identical everywhere (no deadlock with the row and product locks the order functions take), every
--    order function takes this lock as its FIRST step: place_order, submit_payment_reference, resolve_payment, cancel_order, and
--    expire_overdue_orders (only when something is overdue). The lock is released at commit or rollback. Cost: order changes and email
--    queuing run one after another, which is fine at this scale. Limits are unchanged (6/h and 20/day per customer address, 30/h per
--    seller address, 150/h global).
-- 2. Private link in all six customer emails. The status token itself is never stored (only its SHA-256, as before). The app encrypts
--    the token with a server-held key (AES-256-GCM, key in the ORDER_LINK_KEY environment variable, never in the database) and passes the
--    ciphertext to place_order, which keeps it in orders.status_token_enc. The ciphertext is useless without the key. email_enqueue_order
--    copies it into the outbox payload ('token_enc') and the worker decrypts it at send time to build the link. Orders placed before this
--    migration (or without a key) have no ciphertext: their emails fall back to the shop link and the "link in your first email" sentence.
--    The p_status_link argument of 010 is gone (the link is no longer given to the database).
-- 3. Security model unchanged from 008, 009 and 010: every function is SECURITY INVOKER (the default; none is SECURITY DEFINER), sets
--    search_path = public, pg_temp, has EXECUTE revoked from PUBLIC, anon and authenticated and granted to service_role only.
-- Signatures: place_order keeps its 11 arguments (the last is now p_status_token_enc text); submit_payment_reference returns to the 3
-- arguments of 008; email_enqueue_order loses p_link. The old versions are dropped.

-- orders.status_token_enc -----------------------------------------------------------------------
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS status_token_enc text;
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_status_token_enc_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_status_token_enc_check
  CHECK (status_token_enc IS NULL OR (char_length(status_token_enc) BETWEEN 1 AND 200 AND status_token_enc ~ '^[A-Za-z0-9_-]+$'));

-- email_serialize -------------------------------------------------------------------------------
-- Takes the one advisory lock that serializes email queuing, until the end of the transaction. Taking it again in the same
-- transaction is a no-op. 7010011 is an arbitrary fixed key used by nothing else.
CREATE OR REPLACE FUNCTION public.email_serialize() RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(7010011);
END;
$$;

-- email_enqueue: identical to 010 plus the lock as the first step ---------------------------------
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
  PERFORM public.email_serialize();
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

-- email_enqueue_order: 010 without p_link; the payload carries the encrypted token ----------------
DROP FUNCTION IF EXISTS public.email_enqueue_order(uuid, text, text, text);

CREATE OR REPLACE FUNCTION public.email_enqueue_order(p_order_id uuid, p_kind text, p_suffix text) RETURNS text
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
    jsonb_build_object('reference', v_order.reference, 'shop', v_shop.name, 'slug', v_shop.slug,
                       'token_enc', CASE WHEN v_seller THEN NULL ELSE v_order.status_token_enc END),
    NULL, p_kind || ':' || p_order_id::text || coalesce(':' || p_suffix, ''));
END;
$$;

-- order_cancel_locked: 010 with the 3-argument email call ------------------------------------------
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
  PERFORM public.email_enqueue_order(p_order_id, CASE WHEN p_reason = 'expired' THEN 'order_expired' ELSE 'order_cancelled' END, NULL);
  RETURN true;
END;
$$;

-- expire_overdue_orders: 008 plus the lock before anything is locked (only when something is overdue) -
CREATE OR REPLACE FUNCTION public.expire_overdue_orders(p_store_id uuid, p_product_ids uuid[] DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_count integer := 0;
BEGIN
  IF p_store_id IS NULL THEN
    RETURN 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.store_id = p_store_id AND o.status IN ('awaiting_payment', 'not_received') AND o.expires_at <= now()) THEN
    RETURN 0;
  END IF;
  PERFORM public.email_serialize();
  FOR v_id IN
    SELECT o.id FROM public.orders o
     WHERE o.store_id = p_store_id
       AND o.status IN ('awaiting_payment', 'not_received')
       AND o.expires_at <= now()
       AND (p_product_ids IS NULL OR EXISTS (
             SELECT 1 FROM public.order_items i WHERE i.order_id = o.id AND i.product_id = ANY (p_product_ids)))
     ORDER BY o.id
     LIMIT 100
     FOR UPDATE OF o SKIP LOCKED
  LOOP
    IF public.order_cancel_locked(v_id, 'expired') THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;

-- place_order: 010 with the lock first, p_status_token_enc stored on the order ----------------------
DROP FUNCTION IF EXISTS public.place_order(uuid, text, text, text, text, text, text, text, bigint, jsonb, text);

CREATE OR REPLACE FUNCTION public.place_order(
  p_store_id uuid, p_token_hash text, p_payee_vpa text, p_customer_name text, p_customer_phone text,
  p_customer_email text, p_delivery_address text, p_language text, p_expected_total bigint, p_items jsonb,
  p_status_token_enc text DEFAULT NULL
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
  PERFORM public.email_serialize();
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

  INSERT INTO public.orders (store_id, reference, status_token_hash, status_token_enc, payee_vpa, total_paise, customer_name, customer_phone,
                             customer_email, delivery_address, language, expires_at)
    VALUES (p_store_id, v_reference, p_token_hash, p_status_token_enc, p_payee_vpa, v_total, p_customer_name, p_customer_phone,
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

  -- email: order_placed.
  PERFORM public.email_enqueue_order(v_order_id, 'order_placed', NULL);

  RETURN jsonb_build_object('ok', true, 'order_id', v_order_id, 'reference', v_reference, 'expires_at', v_expires);
END;
$$;

-- submit_payment_reference: the 008 signature again, with the lock first and the two emails ---------
DROP FUNCTION IF EXISTS public.submit_payment_reference(uuid, text, text, text);

CREATE OR REPLACE FUNCTION public.submit_payment_reference(p_store_id uuid, p_token_hash text, p_utr text) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
BEGIN
  PERFORM public.email_serialize();
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
  PERFORM public.email_enqueue_order(v_order.id, 'order_payment_received', (v_order.utr_submissions + 1)::text);
  PERFORM public.email_enqueue_order(v_order.id, 'seller_payment_submitted', (v_order.utr_submissions + 1)::text);
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- resolve_payment: 010 with the lock first ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_payment(p_store_id uuid, p_owner_id uuid, p_order_id uuid, p_outcome text) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
BEGIN
  PERFORM public.email_serialize();
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
    PERFORM public.email_enqueue_order(v_order.id, 'order_confirmed', NULL);
  ELSE
    UPDATE public.orders SET status = 'not_received', expires_at = now() + public.order_resubmit_interval(), updated_at = now()
     WHERE id = v_order.id;
    PERFORM public.email_enqueue_order(v_order.id, 'order_payment_not_found', v_order.utr_submissions::text);
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- cancel_order: 008 with the lock first --------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_order(p_store_id uuid, p_order_id uuid, p_actor text, p_owner_id uuid, p_token_hash text)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
BEGIN
  PERFORM public.email_serialize();
  IF p_store_id IS NULL OR p_order_id IS NULL OR p_actor IS NULL OR p_actor NOT IN ('owner', 'customer') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;
  IF p_actor = 'owner' AND (p_owner_id IS NULL OR NOT public.order_owner_matches(p_store_id, p_owner_id)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id AND store_id = p_store_id FOR UPDATE;
  IF NOT FOUND OR (p_actor = 'customer' AND v_order.status_token_hash IS DISTINCT FROM p_token_hash) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF v_order.status = 'cancelled' THEN
    RETURN jsonb_build_object('ok', true, 'already', true);
  END IF;
  IF v_order.status = 'paid' OR (p_actor = 'customer' AND v_order.status = 'payment_submitted') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_transition');
  END IF;
  PERFORM public.order_cancel_locked(v_order.id, p_actor);
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Function privileges (dropped and re-created functions start from the default privileges, so every one is set explicitly) ---
REVOKE EXECUTE ON FUNCTION public.email_serialize() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.email_enqueue(uuid, text, text, text, text, text, jsonb, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.email_enqueue_order(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.order_cancel_locked(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.expire_overdue_orders(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.place_order(uuid, text, text, text, text, text, text, text, bigint, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.submit_payment_reference(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.resolve_payment(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cancel_order(uuid, uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.email_serialize() TO service_role;
GRANT EXECUTE ON FUNCTION public.email_enqueue(uuid, text, text, text, text, text, jsonb, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.email_enqueue_order(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_cancel_locked(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.expire_overdue_orders(uuid, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.place_order(uuid, text, text, text, text, text, text, text, bigint, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.submit_payment_reference(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_payment(uuid, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_order(uuid, uuid, text, uuid, text) TO service_role;

-- Rollback (manual, only if needed): re-run the function definitions from 010 (and cancel_order, expire_overdue_orders from 008), then
--   DROP FUNCTION public.email_serialize(); ALTER TABLE public.orders DROP COLUMN status_token_enc;
