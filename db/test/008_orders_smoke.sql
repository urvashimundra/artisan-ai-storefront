-- Manual smoke test for migration 008 (orders). Run the WHOLE file in the Supabase SQL editor (default postgres role),
-- AFTER migration 008 is applied. Success: one row with "ALL CHECKS PASSED". Failure: an error "FAIL: <check name>".
-- Leaves no data: everything runs in a sub-transaction that is always rolled back (sentinel SQLSTATE AB001).
-- Single-session behaviour only (state machine, stock, expiry, UTR rules, references, all-or-nothing, owner scoping).
-- The concurrent races (last unit, concurrent references, cancel vs expiry, concurrent duplicate UTR, expiry vs new order)
-- are in 008_orders_races.sql. All test rows use the prefix "smoke-008".

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
  SELECT jsonb_build_object('product_id', p_product, 'quantity', p_qty, 'expected_price_paise', p_price,
                            'title', 'Smoke item', 'title_lang', 'en')
$$;

CREATE OR REPLACE FUNCTION pg_temp.hash_of(p_label text) RETURNS text
LANGUAGE sql AS $$ SELECT encode(sha256(convert_to(p_label, 'UTF8')), 'hex') $$;

-- Places an order whose token hash is hash_of(p_label).
CREATE OR REPLACE FUNCTION pg_temp.place(p_store uuid, p_label text, p_items jsonb, p_total bigint,
                                         p_vpa text DEFAULT 'smoke.shop@okbank') RETURNS jsonb
LANGUAGE sql AS $$
  SELECT public.place_order(p_store, pg_temp.hash_of(p_label), p_vpa, 'Smoke Buyer', '919876543210', NULL, NULL, 'en', p_total, p_items)
$$;

CREATE OR REPLACE FUNCTION pg_temp.make_store(p_label text) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_owner uuid; v_store uuid;
BEGIN
  INSERT INTO public.owners (email, password_hash)
    VALUES ('smoke-008-' || p_label || '-' || gen_random_uuid() || '@example.invalid', 'x') RETURNING id INTO v_owner;
  INSERT INTO public.stores (owner_id, slug, name, default_language, story, upi_id)
    VALUES (v_owner, 'smoke-008-' || p_label || '-' || substr(gen_random_uuid()::text, 1, 8), 'Smoke 008', 'en', 'story', 'smoke.shop@okbank')
    RETURNING id INTO v_store;
  RETURN v_store;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.make_product(p_store uuid, p_price bigint, p_stock int, p_status text DEFAULT 'published') RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.products (id, store_id, status, price_paise, stock, image_path)
    VALUES (v_id, p_store, p_status, p_price, p_stock, 'smoke-008/' || v_id || '.jpg');
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.stock_of(p_product uuid) RETURNS int
LANGUAGE sql AS $$ SELECT stock FROM public.products WHERE id = p_product $$;

CREATE OR REPLACE FUNCTION pg_temp.order_id_of(p_label text) RETURNS uuid
LANGUAGE sql AS $$ SELECT id FROM public.orders WHERE status_token_hash = pg_temp.hash_of(p_label) $$;

CREATE OR REPLACE FUNCTION pg_temp.status_of(p_label text) RETURNS text
LANGUAGE sql AS $$ SELECT status FROM public.orders WHERE status_token_hash = pg_temp.hash_of(p_label) $$;

CREATE OR REPLACE FUNCTION pg_temp.reason(p_result jsonb) RETURNS text
LANGUAGE sql AS $$ SELECT CASE WHEN (p_result ->> 'ok')::boolean THEN 'ok' ELSE p_result ->> 'reason' END $$;

CREATE OR REPLACE FUNCTION pg_temp.submit(p_store uuid, p_label text, p_utr text) RETURNS text
LANGUAGE sql AS $$ SELECT pg_temp.reason(public.submit_payment_reference(p_store, pg_temp.hash_of(p_label), p_utr)) $$;

CREATE OR REPLACE FUNCTION pg_temp.make_overdue(p_label text) RETURNS void
LANGUAGE sql AS $$
  UPDATE public.orders SET expires_at = now() - interval '1 minute' WHERE status_token_hash = pg_temp.hash_of(p_label)
$$;

CREATE OR REPLACE FUNCTION pg_temp.smoke_008() RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  s1 uuid; s2 uuid; owner1 uuid; owner2 uuid;
  pa uuid; pb uuid; pu uuid; pdraft uuid; pother uuid;
  r jsonb; o uuid; n int;
