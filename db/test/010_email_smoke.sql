-- Manual smoke test for migration 010 (email outbox). Run the WHOLE file in the Supabase SQL editor (default postgres role),
-- AFTER migrations 008, 009 and 010 (it also passes after 011; 011_email_hardening_smoke.sql adds the 011 checks). Success: one row "ALL CHECKS PASSED". Failure: error "FAIL: <check name>".
-- Leaves no data: everything runs in a sub-transaction that is always rolled back (sentinel SQLSTATE AB001). Test rows use the
-- prefix "smoke-010" and the reserved domain example.invalid. Claims are rolled back too and assertions only look at the test's
-- own rows, so real queued emails do not disturb it. The global-cap check counts ALL rows of the last hour, so run this on a
-- quiet database (it inserts its own 150 rows to reach the cap, inside the rolled-back transaction).
-- Covers: every CHECK (valid accepted, invalid rejected), the order hooks (one email per transition, none for a failed or
-- repeated transition, rollback when queuing fails), dedupe, all limits, claim, lease expiry, retry, dead paths.

CREATE OR REPLACE FUNCTION pg_temp.check_that(p_ok boolean, p_name text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN
    RAISE EXCEPTION 'FAIL: %', p_name;
  END IF;
END;
$$;

-- True when the outbox row is rejected by a CHECK or unique constraint; false when it was inserted.
CREATE OR REPLACE FUNCTION pg_temp.rejects_row(p_kind text, p_to text, p_lang text, p_subject text, p_body text, p_key text,
                                               p_status text, p_attempts int, p_error text) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    INSERT INTO public.email_outbox (kind, to_email, language, subject, body, dedupe_key, status, attempts, last_error_code)
      VALUES (p_kind, p_to, p_lang, p_subject, p_body, p_key, p_status, p_attempts, p_error);
    RETURN false;
  EXCEPTION WHEN check_violation OR unique_violation THEN
    RETURN true;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.rejects_contact(p_name text, p_email text, p_message text) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    INSERT INTO public.contact_messages (name, email, message) VALUES (p_name, p_email, p_message);
    RETURN false;
  EXCEPTION WHEN check_violation THEN
    RETURN true;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.hash_of(p_label text) RETURNS text
LANGUAGE sql AS $$ SELECT encode(sha256(convert_to(p_label, 'UTF8')), 'hex') $$;

CREATE OR REPLACE FUNCTION pg_temp.make_store() RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_owner uuid; v_store uuid;
BEGIN
  INSERT INTO public.owners (email, password_hash) VALUES ('smoke-010-' || gen_random_uuid() || '@example.invalid', 'x') RETURNING id INTO v_owner;
  INSERT INTO public.stores (owner_id, slug, name, default_language, story, upi_id)
    VALUES (v_owner, 'smoke-010-' || substr(gen_random_uuid()::text, 1, 8), 'Smoke 010', 'en', 'story', 'smoke.shop@okbank') RETURNING id INTO v_store;
  RETURN v_store;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.make_product(p_store uuid, p_stock int) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.products (id, store_id, status, price_paise, stock, image_path)
    VALUES (v_id, p_store, 'published', 10000, p_stock, 'smoke-010/' || v_id || '.jpg');
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.place(p_store uuid, p_label text, p_product uuid, p_email text, p_lang text, p_total bigint DEFAULT 10000) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT public.place_order(p_store, pg_temp.hash_of(p_label), 'smoke.shop@okbank', 'Smoke Buyer', '919876543210', p_email, 'Smoke address', p_lang, p_total,
    jsonb_build_array(jsonb_build_object('product_id', p_product, 'quantity', 1, 'expected_price_paise', 10000, 'title', 'Smoke item', 'title_lang', 'en')))
$$;

CREATE OR REPLACE FUNCTION pg_temp.order_id(p_label text) RETURNS uuid
LANGUAGE sql AS $$ SELECT id FROM public.orders WHERE status_token_hash = pg_temp.hash_of(p_label) $$;

CREATE OR REPLACE FUNCTION pg_temp.emails(p_order uuid, p_kind text) RETURNS bigint
LANGUAGE sql AS $$ SELECT count(*) FROM public.email_outbox WHERE dedupe_key LIKE p_kind || ':' || p_order::text || '%' $$;

CREATE OR REPLACE FUNCTION pg_temp.enqueue(p_key text, p_to text, p_kind text DEFAULT 'order_placed') RETURNS text
LANGUAGE sql AS $$ SELECT public.email_enqueue(NULL, p_kind, p_to, 'en', 'Subject', 'Body', '{}'::jsonb, NULL, p_key) $$;

CREATE OR REPLACE FUNCTION pg_temp.row_for(p_key text, p_to text) RETURNS uuid
LANGUAGE sql AS $$
  INSERT INTO public.email_outbox (kind, to_email, dedupe_key, body) VALUES ('contact_inbox', p_to, p_key, 'keep') RETURNING id
$$;

CREATE OR REPLACE FUNCTION pg_temp.claimed(p_id uuid) RETURNS bigint
LANGUAGE sql AS $$ SELECT count(*) FROM public.claim_due_emails(1000, 300) c WHERE c.id = p_id $$;

-- Test 1: constraints ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.smoke_constraints() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_temp.check_that(NOT pg_temp.rejects_row('contact_inbox', 'a@example.invalid', 'gu', 'ok', 'ok', 'smoke-010-valid', 'queued', 0, NULL), 'a valid row is accepted');
  PERFORM pg_temp.check_that(pg_temp.rejects_row('smoke-010-valid-dup', 'a@example.invalid', 'en', '', '', 'smoke-010-x', 'queued', 0, NULL), 'unknown kind rejected');
  PERFORM pg_temp.check_that(pg_temp.rejects_row('contact_inbox', 'a@example.invalid', 'en', '', '', 'smoke-010-valid', 'queued', 0, NULL), 'duplicate dedupe key rejected');
  PERFORM pg_temp.check_that(pg_temp.rejects_row('order_placed', 'not-an-email', 'en', '', '', 'smoke-010-k2', 'queued', 0, NULL), 'bad recipient rejected');
  PERFORM pg_temp.check_that(pg_temp.rejects_row('order_placed', 'a b@example.invalid', 'en', '', '', 'smoke-010-k2b', 'queued', 0, NULL), 'recipient with a space rejected');
  PERFORM pg_temp.check_that(pg_temp.rejects_row('order_placed', 'a@example.invalid', 'fr', '', '', 'smoke-010-k3', 'queued', 0, NULL), 'unknown language rejected');
  PERFORM pg_temp.check_that(pg_temp.rejects_row('order_placed', 'a@example.invalid', 'en', E'a\nb', '', 'smoke-010-k4', 'queued', 0, NULL), 'LF in subject rejected');
  PERFORM pg_temp.check_that(pg_temp.rejects_row('order_placed', 'a@example.invalid', 'en', E'a\rb', '', 'smoke-010-k5', 'queued', 0, NULL), 'CR in subject rejected');
  PERFORM pg_temp.check_that(pg_temp.rejects_row('order_placed', 'a@example.invalid', 'en', repeat('x', 201), '', 'smoke-010-k6', 'queued', 0, NULL), 'subject over 200 rejected');
  PERFORM pg_temp.check_that(NOT pg_temp.rejects_row('order_placed', 'a@example.invalid', 'en', repeat('x', 200), repeat('y', 4000), 'smoke-010-k7', 'queued', 0, NULL), 'subject 200 and body 4000 accepted');
  PERFORM pg_temp.check_that(pg_temp.rejects_row('order_placed', 'a@example.invalid', 'en', '', repeat('y', 4001), 'smoke-010-k8', 'queued', 0, NULL), 'body over 4000 rejected');
  PERFORM pg_temp.check_that(pg_temp.rejects_row('order_placed', 'a@example.invalid', 'en', '', '', 'smoke-010-k9', 'lost', 0, NULL), 'unknown status rejected');
  PERFORM pg_temp.check_that(pg_temp.rejects_row('order_placed', 'a@example.invalid', 'en', '', '', 'smoke-010-k10', 'queued', 6, NULL), 'attempts above 5 rejected');
  PERFORM pg_temp.check_that(pg_temp.rejects_row('order_placed', 'a@example.invalid', 'en', '', '', 'smoke-010-k11', 'queued', 0, 'relay said no'), 'free-text error code rejected');
  PERFORM pg_temp.check_that(NOT pg_temp.rejects_row('order_placed', 'a@example.invalid', 'en', '', '', 'smoke-010-k12', 'dead', 5, 'RELAY_REJECTED'), 'short error code accepted');
  PERFORM pg_temp.check_that(pg_temp.rejects_row('order_placed', 'a@example.invalid', 'en', '', '', '', 'queued', 0, NULL), 'empty dedupe key rejected');
  PERFORM pg_temp.check_that(NOT pg_temp.rejects_contact('N', 'v@example.invalid', 'hello'), 'valid contact message accepted');
  PERFORM pg_temp.check_that(pg_temp.rejects_contact('', 'v@example.invalid', 'hello'), 'empty contact name rejected');
  PERFORM pg_temp.check_that(pg_temp.rejects_contact(repeat('n', 81), 'v@example.invalid', 'hello'), 'contact name over 80 rejected');
  PERFORM pg_temp.check_that(pg_temp.rejects_contact('N', 'bad', 'hello'), 'bad contact email rejected');
  PERFORM pg_temp.check_that(pg_temp.rejects_contact('N', 'v@example.invalid', ''), 'empty contact message rejected');
  PERFORM pg_temp.check_that(pg_temp.rejects_contact('N', 'v@example.invalid', repeat('m', 2001)), 'contact message over 2000 rejected');
  PERFORM pg_temp.check_that(NOT pg_temp.rejects_contact('N', 'v@example.invalid', repeat('m', 2000)), 'contact message of 2000 accepted');
END;
$$;

-- Test 2: order hooks ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.smoke_order_hooks() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  s uuid; v_owner uuid; p uuid; o uuid; v_owner_email text; v_total bigint;
BEGIN
  s := pg_temp.make_store();
  SELECT owner_id INTO v_owner FROM public.stores WHERE id = s;
  SELECT email INTO v_owner_email FROM public.owners WHERE id = v_owner;
  p := pg_temp.make_product(s, 10);

  PERFORM pg_temp.check_that((pg_temp.place(s, 'a', p, 'buyer@example.invalid', 'gu') ->> 'ok')::boolean, 'order a placed');
  o := pg_temp.order_id('a');
  PERFORM pg_temp.check_that(pg_temp.emails(o, 'order_placed') = 1, 'placing queues exactly one order_placed row');
  PERFORM pg_temp.check_that((SELECT to_email = 'buyer@example.invalid' AND language = 'gu' AND subject = '' AND body = ''
      AND payload ->> 'slug' LIKE 'smoke-010-%' AND payload ->> 'reference' LIKE 'AS%'
      FROM public.email_outbox WHERE dedupe_key = 'order_placed:' || o::text), 'placed row: customer address, order language, payload with the order facts');

  PERFORM pg_temp.check_that(public.submit_payment_reference(s, pg_temp.hash_of('a'), '111111111111') ->> 'ok' = 'true', 'utr accepted');
  PERFORM pg_temp.check_that(pg_temp.emails(o, 'order_payment_received') = 1 AND pg_temp.emails(o, 'seller_payment_submitted') = 1,
    'submitting queues the customer and the seller email once');
  PERFORM pg_temp.check_that((SELECT to_email = v_owner_email AND language = 'en' FROM public.email_outbox WHERE dedupe_key LIKE 'seller_payment_submitted:' || o::text || '%'),
    'seller alert goes to the owner account email, in English');
  PERFORM pg_temp.check_that(public.submit_payment_reference(s, pg_temp.hash_of('a'), '111111111111') ->> 'already' = 'true', 'the same utr again is an idempotent success');
  PERFORM pg_temp.check_that(pg_temp.emails(o, 'order_payment_received') = 1 AND pg_temp.emails(o, 'seller_payment_submitted') = 1, 'the idempotent repeat queues nothing');
  PERFORM pg_temp.check_that(public.submit_payment_reference(s, pg_temp.hash_of('a'), 'abc') ->> 'reason' = 'invalid', 'a malformed utr is refused');
  PERFORM pg_temp.check_that(pg_temp.emails(o, 'order_payment_received') = 1, 'a refused utr queues nothing');

  PERFORM pg_temp.check_that(public.resolve_payment(s, v_owner, o, 'not_received') ->> 'ok' = 'true', 'owner marks not received');
  PERFORM pg_temp.check_that(pg_temp.emails(o, 'order_payment_not_found') = 1, 'not received queues one payment_not_found row');
  PERFORM pg_temp.check_that(public.resolve_payment(s, v_owner, o, 'not_received') ->> 'already' = 'true', 'marking again is idempotent');
  PERFORM pg_temp.check_that(pg_temp.emails(o, 'order_payment_not_found') = 1, 'the repeat queues nothing');

  PERFORM pg_temp.check_that(public.submit_payment_reference(s, pg_temp.hash_of('a'), '222222222222') ->> 'ok' = 'true', 'second utr accepted');
  PERFORM pg_temp.check_that(pg_temp.emails(o, 'order_payment_received') = 2 AND pg_temp.emails(o, 'seller_payment_submitted') = 2,
    'a second attempt queues a second pair (the attempt number is part of the key)');
  PERFORM pg_temp.check_that(public.resolve_payment(s, v_owner, o, 'paid') ->> 'ok' = 'true', 'owner confirms');
  PERFORM pg_temp.check_that(pg_temp.emails(o, 'order_confirmed') = 1, 'confirming queues one order_confirmed row');
  PERFORM pg_temp.check_that(public.resolve_payment(s, v_owner, o, 'paid') ->> 'already' = 'true' AND pg_temp.emails(o, 'order_confirmed') = 1, 'confirming again queues nothing');
  PERFORM pg_temp.check_that(public.cancel_order(s, o, 'owner', v_owner, NULL) ->> 'reason' = 'invalid_transition', 'a paid order cannot be cancelled');
  PERFORM pg_temp.check_that(pg_temp.emails(o, 'order_cancelled') = 0, 'a refused cancel queues nothing');

  PERFORM pg_temp.check_that((pg_temp.place(s, 'b', p, 'buyer-b@example.invalid', 'hi') ->> 'ok')::boolean, 'order b placed');
  o := pg_temp.order_id('b');
  PERFORM pg_temp.check_that(public.cancel_order(s, o, 'customer', NULL, pg_temp.hash_of('b')) ->> 'ok' = 'true', 'customer cancels');
  PERFORM pg_temp.check_that(pg_temp.emails(o, 'order_cancelled') = 1 AND pg_temp.emails(o, 'order_expired') = 0, 'cancelling queues one order_cancelled row');
  PERFORM pg_temp.check_that(public.cancel_order(s, o, 'customer', NULL, pg_temp.hash_of('b')) ->> 'already' = 'true' AND pg_temp.emails(o, 'order_cancelled') = 1,
    'cancelling twice queues nothing more');

  PERFORM pg_temp.check_that((pg_temp.place(s, 'c', p, 'buyer-c@example.invalid', 'en') ->> 'ok')::boolean, 'order c placed');
  o := pg_temp.order_id('c');
  UPDATE public.orders SET expires_at = now() - interval '1 minute' WHERE id = o;
  PERFORM pg_temp.check_that(public.expire_overdue_orders(s) >= 1, 'the sweep expires order c');
  PERFORM pg_temp.check_that(pg_temp.emails(o, 'order_expired') = 1 AND pg_temp.emails(o, 'order_cancelled') = 0, 'the sweep queues one order_expired row');
  PERFORM public.expire_overdue_orders(s);
  PERFORM pg_temp.check_that(pg_temp.emails(o, 'order_expired') = 1, 'a second sweep queues nothing more');

  PERFORM pg_temp.check_that((pg_temp.place(s, 'd', p, 'buyer-d@example.invalid', 'en') ->> 'ok')::boolean, 'order d placed');
  o := pg_temp.order_id('d');
  UPDATE public.orders SET expires_at = now() - interval '1 minute' WHERE id = o;
  PERFORM pg_temp.check_that(public.submit_payment_reference(s, pg_temp.hash_of('d'), '333333333333') ->> 'reason' = 'expired', 'a late utr is refused as expired');
  PERFORM pg_temp.check_that(pg_temp.emails(o, 'order_expired') = 1 AND pg_temp.emails(o, 'order_payment_received') = 0, 'lazy expiry queues order_expired and no payment email');

  PERFORM pg_temp.check_that((pg_temp.place(s, 'e', p, NULL, 'en') ->> 'ok')::boolean, 'order e (no email address) placed');
  o := pg_temp.order_id('e');
  PERFORM pg_temp.check_that(pg_temp.emails(o, 'order_placed') = 0, 'an order without an address queues no customer email');
  PERFORM pg_temp.check_that(public.submit_payment_reference(s, pg_temp.hash_of('e'), '444444444444') ->> 'ok' = 'true' AND pg_temp.emails(o, 'seller_payment_submitted') = 1,
    'but the seller is still told about its payment reference');

  v_total := (SELECT count(*) FROM public.email_outbox);
  PERFORM pg_temp.check_that(pg_temp.place(s, 'f', p, 'buyer-f@example.invalid', 'en', 99999) ->> 'reason' = 'total_mismatch', 'a refused order is refused');
  PERFORM pg_temp.check_that((SELECT count(*) FROM public.email_outbox) = v_total, 'a refused order queues nothing');
END;
$$;

-- Test 3: queuing failure rolls the order change back ----------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.smoke_atomic_rollback() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  s uuid; p uuid; v_orders bigint; v_stock int; v_failed boolean := false;
BEGIN
  s := pg_temp.make_store();
  p := pg_temp.make_product(s, 3);
  EXECUTE 'CREATE FUNCTION public.smoke_010_fail() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION ''smoke queue failure'' USING ERRCODE = ''AB002''; END $f$';
  EXECUTE 'CREATE TRIGGER smoke_010_fail BEFORE INSERT ON public.email_outbox FOR EACH ROW EXECUTE FUNCTION public.smoke_010_fail()';
  v_orders := (SELECT count(*) FROM public.orders WHERE store_id = s);
  BEGIN
    PERFORM pg_temp.place(s, 'r', p, 'buyer@example.invalid', 'en');
  EXCEPTION WHEN SQLSTATE 'AB002' THEN
    v_failed := true;
  END;
  EXECUTE 'DROP TRIGGER smoke_010_fail ON public.email_outbox';
  EXECUTE 'DROP FUNCTION public.smoke_010_fail()';
  PERFORM pg_temp.check_that(v_failed, 'a failing outbox insert makes place_order raise');
  PERFORM pg_temp.check_that((SELECT count(*) FROM public.orders WHERE store_id = s) = v_orders, 'and no order is left behind');
  v_stock := (SELECT stock FROM public.products WHERE id = p);
  PERFORM pg_temp.check_that(v_stock = 3, 'and no stock stays reserved');
END;
$$;

-- Test 4: dedupe and limits (the global cap last: it fills the hour) ---------------------------------
CREATE OR REPLACE FUNCTION pg_temp.smoke_limits() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  i int;
BEGIN
  PERFORM pg_temp.check_that(pg_temp.enqueue('smoke-010-dd', 'dd@example.invalid') = 'queued', 'first enqueue is queued');
  PERFORM pg_temp.check_that(pg_temp.enqueue('smoke-010-dd', 'dd@example.invalid') = 'duplicate', 'same dedupe key is a no-op');
  PERFORM pg_temp.check_that((SELECT count(*) FROM public.email_outbox WHERE dedupe_key = 'smoke-010-dd') = 1, 'and leaves one row');

  FOR i IN 1..6 LOOP
    PERFORM pg_temp.check_that(pg_temp.enqueue('smoke-010-h' || i, 'Lim@Example.invalid') = 'queued', 'customer hourly limit: email ' || i || ' of 6 is queued');
  END LOOP;
  PERFORM pg_temp.check_that(pg_temp.enqueue('smoke-010-h7', 'lim@example.invalid') = 'limited_recipient', 'the 7th customer email in an hour is limited (case-insensitive)');
  PERFORM pg_temp.check_that((SELECT count(*) FROM public.email_outbox WHERE dedupe_key = 'smoke-010-h7') = 0, 'and nothing is queued');
  PERFORM pg_temp.check_that(pg_temp.enqueue('smoke-010-h8', 'other@example.invalid') = 'queued', 'another recipient is unaffected');

  FOR i IN 1..30 LOOP
    PERFORM pg_temp.check_that(pg_temp.enqueue('smoke-010-s' || i, 'sel@example.invalid', 'seller_payment_submitted') = 'queued', 'seller hourly limit: alert ' || i || ' of 30 is queued');
  END LOOP;
  PERFORM pg_temp.check_that(pg_temp.enqueue('smoke-010-s31', 'sel@example.invalid', 'seller_payment_submitted') = 'limited_recipient', 'the 31st seller alert in an hour is limited');

  INSERT INTO public.email_outbox (kind, to_email, dedupe_key, created_at)
    SELECT 'order_placed', 'day@example.invalid', 'smoke-010-day' || g, now() - interval '2 hours' FROM generate_series(1, 20) AS g;
  PERFORM pg_temp.check_that(pg_temp.enqueue('smoke-010-day21', 'day@example.invalid') = 'limited_recipient', 'the 21st customer email in a day is limited');
  PERFORM pg_temp.check_that(pg_temp.enqueue('smoke-010-day22', 'day@example.invalid', 'seller_payment_submitted') = 'queued', 'seller alerts have no daily limit');

  FOR i IN 1..8 LOOP
    PERFORM pg_temp.check_that(pg_temp.enqueue('smoke-010-ci' || i, 'inbox@example.invalid', 'contact_inbox') = 'queued', 'contact_inbox is not limited per recipient: ' || i);
  END LOOP;

  INSERT INTO public.email_outbox (kind, to_email, dedupe_key)
    SELECT 'contact_inbox', 'g' || g || '@example.invalid', 'smoke-010-g' || g FROM generate_series(1, 150) AS g;
  PERFORM pg_temp.check_that(pg_temp.enqueue('smoke-010-global', 'fresh@example.invalid') = 'limited_global', 'the global hourly cap stops everything');
  PERFORM pg_temp.check_that(pg_temp.enqueue('smoke-010-global2', 'fresh@example.invalid', 'seller_payment_submitted') = 'limited_global', 'including seller alerts');
END;
$$;

-- Test 5: claim, lease, retry, dead ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.smoke_worker() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  a uuid; b uuid; c uuid; d uuid; v_next timestamptz;
BEGIN
  a := pg_temp.row_for('smoke-010-wa', 'wa@example.invalid');
  PERFORM pg_temp.check_that(pg_temp.claimed(a) = 1, 'a due row is claimed');
  PERFORM pg_temp.check_that((SELECT status = 'sending' AND attempts = 1 AND lease_until > now() + interval '4 minutes' FROM public.email_outbox WHERE id = a),
    'the claim sets sending, attempts 1 and a 5 minute lease');
  PERFORM pg_temp.check_that(pg_temp.claimed(a) = 0, 'a leased row is not claimed again');

  UPDATE public.email_outbox SET lease_until = now() - interval '1 second' WHERE id = a;
  PERFORM pg_temp.check_that(pg_temp.claimed(a) = 1, 'a row whose lease expired is reclaimed');
  PERFORM pg_temp.check_that((SELECT attempts = 2 FROM public.email_outbox WHERE id = a), 'and the attempt is counted');

  PERFORM pg_temp.check_that(public.finish_email(a, false, 'RELAY_TIMEOUT', 60) = 'queued', 'a timeout is requeued');
  SELECT next_attempt_at INTO v_next FROM public.email_outbox WHERE id = a;
  PERFORM pg_temp.check_that(v_next > now() + interval '55 seconds' AND v_next < now() + interval '65 seconds', 'for the retry delay given');
  PERFORM pg_temp.check_that((SELECT last_error_code = 'RELAY_TIMEOUT' AND body = 'keep' AND lease_until IS NULL FROM public.email_outbox WHERE id = a),
    'with the short error code, the body kept and no lease');
  PERFORM pg_temp.check_that(pg_temp.claimed(a) = 0, 'it is not claimable before its time');
  UPDATE public.email_outbox SET next_attempt_at = now() - interval '1 second' WHERE id = a;
  PERFORM pg_temp.check_that(pg_temp.claimed(a) = 1, 'it is claimable after its time');
  PERFORM pg_temp.check_that(public.finish_email(a, true, NULL, NULL) = 'sent', 'a successful send is recorded');
  PERFORM pg_temp.check_that((SELECT status = 'sent' AND sent_at IS NOT NULL AND body = '' AND payload = '{}'::jsonb AND last_error_code IS NULL FROM public.email_outbox WHERE id = a),
    'sent: timestamp set, body and payload blanked');
  PERFORM pg_temp.check_that(public.finish_email(a, true, NULL, NULL) IS NULL, 'finishing a row that is not sending changes nothing');

  b := pg_temp.row_for('smoke-010-wb', 'wb@example.invalid');
  UPDATE public.email_outbox SET attempts = 4 WHERE id = b;
  PERFORM pg_temp.check_that(pg_temp.claimed(b) = 1 AND (SELECT attempts = 5 FROM public.email_outbox WHERE id = b), 'the 5th attempt is claimed');
  PERFORM pg_temp.check_that(public.finish_email(b, false, 'RELAY_UNREACHABLE', 7200) = 'dead', 'a failure on the maximum attempt is dead');
  PERFORM pg_temp.check_that((SELECT status = 'dead' AND body = '' AND last_error_code = 'RELAY_UNREACHABLE' FROM public.email_outbox WHERE id = b), 'dead: body blanked, code kept');

  c := pg_temp.row_for('smoke-010-wc', 'wc@example.invalid');
  PERFORM pg_temp.check_that(pg_temp.claimed(c) = 1, 'row c claimed');
  PERFORM pg_temp.check_that(public.finish_email(c, false, 'RELAY_REJECTED', NULL) = 'dead', 'a relay refusal (no retry delay) is dead at once');
  PERFORM pg_temp.check_that((SELECT attempts = 1 FROM public.email_outbox WHERE id = c), 'after one attempt');

  d := pg_temp.row_for('smoke-010-wd', 'wd@example.invalid');
  UPDATE public.email_outbox SET status = 'sending', attempts = 5, lease_until = now() - interval '1 second' WHERE id = d;
  PERFORM pg_temp.check_that(pg_temp.claimed(d) = 0, 'an expired lease on the last attempt is not claimed');
  PERFORM pg_temp.check_that((SELECT status = 'dead' AND last_error_code = 'LEASE_EXPIRED' AND body = '' FROM public.email_outbox WHERE id = d), 'it is marked dead instead');
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.smoke_010() RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_temp.smoke_constraints();
  PERFORM pg_temp.smoke_order_hooks();
  PERFORM pg_temp.smoke_atomic_rollback();
  PERFORM pg_temp.smoke_worker();
  PERFORM pg_temp.smoke_limits();
  RAISE EXCEPTION 'smoke complete, rolling back' USING ERRCODE = 'AB001';
EXCEPTION
  WHEN SQLSTATE 'AB001' THEN
    RETURN 'ALL CHECKS PASSED';
END;
$$;

SELECT pg_temp.smoke_010() AS result;
