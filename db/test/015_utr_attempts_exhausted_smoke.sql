-- Manual smoke test for migration 015. Run the WHOLE file in the Supabase SQL editor (default postgres role), AFTER 008 to 015.
-- Success: one row "ALL CHECKS PASSED". Failure: error "FAIL: <check name>". Leaves no data (sub-transaction rolled back, SQLSTATE AB001).
-- Test rows use the prefix "smoke-015".

CREATE OR REPLACE FUNCTION pg_temp.check_that(p_ok boolean, p_name text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN
    RAISE EXCEPTION 'FAIL: %', p_name;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.smoke_015() RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_owner uuid; s uuid; p uuid; r jsonb; o uuid; i int; v_hash text := encode(sha256(convert_to('smoke-015-token', 'UTF8')), 'hex');
BEGIN
  INSERT INTO public.owners (email, password_hash) VALUES ('smoke-015-' || gen_random_uuid() || '@example.invalid', 'x') RETURNING id INTO v_owner;
  INSERT INTO public.stores (owner_id, slug, name, default_language, story, upi_id)
    VALUES (v_owner, 'smoke-015-' || substr(gen_random_uuid()::text, 1, 8), 'Smoke 015', 'en', 'story', 'smoke.shop@okbank') RETURNING id INTO s;
  p := gen_random_uuid();
  INSERT INTO public.products (id, store_id, status, price_paise, stock, image_path) VALUES (p, s, 'published', 10000, 5, 'smoke-015/' || p || '.jpg');
  r := public.place_order(s, v_hash, 'smoke.shop@okbank', 'Smoke Buyer', '919876543210', 'smoke-015@example.invalid', 'Smoke address', 'en', 20000,
    jsonb_build_array(jsonb_build_object('product_id', p, 'quantity', 2, 'expected_price_paise', 10000, 'title', 'Smoke item', 'title_lang', 'en')));
  o := (r ->> 'order_id')::uuid;
  PERFORM pg_temp.check_that((SELECT stock FROM public.products WHERE id = p) = 3, 'stock reserved');
  FOR i IN 1..2 LOOP
    r := public.submit_payment_reference(s, v_hash, lpad(i::text, 12, '1'));
    PERFORM pg_temp.check_that((r ->> 'ok')::boolean, 'submission ' || i);
    r := public.resolve_payment(s, v_owner, o, 'not_received');
    PERFORM pg_temp.check_that((r ->> 'ok')::boolean AND r -> 'cancelled' IS NULL AND (SELECT status FROM public.orders WHERE id = o) = 'not_received', 'rejection ' || i || ' keeps the order open');
  END LOOP;
  r := public.submit_payment_reference(s, v_hash, '333333333333');
  PERFORM pg_temp.check_that((r ->> 'ok')::boolean, 'third submission');
  r := public.resolve_payment(s, v_owner, o, 'not_received');
  PERFORM pg_temp.check_that((r ->> 'ok')::boolean AND (r ->> 'cancelled')::boolean, 'third rejection cancels');
  PERFORM pg_temp.check_that((SELECT status = 'cancelled' AND cancel_reason = 'utr_attempts_exhausted' AND stock_restored_at IS NOT NULL FROM public.orders WHERE id = o), 'order cancelled with the new reason');
  PERFORM pg_temp.check_that((SELECT stock FROM public.products WHERE id = p) = 5, 'stock restored exactly once');
  r := public.resolve_payment(s, v_owner, o, 'not_received');
  PERFORM pg_temp.check_that((r ->> 'ok')::boolean AND (SELECT stock FROM public.products WHERE id = p) = 5, 'repeat is idempotent, stock unchanged');
  PERFORM pg_temp.check_that((SELECT count(*) FROM public.email_outbox WHERE dedupe_key = 'order_cancelled:' || o::text) = 1, 'exactly one cancellation email');
  PERFORM pg_temp.check_that((SELECT payload ->> 'cancel_reason' FROM public.email_outbox WHERE dedupe_key = 'order_cancelled:' || o::text) = 'utr_attempts_exhausted', 'email payload carries the reason');
  PERFORM pg_temp.check_that((SELECT count(*) FROM public.email_outbox WHERE dedupe_key = 'order_payment_not_found:' || o::text || ':3') = 0, 'no payment-not-found email for the third rejection');
  RAISE EXCEPTION USING ERRCODE = 'AB001', MESSAGE = 'rollback';
END;
$$;

DO $$
BEGIN
  BEGIN
    PERFORM pg_temp.smoke_015();
  EXCEPTION WHEN SQLSTATE 'AB001' THEN
    NULL;
  END;
END;
$$;

SELECT 'ALL CHECKS PASSED' AS result;