BEGIN
  s1 := pg_temp.make_store('one');
  s2 := pg_temp.make_store('two');
  SELECT owner_id INTO owner1 FROM public.stores WHERE id = s1;
  SELECT owner_id INTO owner2 FROM public.stores WHERE id = s2;
  pa := pg_temp.make_product(s1, 25000, 5);
  pb := pg_temp.make_product(s1, 10050, 1);
  pu := pg_temp.make_product(s1, 9900, NULL);
  pdraft := pg_temp.make_product(s1, NULL, NULL, 'draft');
  pother := pg_temp.make_product(s2, 25000, 5);

  -- place_order: snapshots, reference, stock, expiry ------------------------------------------------
  r := pg_temp.place(s1, 'a1', jsonb_build_array(pg_temp.item(pa, 2, 25000)), 50000);
  PERFORM pg_temp.check_that((r ->> 'ok')::boolean AND r ->> 'reference' = 'AS1001', 'first reference is AS1001');
  PERFORM pg_temp.check_that(pg_temp.stock_of(pa) = 3, 'stock reserved (5 - 2)');
  PERFORM pg_temp.check_that((SELECT total_paise = 50000 AND payee_vpa = 'smoke.shop@okbank' AND status = 'awaiting_payment'
    AND utr_submissions = 0 AND utr IS NULL AND stock_restored_at IS NULL FROM public.orders WHERE id = (r ->> 'order_id')::uuid), 'order snapshot fields');
  PERFORM pg_temp.check_that((SELECT expires_at - now() = public.order_expiry_interval() FROM public.orders WHERE id = (r ->> 'order_id')::uuid), 'expiry is now + the order window (database time)');
  PERFORM pg_temp.check_that((SELECT unit_price_paise = 25000 AND quantity = 2 AND line_total_paise = 50000 AND stock_reserved
    FROM public.order_items WHERE order_id = (r ->> 'order_id')::uuid), 'item snapshot');
  r := pg_temp.place(s1, 'u1', jsonb_build_array(pg_temp.item(pu, 3, 9900)), 29700);
  PERFORM pg_temp.check_that(r ->> 'reference' = 'AS1002', 'second reference is AS1002');
  PERFORM pg_temp.check_that(pg_temp.stock_of(pu) IS NULL, 'unlimited stock stays NULL');
  PERFORM pg_temp.check_that(pg_temp.place(s2, 'x1', jsonb_build_array(pg_temp.item(pother, 1, 25000)), 25000) ->> 'reference' = 'AS1001',
    'references are per store');

  -- rejections write nothing ------------------------------------------------------------------------
  SELECT count(*) INTO n FROM public.orders WHERE store_id = s1;
  PERFORM pg_temp.check_that(pg_temp.reason(pg_temp.place(s1, 'bad1', jsonb_build_array(pg_temp.item(pa, 1, 24999)), 24999)) = 'price_changed', 'price changed rejected');
  PERFORM pg_temp.check_that(pg_temp.reason(pg_temp.place(s1, 'bad2', jsonb_build_array(pg_temp.item(pdraft, 1, 100)), 100)) = 'product_unavailable', 'draft product rejected');
  PERFORM pg_temp.check_that(pg_temp.reason(pg_temp.place(s1, 'bad3', jsonb_build_array(pg_temp.item(pother, 1, 25000)), 25000)) = 'product_unavailable', 'other store product rejected');
  PERFORM pg_temp.check_that(pg_temp.reason(pg_temp.place(s1, 'bad4', jsonb_build_array(pg_temp.item(pa, 1, 25000)), 25000, 'other@okbank')) = 'payee_changed', 'payee mismatch rejected');
  PERFORM pg_temp.check_that(pg_temp.reason(pg_temp.place(s1, 'bad5', jsonb_build_array(pg_temp.item(pa, 1, 25000)), 25001)) = 'total_mismatch', 'total mismatch rejected');
  PERFORM pg_temp.check_that(pg_temp.reason(pg_temp.place(s1, 'bad6', jsonb_build_array(pg_temp.item(pa, 4, 25000)), 100000)) = 'insufficient_stock', 'more than stock rejected');
  PERFORM pg_temp.check_that(pg_temp.reason(pg_temp.place(s1, 'bad7', jsonb_build_array(pg_temp.item(pa, 21, 25000)), 525000)) = 'invalid', 'quantity 21 rejected');
  PERFORM pg_temp.check_that(pg_temp.reason(pg_temp.place(s1, 'bad8', jsonb_build_array(pg_temp.item(pa, 0, 25000)), 0)) = 'invalid', 'quantity 0 rejected');
  PERFORM pg_temp.check_that(pg_temp.reason(pg_temp.place(s1, 'bad9', jsonb_build_array(pg_temp.item(pa, 1, 25000), pg_temp.item(pa, 1, 25000)), 50000)) = 'invalid', 'duplicate lines rejected');
  PERFORM pg_temp.check_that(pg_temp.reason(pg_temp.place(s1, 'bad10', '[]'::jsonb, 0)) = 'invalid', 'empty items rejected');
  PERFORM pg_temp.check_that(pg_temp.reason(public.place_order(gen_random_uuid(), pg_temp.hash_of('bad11'), 'smoke.shop@okbank', 'N', '919876543210', NULL, NULL, 'en', 100, jsonb_build_array(pg_temp.item(pa, 1, 25000)))) = 'store_not_found', 'unknown store rejected');
  PERFORM pg_temp.check_that((SELECT count(*) FROM public.orders WHERE store_id = s1) = n, 'rejections create no orders');
  PERFORM pg_temp.check_that(pg_temp.stock_of(pa) = 3, 'rejections keep stock');

  -- last unit (sequential) and multi-line all-or-nothing ------------------------------------------------
  PERFORM pg_temp.check_that(pg_temp.reason(pg_temp.place(s1, 'last1', jsonb_build_array(pg_temp.item(pb, 1, 10050)), 10050)) = 'ok', 'last unit sold');
  PERFORM pg_temp.check_that(pg_temp.reason(pg_temp.place(s1, 'last2', jsonb_build_array(pg_temp.item(pb, 1, 10050)), 10050)) = 'insufficient_stock', 'second buyer of last unit rejected');
  PERFORM pg_temp.check_that(pg_temp.stock_of(pb) = 0, 'stock is 0');
  SELECT last_number INTO n FROM public.store_order_counters WHERE store_id = s1;
  PERFORM pg_temp.check_that(pg_temp.reason(pg_temp.place(s1, 'multi1',
    jsonb_build_array(pg_temp.item(pa, 1, 25000), pg_temp.item(pb, 1, 10050)), 35050)) = 'insufficient_stock', 'multi-line with one short line rejected');
  PERFORM pg_temp.check_that(pg_temp.stock_of(pa) = 3, 'all-or-nothing: first line untouched');
  PERFORM pg_temp.check_that((SELECT last_number FROM public.store_order_counters WHERE store_id = s1) = n, 'rejected order burns no reference');
  PERFORM pg_temp.check_that(pg_temp.reason(pg_temp.place(s1, 'multi2',
    jsonb_build_array(pg_temp.item(pa, 1, 25000), pg_temp.item(pu, 2, 9900)), 44800)) = 'ok', 'multi-line order succeeds');
  PERFORM pg_temp.check_that(pg_temp.stock_of(pa) = 2 AND (SELECT count(*) FROM public.order_items WHERE order_id = pg_temp.order_id_of('multi2')) = 2, 'multi-line stock and items');

  -- cancel: owner, restores once, idempotent -----------------------------------------------------------------
  o := pg_temp.order_id_of('multi2');
  PERFORM pg_temp.check_that(pg_temp.reason(public.cancel_order(s1, o, 'owner', owner2, NULL)) = 'not_found', 'cancel by another owner rejected');
  PERFORM pg_temp.check_that(pg_temp.reason(public.cancel_order(s2, o, 'owner', owner2, NULL)) = 'not_found', 'cancel through another store rejected');
  PERFORM pg_temp.check_that(pg_temp.reason(public.cancel_order(s1, o, 'customer', NULL, pg_temp.hash_of('wrong'))) = 'not_found', 'customer cancel with wrong token rejected');
  PERFORM pg_temp.check_that(pg_temp.reason(public.cancel_order(s1, o, 'customer', NULL, pg_temp.hash_of('multi2'))) = 'ok', 'customer cancels awaiting order');
  PERFORM pg_temp.check_that(pg_temp.stock_of(pa) = 3 AND pg_temp.stock_of(pu) IS NULL, 'cancel restores stock');
  PERFORM pg_temp.check_that(pg_temp.reason(public.cancel_order(s1, o, 'owner', owner1, NULL)) = 'ok', 'cancel twice is idempotent');
  PERFORM pg_temp.check_that(pg_temp.stock_of(pa) = 3, 'cancel twice restores once');
  PERFORM pg_temp.check_that((SELECT cancel_reason = 'customer' AND stock_restored_at IS NOT NULL AND expires_at IS NULL FROM public.orders WHERE id = o), 'first cancel reason is kept');
  PERFORM pg_temp.check_that(pg_temp.reason(public.cancel_order(s1, o, 'bogus', owner1, NULL)) = 'invalid', 'unknown actor rejected');

  -- UTR submission -------------------------------------------------------------------------------------------
  PERFORM pg_temp.check_that(pg_temp.submit(s1, 'a1', '12345') = 'invalid', 'short UTR rejected');
  PERFORM pg_temp.check_that(pg_temp.submit(s1, 'a1', '12345678901a') = 'invalid', 'non-digit UTR rejected');
  PERFORM pg_temp.check_that(pg_temp.submit(s1, 'nope', '111111111111') = 'not_found', 'unknown token rejected');
  PERFORM pg_temp.check_that(pg_temp.submit(s2, 'a1', '111111111111') = 'not_found', 'token of another store rejected');
  PERFORM pg_temp.check_that(pg_temp.submit(s1, 'a1', '111111111111') = 'ok', 'UTR accepted');
  PERFORM pg_temp.check_that((SELECT status = 'payment_submitted' AND utr = '111111111111' AND utr_submissions = 1 AND expires_at IS NULL
    FROM public.orders WHERE id = pg_temp.order_id_of('a1')), 'submitted order fields');
  PERFORM pg_temp.check_that(pg_temp.submit(s1, 'a1', '111111111111') = 'ok', 'same UTR again is idempotent');
  PERFORM pg_temp.check_that((SELECT utr_submissions = 1 FROM public.orders WHERE id = pg_temp.order_id_of('a1')) AND
    (SELECT count(*) FROM public.order_payment_attempts WHERE order_id = pg_temp.order_id_of('a1')) = 1, 'idempotent repeat adds no attempt');
  PERFORM pg_temp.check_that(pg_temp.submit(s1, 'a1', '222222222222') = 'invalid_transition', 'different UTR while submitted rejected');
  PERFORM pg_temp.check_that(pg_temp.submit(s1, 'u1', '111111111111') = 'utr_in_use', 'same-store UTR reuse rejected');
  PERFORM pg_temp.check_that(pg_temp.status_of('u1') = 'awaiting_payment', 'failed UTR leaves the order untouched');
  PERFORM pg_temp.check_that(pg_temp.submit(s2, 'x1', '111111111111') = 'ok', 'same UTR allowed in a different store');
  PERFORM pg_temp.check_that(pg_temp.reason(public.cancel_order(s1, pg_temp.order_id_of('a1'), 'customer', NULL, pg_temp.hash_of('a1'))) = 'invalid_transition',
    'customer cannot cancel a submitted order');

  -- owner resolution: scoping, not_received (stock held, fresh window), resubmission limit ---------------------------
  o := pg_temp.order_id_of('a1');
  PERFORM pg_temp.check_that(pg_temp.reason(public.resolve_payment(s1, owner2, o, 'paid')) = 'not_found', 'another owner cannot resolve');
  PERFORM pg_temp.check_that(pg_temp.reason(public.resolve_payment(s2, owner2, o, 'paid')) = 'not_found', 'cross-store resolve rejected');
  PERFORM pg_temp.check_that(pg_temp.reason(public.resolve_payment(s1, owner1, o, 'cancelled')) = 'invalid', 'resolve_payment cannot cancel');
  PERFORM pg_temp.check_that(pg_temp.reason(public.resolve_payment(s1, owner1, pg_temp.order_id_of('u1'), 'paid')) = 'invalid_transition', 'cannot mark an unsubmitted order paid');
  PERFORM pg_temp.check_that(pg_temp.reason(public.resolve_payment(s1, owner1, o, 'not_received')) = 'ok', 'mark not received');
  PERFORM pg_temp.check_that(pg_temp.reason(public.resolve_payment(s1, owner1, o, 'not_received')) = 'ok', 'mark not received twice is idempotent');
  PERFORM pg_temp.check_that((SELECT status = 'not_received' AND expires_at - now() = interval '1 hour' FROM public.orders WHERE id = o), 'not_received gets a fresh window');
  PERFORM pg_temp.check_that(pg_temp.stock_of(pa) = 3, 'not_received holds stock');
  PERFORM pg_temp.check_that(pg_temp.submit(s1, 'a1', '111111111111') = 'utr_in_use', 'an old UTR can never be reused after a replacement');
  PERFORM pg_temp.check_that(pg_temp.submit(s1, 'a1', '333333333333') = 'ok', 'replacement UTR accepted (2nd submission)');
  PERFORM pg_temp.check_that(pg_temp.reason(public.resolve_payment(s1, owner1, o, 'not_received')) = 'ok', 'not received again');
  PERFORM pg_temp.check_that(pg_temp.submit(s1, 'a1', '444444444444') = 'ok', 'third submission accepted');
  PERFORM pg_temp.check_that(pg_temp.reason(public.resolve_payment(s1, owner1, o, 'not_received')) = 'ok', 'not received a third time');
  PERFORM pg_temp.check_that(pg_temp.submit(s1, 'a1', '555555555555') = 'attempt_limit', 'fourth submission rejected');
  PERFORM pg_temp.check_that((SELECT utr_submissions = 3 FROM public.orders WHERE id = o) AND
    (SELECT count(*) FROM public.order_payment_attempts WHERE order_id = o) = 3, 'three attempts recorded');
  PERFORM pg_temp.check_that(pg_temp.reason(public.cancel_order(s1, o, 'owner', owner1, NULL)) = 'ok', 'owner can cancel a not_received order');
  PERFORM pg_temp.check_that(pg_temp.stock_of(pa) = 5, 'cancel after not_received restores stock (3 + 2)');

  -- paid: terminal, never expires, never restores -------------------------------------------------------------------
  PERFORM pg_temp.place(s1, 'paid1', jsonb_build_array(pg_temp.item(pa, 2, 25000)), 50000);
  PERFORM pg_temp.submit(s1, 'paid1', '666666666666');
  o := pg_temp.order_id_of('paid1');
  PERFORM pg_temp.check_that(pg_temp.reason(public.resolve_payment(s1, owner1, o, 'paid')) = 'ok', 'mark paid');
  PERFORM pg_temp.check_that(pg_temp.reason(public.resolve_payment(s1, owner1, o, 'paid')) = 'ok', 'mark paid twice is idempotent');
  PERFORM pg_temp.check_that(pg_temp.reason(public.resolve_payment(s1, owner1, o, 'not_received')) = 'invalid_transition', 'paid cannot become not_received');
  PERFORM pg_temp.check_that(pg_temp.reason(public.cancel_order(s1, o, 'owner', owner1, NULL)) = 'invalid_transition', 'paid cannot be cancelled by the owner');
  PERFORM pg_temp.check_that(pg_temp.reason(public.cancel_order(s1, o, 'customer', NULL, pg_temp.hash_of('paid1'))) = 'invalid_transition', 'paid cannot be cancelled by the customer');
  PERFORM pg_temp.check_that(pg_temp.submit(s1, 'paid1', '777777777777') = 'invalid_transition', 'paid cannot receive a UTR');
  PERFORM pg_temp.check_that(public.expire_overdue_orders(s1) >= 0 AND pg_temp.status_of('paid1') = 'paid' AND pg_temp.stock_of(pa) = 3, 'sweeping never touches paid');
  PERFORM pg_temp.check_that((SELECT paid_at IS NOT NULL AND expires_at IS NULL AND stock_restored_at IS NULL FROM public.orders WHERE id = o), 'paid fields');

  -- expiry: restores once, scoped to the store, vs new order, vs submit ----------------------------------------------------
  PERFORM pg_temp.place(s1, 'exp1', jsonb_build_array(pg_temp.item(pa, 3, 25000)), 75000);
  PERFORM pg_temp.check_that(pg_temp.stock_of(pa) = 0, 'all remaining stock reserved');
  PERFORM pg_temp.make_overdue('exp1');
  PERFORM pg_temp.check_that(public.expire_overdue_orders(s2) = 0 AND pg_temp.status_of('exp1') = 'awaiting_payment', 'sweep of another store leaves it alone');
  PERFORM pg_temp.check_that(public.expire_overdue_orders(s1) = 1, 'sweep expires the overdue order');
  PERFORM pg_temp.check_that(pg_temp.stock_of(pa) = 3 AND pg_temp.status_of('exp1') = 'cancelled'
    AND (SELECT cancel_reason = 'expired' FROM public.orders WHERE id = pg_temp.order_id_of('exp1')), 'expiry restores stock and records the reason');
  PERFORM pg_temp.check_that(public.expire_overdue_orders(s1) = 0 AND pg_temp.stock_of(pa) = 3, 'second sweep restores nothing more');
  PERFORM pg_temp.check_that(pg_temp.reason(public.cancel_order(s1, pg_temp.order_id_of('exp1'), 'owner', owner1, NULL)) = 'ok' AND pg_temp.stock_of(pa) = 3,
    'cancel after expiry is idempotent and restores nothing');

  PERFORM pg_temp.place(s1, 'exp2', jsonb_build_array(pg_temp.item(pa, 3, 25000)), 75000);
  PERFORM pg_temp.make_overdue('exp2');
  PERFORM pg_temp.check_that(pg_temp.reason(pg_temp.place(s1, 'new1', jsonb_build_array(pg_temp.item(pa, 3, 25000)), 75000)) = 'ok',
    'new order sweeps overdue holders of the same product first');
  PERFORM pg_temp.check_that(pg_temp.status_of('exp2') = 'cancelled' AND pg_temp.stock_of(pa) = 0, 'expired order released, new order holds the stock');

  PERFORM pg_temp.make_overdue('new1');
  PERFORM pg_temp.check_that(pg_temp.submit(s1, 'new1', '888888888888') = 'expired', 'submitting after expiry is rejected');
  PERFORM pg_temp.check_that(pg_temp.status_of('new1') = 'cancelled' AND pg_temp.stock_of(pa) = 3, 'late submit cancels the order and restores stock once');

  PERFORM pg_temp.place(s1, 'exp3', jsonb_build_array(pg_temp.item(pa, 1, 25000)), 25000);
  PERFORM pg_temp.submit(s1, 'exp3', '999999999999');
  PERFORM public.resolve_payment(s1, owner1, pg_temp.order_id_of('exp3'), 'not_received');
  PERFORM pg_temp.make_overdue('exp3');
  PERFORM pg_temp.check_that(public.expire_overdue_orders(s1) = 1 AND pg_temp.status_of('exp3') = 'cancelled' AND pg_temp.stock_of(pa) = 3,
    'overdue not_received orders expire and restore stock');
  PERFORM pg_temp.check_that(pg_temp.place(s1, 'pay-sub', jsonb_build_array(pg_temp.item(pa, 1, 25000)), 25000) IS NOT NULL
    AND pg_temp.submit(s1, 'pay-sub', '101010101010') = 'ok', 'payment_submitted orders have no expiry');
  PERFORM pg_temp.check_that((SELECT expires_at IS NULL FROM public.orders WHERE id = pg_temp.order_id_of('pay-sub')), 'payment_submitted expiry cleared');

  -- table constraints reject inconsistent rows -------------------------------------------------------------------------------
  BEGIN
    UPDATE public.orders SET status = 'paid' WHERE id = pg_temp.order_id_of('pay-sub');
    RAISE EXCEPTION 'FAIL: paid without paid_at accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.orders SET status = 'cancelled', cancel_reason = 'owner', expires_at = NULL WHERE id = pg_temp.order_id_of('pay-sub');
    RAISE EXCEPTION 'FAIL: cancelled without stock_restored_at accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.orders SET utr_submissions = 4 WHERE id = pg_temp.order_id_of('pay-sub');
    RAISE EXCEPTION 'FAIL: fourth submission accepted by the table';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.order_payment_attempts (order_id, store_id, utr) VALUES (pg_temp.order_id_of('pay-sub'), s1, '101010101010');
    RAISE EXCEPTION 'FAIL: duplicate UTR in the same store accepted by the table';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  RAISE EXCEPTION 'smoke complete, rolling back' USING ERRCODE = 'AB001';
EXCEPTION
  WHEN SQLSTATE 'AB001' THEN
    RETURN 'ALL CHECKS PASSED';
END;
$$;

SELECT pg_temp.smoke_008() AS result;
