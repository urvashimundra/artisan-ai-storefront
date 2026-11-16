-- Migration 009: stock reservation shortened to 10 minutes for awaiting_payment orders (forward-only; 008 is NOT edited).
-- Apply in the Supabase SQL editor AFTER migration 008. Idempotent: safe to run more than once.
-- STATUS: written, NOT applied. The developer applies it, then runs db/verify/009_order_reservation_checks.sql and
-- db/test/009_order_reservation_smoke.sql (and the two-session race tests in db/test/009_order_reservation_races.sql).
--
-- Policy
--   * awaiting_payment: reservation (and the right to submit a UTR) lasts exactly 10 minutes from creation.
--   * payment_submitted: expires_at is NULL; stock stays reserved while the owner verifies by hand (unchanged).
--   * not_received (owner said the money did not arrive): keeps its own, separate window of 1 hour so the customer can
--     correct the UTR. This is a deliberate decision, see docs/DECISIONS.md. It is the only place that uses
--     order_resubmit_interval().
-- What is NOT changed: place_order, submit_payment_reference, expire_overdue_orders, order_cancel_locked, cancel_order and
-- the lock order. They all read the window through order_expiry_interval() or the stored expires_at, and
-- submit_payment_reference already rejects (and expires) an order whose expires_at <= now() even if no sweep has run yet.
-- Only database time (now()) is used, never a client clock.

-- The awaiting_payment window. The ONLY place it is defined in SQL (mirrored by ORDER_EXPIRY_MINUTES in JS).
CREATE OR REPLACE FUNCTION public.order_expiry_interval() RETURNS interval
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp
AS $$ SELECT interval '10 minutes' $$;

-- The window given again after the owner marks a payment as not received (mirrored by ORDER_RESUBMIT_MINUTES in JS).
CREATE OR REPLACE FUNCTION public.order_resubmit_interval() RETURNS interval
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp
AS $$ SELECT interval '1 hour' $$;

-- resolve_payment: identical to migration 008 except that not_received now uses order_resubmit_interval().
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
  ELSE
    UPDATE public.orders SET status = 'not_received', expires_at = now() + public.order_resubmit_interval(), updated_at = now()
     WHERE id = v_order.id;
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Existing orders: an awaiting_payment order created under the old 1 hour window gets the effective deadline
-- created_at + 10 minutes. Those already past it are expired (and their stock restored, once) by the normal lazy sweep on
-- the next place_order, status page or owner view; submit_payment_reference rejects them in the meantime. Only orders whose
-- deadline would move EARLIER are touched, so re-running this changes nothing. Other statuses are untouched.
UPDATE public.orders
   SET expires_at = created_at + public.order_expiry_interval(), updated_at = now()
 WHERE status = 'awaiting_payment' AND expires_at > created_at + public.order_expiry_interval();

REVOKE EXECUTE ON FUNCTION public.order_expiry_interval() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.order_resubmit_interval() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.resolve_payment(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_expiry_interval() TO service_role;
GRANT EXECUTE ON FUNCTION public.order_resubmit_interval() TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_payment(uuid, uuid, uuid, text) TO service_role;

-- Rollback (manual): re-run the order_expiry_interval and resolve_payment definitions from 008 and
--   DROP FUNCTION public.order_resubmit_interval();
-- Orders already shortened keep their earlier deadline; that is harmless.
