-- Manual smoke test for migration 009 (10 minute reservation). Run the WHOLE file in the Supabase SQL editor (default
-- postgres role), AFTER migrations 008 and 009. Success: one row "ALL CHECKS PASSED". Failure: error "FAIL: <check name>".
-- Leaves no data: everything runs in a sub-transaction that is always rolled back (sentinel SQLSTATE AB001).
-- Single-session behaviour: window length, late UTR, stock restored once, NULL stock, last unit, legacy orders.
-- The concurrent scenarios are in 009_order_reservation_races.sql. All test rows use the prefix "smoke-009".

CREATE OR REPLACE FUNCTION pg_temp.check_that(p_ok boolean, p_name text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN
    RAISE EXCEPTION 'FAIL: %', p_name;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.item(p_product uuid, p_qty int, p_price bigint) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_build_object('product_id', p_product, 'quantity', p_qty, 'expected_price_paise', p_price, 'title', 'Smoke item', 'title_lang', 'en')
$$;

CREATE OR REPLACE FUNCTION pg_temp.hash_of(p_label text) RETURNS text
LANGUAGE sql AS $$ SELECT encode(sha256(convert_to(p_label, 'UTF8')), 'hex') $$;

CREATE OR REPLACE FUNCTION pg_temp.place(p_store uuid, p_label text, p_items jsonb, p_total bigint) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT public.place_order(p_store, pg_temp.hash_of(p_label), 'smoke.shop@okbank', 'Smoke Buyer', '919876543210', NULL, 'Smoke address', 'en', p_total, p_items)
$$;

CREATE OR REPLACE FUNCTION pg_temp.make_store() RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_owner uuid; v_store uuid;
BEGIN
  INSERT INTO public.owners (email, password_hash) VALUES ('smoke-009-' || gen_random_uuid() || '@example.invalid', 'x') RETURNING id INTO v_owner;
  INSERT INTO public.stores (owner_id, slug, name, default_language, story, upi_id)
    VALUES (v_owner, 'smoke-009-' || substr(gen_random_uuid()::text, 1, 8), 'Smoke 009', 'en', 'story', 'smoke.shop@okbank') RETURNING id INTO v_store;
  RETURN v_store;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.make_product(p_store uuid, p_price bigint, p_stock int) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.products (id, store_id, status, price_paise, stock, image_path)
    VALUES (v_id, p_store, 'published', p_price, p_stock, 'smoke-009/' || v_id || '.jpg');
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.stock_of(p_product uuid) RETURNS int
LANGUAGE sql AS $$ SELECT stock FROM public.products WHERE id = p_product $$;

CREATE OR REPLACE FUNCTION pg_temp.status_of(p_label text) RETURNS text
LANGUAGE sql AS $$ SELECT status FROM public.orders WHERE status_token_hash = pg_temp.hash_of(p_label) $$;

CREATE OR REPLACE FUNCTION pg_temp.reason(p_result jsonb) RETURNS text
LANGUAGE sql AS $$ SELECT CASE WHEN (p_result ->> 'ok')::boolean THEN 'ok' ELSE p_result ->> 'reason' END $$;

CREATE OR REPLACE FUNCTION pg_temp.submit(p_store uuid, p_label text, p_utr text) RETURNS text
LANGUAGE sql AS $$ SELECT pg_temp.reason(public.submit_payment_reference(p_store, pg_temp.hash_of(p_label), p_utr)) $$;

-- Moves an order's creation time (and so its deadline) into the past by p_minutes, as if that much time had passed.
CREATE OR REPLACE FUNCTION pg_temp.age(p_label text, p_minutes int) RETURNS void
LANGUAGE sql AS $$
  UPDATE public.orders SET created_at = created_at - make_interval(mins => p_minutes), expires_at = expires_at - make_interval(mins => p_minutes)
   WHERE status_token_hash = pg_temp.hash_of(p_label)
$$;

CREATE OR REPLACE FUNCTION pg_temp.smoke_009() RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  s uuid; v_owner uuid; pa uuid; pu uuid; pl uuid; pg uuid; r jsonb; o uuid;
  v_sub_expires timestamptz; v_sub_updated timestamptz; v_nr_expires timestamptz; v_nr_updated timestamptz;
BEGIN
  s := pg_temp.make_store();
  SELECT stores.owner_id INTO v_owner FROM public.stores WHERE id = s;
  pa := pg_temp.make_product(s, 10000, 5);
  pu := pg_temp.make_product(s, 10000, NULL);
  pl := pg_temp.make_product(s, 10000, 1);

  -- window ------------------------------------------------------------------------------------------------
  PERFORM pg_temp.check_that(public.order_expiry_interval() = interval '10 minutes', 'awaiting_payment window is 10 minutes');
  r := pg_temp.place(s, 'w1', jsonb_build_array(pg_temp.item(pa, 2, 10000)), 20000);
  PERFORM pg_temp.check_that((SELECT expires_at - created_at = interval '10 minutes' AND expires_at > now() FROM public.orders WHERE id = (r ->> 'order_id')::uuid),
    'a new order expires exactly 10 minutes after creation');
  PERFORM pg_temp.check_that(pg_temp.stock_of(pa) = 3, 'stock reserved at creation');

  -- UTR before the deadline prevents expiry, keeps stock reserved, no extra decrement ---------------------------------
  PERFORM pg_temp.age('w1', 9);
  PERFORM pg_temp.check_that(pg_temp.submit(s, 'w1', '111111111111') = 'ok', 'UTR at 9 minutes is accepted');
  PERFORM pg_temp.age('w1', 60);
  PERFORM pg_temp.check_that(public.expire_overdue_orders(s) = 0 AND pg_temp.status_of('w1') = 'payment_submitted', 'a submitted order never expires');
  PERFORM pg_temp.check_that(pg_temp.stock_of(pa) = 3, 'stock stays reserved while payment is verified, with no extra decrement');
  o := (SELECT id FROM public.orders WHERE status_token_hash = pg_temp.hash_of('w1'));
  PERFORM pg_temp.check_that(pg_temp.reason(public.resolve_payment(s, v_owner, o, 'paid')) = 'ok' AND pg_temp.stock_of(pa) = 3, 'mark paid does not touch stock');

  -- late UTR is rejected even though no sweep has run ----------------------------------------------------------------
  PERFORM pg_temp.place(s, 'late', jsonb_build_array(pg_temp.item(pa, 1, 10000)), 10000);
  PERFORM pg_temp.age('late', 11);
  PERFORM pg_temp.check_that(pg_temp.status_of('late') = 'awaiting_payment', 'precondition: the sweep has not run');
  PERFORM pg_temp.check_that(pg_temp.submit(s, 'late', '222222222222') = 'expired', 'UTR after 10 minutes is rejected without a sweep');
  PERFORM pg_temp.check_that(pg_temp.status_of('late') = 'cancelled' AND pg_temp.stock_of(pa) = 3, 'late UTR expires the order and restores its stock once');
  PERFORM pg_temp.check_that(NOT EXISTS (SELECT 1 FROM public.order_payment_attempts WHERE utr = '222222222222'), 'a rejected late UTR leaves no attempt row');
  PERFORM pg_temp.check_that(pg_temp.submit(s, 'late', '222222222222') = 'invalid_transition', 'an already expired order cannot be submitted');
  PERFORM pg_temp.check_that(pg_temp.reason(public.resolve_payment(s, v_owner, (SELECT id FROM public.orders WHERE status_token_hash = pg_temp.hash_of('late')), 'paid')) = 'invalid_transition',
    'an expired order cannot be marked paid');

  -- stock is restored exactly once -------------------------------------------------------------------------------------
  PERFORM pg_temp.place(s, 'once', jsonb_build_array(pg_temp.item(pa, 2, 10000)), 20000);
  PERFORM pg_temp.age('once', 11);
  PERFORM pg_temp.check_that(public.expire_overdue_orders(s) = 1 AND pg_temp.stock_of(pa) = 3, 'sweep restores stock');
  PERFORM pg_temp.check_that(public.expire_overdue_orders(s) = 0 AND pg_temp.stock_of(pa) = 3, 'a second sweep restores nothing');
  PERFORM pg_temp.check_that(pg_temp.reason(public.cancel_order(s, (SELECT id FROM public.orders WHERE status_token_hash = pg_temp.hash_of('once')), 'owner', v_owner, NULL)) = 'ok'
    AND pg_temp.stock_of(pa) = 3, 'cancelling an expired order restores nothing more');

  -- NULL (unlimited) stock ---------------------------------------------------------------------------------------------
  PERFORM pg_temp.place(s, 'unl', jsonb_build_array(pg_temp.item(pu, 3, 10000)), 30000);
  PERFORM pg_temp.age('unl', 11);
  PERFORM pg_temp.check_that(public.expire_overdue_orders(s) = 1 AND pg_temp.stock_of(pu) IS NULL, 'unlimited stock stays NULL through expiry');

  -- last unit: the second buyer is refused while held, and succeeds after expiry ---------------------------------------
  PERFORM pg_temp.check_that(pg_temp.reason(pg_temp.place(s, 'l1', jsonb_build_array(pg_temp.item(pl, 1, 10000)), 10000)) = 'ok', 'first buyer takes the last unit');
  PERFORM pg_temp.check_that(pg_temp.reason(pg_temp.place(s, 'l2', jsonb_build_array(pg_temp.item(pl, 1, 10000)), 10000)) = 'insufficient_stock', 'second buyer is refused');
  PERFORM pg_temp.check_that(pg_temp.stock_of(pl) = 0, 'stock never goes negative');
  PERFORM pg_temp.age('l1', 11);
  PERFORM pg_temp.check_that(pg_temp.reason(pg_temp.place(s, 'l3', jsonb_build_array(pg_temp.item(pl, 1, 10000)), 10000)) = 'ok'
    AND pg_temp.status_of('l1') = 'cancelled' AND pg_temp.stock_of(pl) = 0, 'after 10 minutes a new buyer sweeps the holder and gets the unit');

  -- not_received keeps its own, longer window -------------------------------------------------------------------------
  PERFORM pg_temp.place(s, 'nr', jsonb_build_array(pg_temp.item(pa, 1, 10000)), 10000);
  PERFORM pg_temp.submit(s, 'nr', '333333333333');
  PERFORM public.resolve_payment(s, v_owner, (SELECT id FROM public.orders WHERE status_token_hash = pg_temp.hash_of('nr')), 'not_received');
  PERFORM pg_temp.check_that((SELECT expires_at - now() = interval '1 hour' FROM public.orders WHERE status_token_hash = pg_temp.hash_of('nr')),
    'not_received gets the 1 hour resubmit window');

  -- legacy order: created under the old 1 hour window, backfill rule from migration 009 -------------------------------
  -- Four legacy orders as migration 008 left them (created 30 or 5 minutes ago under the old 1 hour window).
  pg := pg_temp.make_product(s, 10000, 10);
  PERFORM pg_temp.place(s, 'legacy', jsonb_build_array(pg_temp.item(pg, 1, 10000)), 10000);
  PERFORM pg_temp.place(s, 'young', jsonb_build_array(pg_temp.item(pg, 1, 10000)), 10000);
  PERFORM pg_temp.place(s, 'lsub', jsonb_build_array(pg_temp.item(pg, 1, 10000)), 10000);
  PERFORM pg_temp.place(s, 'lnr', jsonb_build_array(pg_temp.item(pg, 1, 10000)), 10000);
  PERFORM pg_temp.submit(s, 'lsub', '555555555555');
  PERFORM pg_temp.submit(s, 'lnr', '666666666666');
  PERFORM public.resolve_payment(s, v_owner, (SELECT id FROM public.orders WHERE status_token_hash = pg_temp.hash_of('lnr')), 'not_received');
  UPDATE public.orders SET created_at = now() - interval '30 minutes', expires_at = now() + interval '30 minutes'
   WHERE status_token_hash = pg_temp.hash_of('legacy');
  UPDATE public.orders SET created_at = now() - interval '5 minutes', expires_at = now() + interval '55 minutes'
   WHERE status_token_hash = pg_temp.hash_of('young');
  UPDATE public.orders SET created_at = now() - interval '30 minutes' WHERE status_token_hash = pg_temp.hash_of('lsub');
  UPDATE public.orders SET created_at = now() - interval '30 minutes' WHERE status_token_hash = pg_temp.hash_of('lnr');
  SELECT expires_at, updated_at INTO v_sub_expires, v_sub_updated FROM public.orders WHERE status_token_hash = pg_temp.hash_of('lsub');
  SELECT expires_at, updated_at INTO v_nr_expires, v_nr_updated FROM public.orders WHERE status_token_hash = pg_temp.hash_of('lnr');
  PERFORM pg_temp.check_that(v_sub_expires IS NULL AND pg_temp.status_of('lsub') = 'payment_submitted', 'precondition: legacy submitted order has no deadline');
  PERFORM pg_temp.check_that(pg_temp.status_of('lnr') = 'not_received' AND v_nr_expires = now() + interval '1 hour', 'precondition: legacy not_received order has the 1 hour retry deadline');

  -- The backfill statement below is copied VERBATIM from migration 009 (tests/unit/migration009.test.js fails if they differ).
  -- It runs inside this always-rolled-back sub-transaction, so it changes nothing permanently.
  UPDATE public.orders
     SET expires_at = created_at + public.order_expiry_interval(), updated_at = now()
   WHERE status = 'awaiting_payment' AND expires_at > created_at + public.order_expiry_interval();

  PERFORM pg_temp.check_that((SELECT expires_at = created_at + interval '10 minutes' FROM public.orders WHERE status_token_hash = pg_temp.hash_of('legacy')),
    'legacy awaiting_payment order gets created_at + 10 minutes');
  PERFORM pg_temp.check_that((SELECT expires_at = created_at + interval '10 minutes' AND expires_at > now() FROM public.orders WHERE status_token_hash = pg_temp.hash_of('young')),
    'a young legacy awaiting_payment order gets created_at + 10 minutes and is still live');
  PERFORM pg_temp.check_that((SELECT expires_at IS NOT DISTINCT FROM v_sub_expires AND updated_at = v_sub_updated AND status = 'payment_submitted'
      FROM public.orders WHERE status_token_hash = pg_temp.hash_of('lsub')), 'legacy payment_submitted order is untouched');
  PERFORM pg_temp.check_that((SELECT expires_at = v_nr_expires AND updated_at = v_nr_updated AND status = 'not_received'
      FROM public.orders WHERE status_token_hash = pg_temp.hash_of('lnr')), 'legacy not_received order keeps its 1 hour retry deadline');
  PERFORM pg_temp.check_that((SELECT count(*) = 2 FROM public.order_payment_attempts a JOIN public.orders o ON o.id = a.order_id
      WHERE o.id IN (SELECT id FROM public.orders WHERE status_token_hash IN (pg_temp.hash_of('lsub'), pg_temp.hash_of('lnr')))),
    'orders that already carry a UTR are left as they were');
  PERFORM pg_temp.check_that((SELECT count(*) = 0 FROM public.orders WHERE store_id = s AND status = 'awaiting_payment' AND expires_at > created_at + interval '10 minutes'),
    'no awaiting_payment order keeps a deadline beyond 10 minutes');

  PERFORM pg_temp.check_that(pg_temp.submit(s, 'young', '777777777777') = 'ok', 'a young legacy order can still submit its UTR');
  PERFORM pg_temp.check_that(pg_temp.submit(s, 'legacy', '444444444444') = 'expired', 'a legacy order past created_at + 10 minutes is rejected');
  PERFORM pg_temp.check_that(pg_temp.status_of('legacy') = 'cancelled', 'and expired');

  PERFORM pg_temp.check_that(NOT EXISTS (SELECT 1 FROM public.products WHERE id IN (pa, pu, pl) AND stock < 0), 'no finite stock is negative');

  RAISE EXCEPTION 'smoke complete, rolling back' USING ERRCODE = 'AB001';
EXCEPTION
  WHEN SQLSTATE 'AB001' THEN
    RETURN 'ALL CHECKS PASSED';
END;
$$;

SELECT pg_temp.smoke_009() AS result;
