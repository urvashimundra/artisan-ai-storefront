-- Manual smoke test for migration 011 (email limits under concurrency, encrypted order link). Run the WHOLE file in the Supabase SQL
-- editor (default postgres role), AFTER migrations 008, 009, 010 and 011. Success: one row "ALL CHECKS PASSED". Failure: "FAIL: <name>".
-- Leaves no data: everything runs in a sub-transaction that is always rolled back (sentinel SQLSTATE AB001). Test rows use the prefix
-- "smoke-011" and example.invalid. This file checks single-session behaviour; the real two-session concurrency cases are in
-- 011_email_races.sql. Run 010_email_smoke.sql as well: it still has to pass after 011 (limits and hooks are unchanged).

CREATE OR REPLACE FUNCTION pg_temp.check_that(p_ok boolean, p_name text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN
    RAISE EXCEPTION 'FAIL: %', p_name;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.hash_of(p_label text) RETURNS text
LANGUAGE sql AS $$ SELECT encode(sha256(convert_to(p_label, 'UTF8')), 'hex') $$;

CREATE OR REPLACE FUNCTION pg_temp.make_store() RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_owner uuid; v_store uuid;
BEGIN
  INSERT INTO public.owners (email, password_hash) VALUES ('smoke-011-' || gen_random_uuid() || '@example.invalid', 'x') RETURNING id INTO v_owner;
  INSERT INTO public.stores (owner_id, slug, name, default_language, story, upi_id)
    VALUES (v_owner, 'smoke-011-' || substr(gen_random_uuid()::text, 1, 8), 'Smoke 011', 'en', 'story', 'smoke.shop@okbank') RETURNING id INTO v_store;
  RETURN v_store;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.make_product(p_store uuid) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.products (id, store_id, status, price_paise, stock, image_path)
    VALUES (v_id, p_store, 'published', 10000, 20, 'smoke-011/' || v_id || '.jpg');
  RETURN v_id;
END;
$$;

-- p_enc is the ciphertext the app would pass (any valid base64url text stands in for it here).
CREATE OR REPLACE FUNCTION pg_temp.place(p_store uuid, p_label text, p_product uuid, p_email text, p_enc text) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT public.place_order(p_store, pg_temp.hash_of(p_label), 'smoke.shop@okbank', 'Smoke Buyer', '919876543210', p_email, 'Smoke address', 'en', 10000,
    jsonb_build_array(jsonb_build_object('product_id', p_product, 'quantity', 1, 'expected_price_paise', 10000, 'title', 'Smoke item', 'title_lang', 'en')),
    p_enc)
$$;

CREATE OR REPLACE FUNCTION pg_temp.order_id(p_label text) RETURNS uuid
LANGUAGE sql AS $$ SELECT id FROM public.orders WHERE status_token_hash = pg_temp.hash_of(p_label) $$;

-- Number of customer emails of this order whose payload carries exactly this ciphertext.
CREATE OR REPLACE FUNCTION pg_temp.with_enc(p_order uuid, p_enc text) RETURNS bigint
LANGUAGE sql AS $$
  SELECT count(*) FROM public.email_outbox
   WHERE dedupe_key LIKE 'order\_%:' || p_order::text || '%' AND payload ->> 'token_enc' = p_enc
$$;

CREATE OR REPLACE FUNCTION pg_temp.advisory_held() RETURNS boolean
LANGUAGE sql AS $$
  SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND classid = 0 AND objid = 7010011 AND granted)
$$;

CREATE OR REPLACE FUNCTION pg_temp.smoke_011() RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  s uuid; v_owner uuid; p uuid; o uuid; v_enc text := 'smoke011ciphertextAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_-';
  v_before bigint; i int;
