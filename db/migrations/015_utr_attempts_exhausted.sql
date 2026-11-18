-- Migration 015: the third rejected payment reference cancels the order (Fix round A, item O1).
-- Apply in the Supabase SQL editor AFTER migration 014. Idempotent: safe to run more than once. Forward-only: 008 to 014 are NOT edited.
-- STATUS: written, NOT applied. The developer applies it, then runs db/verify/015_utr_attempts_exhausted_checks.sql and
-- db/test/015_utr_attempts_exhausted_smoke.sql.
--
-- 1. orders_cancel_reason_check accepts the new reason 'utr_attempts_exhausted'.
-- 2. resolve_payment: when the owner marks the submission "not_received" and utr_submissions has already reached 3 (the JS constant
--    MAX_UTR_SUBMISSIONS), the order is cancelled through order_cancel_locked (the single cancel path: stock restored exactly once,
--    one order_cancelled email, dedupe key order_cancelled:<order id>). No "payment not found" email is queued in that case.
--    The result carries cancelled = true. Otherwise behaviour is identical to 011.
-- 3. email_enqueue_order: the outbox payload also carries cancel_reason, so the worker can write reason-specific wording.
-- 4. email_enqueue: the cancellation notice (order_cancelled) is exempt from the per-recipient HOURLY limit. An order that runs through
--    three payment references already queues 6 customer emails in the hour (placed, 3 received, 2 not found), so the 7th, the notice
--    that the order is cancelled, would otherwise be dropped. It stays bounded: at most one per order (dedupe key), the daily and the
--    global limits still apply.
-- Security model unchanged: SECURITY INVOKER, search_path = public, pg_temp, EXECUTE for service_role only.

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_cancel_reason_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_cancel_reason_check
  CHECK (cancel_reason IS NULL OR cancel_reason IN ('expired', 'customer', 'owner', 'utr_attempts_exhausted'));

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
    IF p_kind <> 'order_cancelled'
       AND (SELECT count(*) FROM public.email_outbox WHERE lower(to_email) = v_recipient AND created_at > now() - interval '1 hour') >= v_hour_limit THEN
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
                       'token_enc', CASE WHEN v_seller THEN NULL ELSE v_order.status_token_enc END,
                       'cancel_reason', CASE WHEN p_kind = 'order_cancelled' THEN v_order.cancel_reason ELSE NULL END),
    NULL, p_kind || ':' || p_order_id::text || coalesce(':' || p_suffix, ''));
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_payment(p_store_id uuid, p_owner_id uuid, p_order_id uuid, p_outcome text) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  c_max_utr_submissions CONSTANT integer := 3;
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
  IF p_outcome = 'not_received' AND v_order.status = 'cancelled' AND v_order.cancel_reason = 'utr_attempts_exhausted' THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'cancelled', true);
  END IF;
  IF v_order.status <> 'payment_submitted' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_transition');
  END IF;
  IF p_outcome = 'paid' THEN
    UPDATE public.orders SET status = 'paid', paid_at = now(), expires_at = NULL, updated_at = now() WHERE id = v_order.id;
    PERFORM public.email_enqueue_order(v_order.id, 'order_confirmed', NULL);
  ELSIF v_order.utr_submissions >= c_max_utr_submissions THEN
    PERFORM public.order_cancel_locked(v_order.id, 'utr_attempts_exhausted');
    RETURN jsonb_build_object('ok', true, 'cancelled', true);
  ELSE
    UPDATE public.orders SET status = 'not_received', expires_at = now() + public.order_resubmit_interval(), updated_at = now()
     WHERE id = v_order.id;
    PERFORM public.email_enqueue_order(v_order.id, 'order_payment_not_found', v_order.utr_submissions::text);
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.email_enqueue(uuid, text, text, text, text, text, jsonb, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_enqueue(uuid, text, text, text, text, text, jsonb, text, text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.email_enqueue_order(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.resolve_payment(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_enqueue_order(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_payment(uuid, uuid, uuid, text) TO service_role;

-- Rollback (manual): re-run resolve_payment, email_enqueue_order and email_enqueue from migration 011 and restore the 008 cancel-reason CHECK
-- (only possible while no order has the new reason).