BEGIN
  -- Column and constraint ----------------------------------------------------------------------
  PERFORM pg_temp.check_that(EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_status_token_enc_check'), 'status_token_enc check exists');
  s := pg_temp.make_store();
  SELECT owner_id INTO v_owner FROM public.stores WHERE id = s;
  p := pg_temp.make_product(s);

  -- Signatures ---------------------------------------------------------------------------------
  PERFORM pg_temp.check_that(to_regprocedure('public.submit_payment_reference(uuid, text, text, text)') IS NULL, 'the 4-argument submit_payment_reference is gone');
  PERFORM pg_temp.check_that(to_regprocedure('public.email_enqueue_order(uuid, text, text, text)') IS NULL, 'the 4-argument email_enqueue_order is gone');
  PERFORM pg_temp.check_that(to_regprocedure('public.submit_payment_reference(uuid, text, text)') IS NOT NULL, 'the 3-argument submit_payment_reference exists');

  -- The lock is not held before any email function runs, and is held after the first order function --------------
  PERFORM pg_temp.check_that(NOT pg_temp.advisory_held(), 'no email lock before any order function');
  PERFORM pg_temp.check_that((pg_temp.place(s, 'a', p, 'buyer-a@example.invalid', v_enc) ->> 'ok')::boolean, 'order a placed with ciphertext');
  PERFORM pg_temp.check_that(pg_temp.advisory_held(), 'place_order holds the email serialization lock');
  o := pg_temp.order_id('a');
  PERFORM pg_temp.check_that((SELECT status_token_enc = v_enc FROM public.orders WHERE id = o), 'the ciphertext is stored on the order');
  PERFORM pg_temp.check_that(NOT EXISTS (SELECT 1 FROM public.orders WHERE id = o AND status_token_enc = pg_temp.hash_of('a')), 'and it is not the hash');

  -- All six customer emails carry the ciphertext ---------------------------------------------------------------
  PERFORM pg_temp.check_that(pg_temp.with_enc(o, v_enc) = 1, 'order_placed carries it');
  PERFORM pg_temp.check_that(public.submit_payment_reference(s, pg_temp.hash_of('a'), '111111111111') ->> 'ok' = 'true', 'utr accepted (3 arguments)');
  PERFORM pg_temp.check_that(public.resolve_payment(s, v_owner, o, 'not_received') ->> 'ok' = 'true', 'not received');
  PERFORM pg_temp.check_that(public.submit_payment_reference(s, pg_temp.hash_of('a'), '222222222222') ->> 'ok' = 'true', 'second utr accepted');
  PERFORM pg_temp.check_that(public.resolve_payment(s, v_owner, o, 'paid') ->> 'ok' = 'true', 'paid');
  PERFORM pg_temp.check_that(pg_temp.with_enc(o, v_enc) = 5, 'placed, received x2, not found and confirmed all carry it');
  PERFORM pg_temp.check_that((SELECT count(*) = 0 FROM public.email_outbox WHERE dedupe_key LIKE 'seller\_%:' || o::text || '%' AND payload ->> 'token_enc' IS NOT NULL),
    'seller alerts never carry the customer token');

  PERFORM pg_temp.check_that((pg_temp.place(s, 'b', p, 'buyer-b@example.invalid', v_enc || 'b') ->> 'ok')::boolean, 'order b placed');
  PERFORM pg_temp.check_that(public.cancel_order(s, pg_temp.order_id('b'), 'customer', NULL, pg_temp.hash_of('b')) ->> 'ok' = 'true', 'b cancelled');
  PERFORM pg_temp.check_that((SELECT count(*) = 1 FROM public.email_outbox WHERE dedupe_key = 'order_cancelled:' || pg_temp.order_id('b')::text AND payload ->> 'token_enc' = v_enc || 'b'),
    'order_cancelled carries it');

  PERFORM pg_temp.check_that((pg_temp.place(s, 'c', p, 'buyer-c@example.invalid', v_enc || 'c') ->> 'ok')::boolean, 'order c placed');
  UPDATE public.orders SET expires_at = now() - interval '1 minute' WHERE id = pg_temp.order_id('c');
  PERFORM pg_temp.check_that(public.expire_overdue_orders(s) >= 1, 'c expired by the sweep');
  PERFORM pg_temp.check_that((SELECT count(*) = 1 FROM public.email_outbox WHERE dedupe_key = 'order_expired:' || pg_temp.order_id('c')::text AND payload ->> 'token_enc' = v_enc || 'c'),
    'order_expired carries it');

  -- An order without ciphertext (older orders, or no key configured) still queues, with a JSON null -----------------
  PERFORM pg_temp.check_that((pg_temp.place(s, 'd', p, 'buyer-d@example.invalid', NULL) ->> 'ok')::boolean, 'order d placed without ciphertext');
  PERFORM pg_temp.check_that((SELECT payload -> 'token_enc' = 'null'::jsonb FROM public.email_outbox WHERE dedupe_key = 'order_placed:' || pg_temp.order_id('d')::text),
    'its email has a null token_enc');

  -- A bad ciphertext is refused by the CHECK and nothing is left behind ----------------------------------------------
  v_before := (SELECT count(*) FROM public.orders WHERE store_id = s);
  BEGIN
    PERFORM pg_temp.place(s, 'e', p, 'buyer-e@example.invalid', 'not valid base64url!');
    PERFORM pg_temp.check_that(false, 'a malformed ciphertext must be refused');
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  PERFORM pg_temp.check_that((SELECT count(*) FROM public.orders WHERE store_id = s) = v_before, 'a refused ciphertext leaves no order');

  -- Limits are unchanged (6 per recipient per hour) ---------------------------------------------------------------------
  FOR i IN 1..6 LOOP
    PERFORM pg_temp.check_that(public.email_enqueue(NULL, 'order_placed', 'lim@example.invalid', 'en', 'S', 'B', '{}'::jsonb, NULL, 'smoke-011-l' || i) = 'queued', 'limit email ' || i);
  END LOOP;
  PERFORM pg_temp.check_that(public.email_enqueue(NULL, 'order_placed', 'LIM@example.invalid', 'en', 'S', 'B', '{}'::jsonb, NULL, 'smoke-011-l7') = 'limited_recipient', 'the 7th is limited');
  PERFORM pg_temp.check_that(public.email_enqueue(NULL, 'order_placed', 'lim@example.invalid', 'en', 'S', 'B', '{}'::jsonb, NULL, 'smoke-011-l1') = 'duplicate', 'a duplicate key is still a no-op');

  -- Security properties of every function this migration touched ----------------------------------------------------
  PERFORM pg_temp.check_that(NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosecdef
      AND proname IN ('email_serialize', 'email_enqueue', 'email_enqueue_order', 'order_cancel_locked', 'expire_overdue_orders',
                      'place_order', 'submit_payment_reference', 'resolve_payment', 'cancel_order', 'claim_due_emails', 'finish_email')),
    'none of these functions is SECURITY DEFINER');

  RAISE EXCEPTION 'smoke complete, rolling back' USING ERRCODE = 'AB001';
EXCEPTION
  WHEN SQLSTATE 'AB001' THEN
    RETURN 'ALL CHECKS PASSED';
END;
$$;

SELECT pg_temp.smoke_011() AS result;
