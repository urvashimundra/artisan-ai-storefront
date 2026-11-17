-- Manual two-session race tests for migration 011 (email limits). NOT run automatically. Apply migrations 008 to 011 first.
--
-- HOW TO RUN IN THE SUPABASE SQL EDITOR (same method as 008_orders_races.sql)
-- Open TWO editor tabs, A and B. In each scenario paste the "A" block in tab A and the "B" block in tab B. Press Run on A, then Run on B
-- within a few seconds: A keeps its transaction open with pg_sleep(15) before it commits, so B starts while A holds the email lock.
-- Wait for both to finish, then run the scenario's CHECK query. Run "0. SETUP" once, the scenarios in order, then "9. CLEANUP".
-- All rows use the prefix "test-race-011" and example.invalid, so they are easy to find and remove.
-- WARNING: scenario 2 fills the global hourly cap with test rows until CLEANUP; run it on a quiet database.

------------------------------------------------------------------------------------------------------------------
-- 0. SETUP
------------------------------------------------------------------------------------------------------------------
INSERT INTO public.owners (id, email, password_hash)
  VALUES ('00000011-0000-4000-8000-0000000000a1', 'test-race-011@example.invalid', 'x') ON CONFLICT DO NOTHING;
INSERT INTO public.stores (id, owner_id, slug, name, default_language, story, upi_id)
  VALUES ('00000011-0000-4000-8000-0000000000b1', '00000011-0000-4000-8000-0000000000a1', 'test-race-011', 'Race 011', 'en', 'story', 'race.shop@okbank')
  ON CONFLICT DO NOTHING;
INSERT INTO public.products (id, store_id, status, price_paise, stock, image_path) VALUES
  ('00000011-0000-4000-8000-0000000000c1', '00000011-0000-4000-8000-0000000000b1', 'published', 10000, 50, 'test-race-011/c1.jpg')
  ON CONFLICT DO NOTHING;
-- Five emails already queued to the same recipient: exactly ONE more is allowed this hour (the limit is 6).
INSERT INTO public.email_outbox (kind, to_email, dedupe_key)
  SELECT 'order_placed', 'test-race-011-limit@example.invalid', 'test-race-011-pre' || g FROM generate_series(1, 5) AS g ON CONFLICT DO NOTHING;

------------------------------------------------------------------------------------------------------------------
-- 1. PER-RECIPIENT LIMIT: two transactions queue to the same address at once. Exactly one must be 'queued', the other 'limited_recipient'.
------------------------------------------------------------------------------------------------------------------
-- Tab A:
BEGIN;
SELECT public.email_enqueue(NULL, 'order_placed', 'test-race-011-limit@example.invalid', 'en', 'S', 'B', '{}'::jsonb, NULL, 'test-race-011-a') AS a_result;
SELECT pg_sleep(15);
COMMIT;
-- Tab B (run while A sleeps; B must WAIT for A, then answer after A commits):
SELECT public.email_enqueue(NULL, 'order_placed', 'test-race-011-limit@example.invalid', 'en', 'S', 'B', '{}'::jsonb, NULL, 'test-race-011-b') AS b_result;
-- CHECK: exactly one of a_result / b_result is 'queued' and the other 'limited_recipient'; this must return 6.
SELECT count(*) AS must_be_6 FROM public.email_outbox WHERE to_email = 'test-race-011-limit@example.invalid';

------------------------------------------------------------------------------------------------------------------
-- 2. GLOBAL CAP: fill the hour to 149 rows, then two transactions queue to different addresses. Exactly one may be 'queued'.
------------------------------------------------------------------------------------------------------------------
-- Run once, in either tab, to bring the last hour to exactly 149 rows (it adds the missing rows, so it is safe to repeat):
INSERT INTO public.email_outbox (kind, to_email, dedupe_key)
  SELECT 'contact_inbox', 'test-race-011-g' || g || '@example.invalid', 'test-race-011-g' || g
    FROM generate_series(1, greatest(0, 149 - (SELECT count(*)::int FROM public.email_outbox WHERE created_at > now() - interval '1 hour'))) AS g
  ON CONFLICT DO NOTHING;
-- Tab A:
BEGIN;
SELECT public.email_enqueue(NULL, 'contact_inbox', 'test-race-011-x@example.invalid', 'en', 'S', 'B', '{}'::jsonb, NULL, 'test-race-011-ga') AS a_result;
SELECT pg_sleep(15);
COMMIT;
-- Tab B:
SELECT public.email_enqueue(NULL, 'contact_inbox', 'test-race-011-y@example.invalid', 'en', 'S', 'B', '{}'::jsonb, NULL, 'test-race-011-gb') AS b_result;
-- CHECK: one 'queued' and one 'limited_global'; this must return 150 (not 151).
SELECT count(*) AS must_be_150 FROM public.email_outbox WHERE created_at > now() - interval '1 hour';

------------------------------------------------------------------------------------------------------------------
-- 3. NO DEADLOCK: an order is placed while another order is cancelled and another sweeps. All must finish without "deadlock detected".
--    Needs two committed orders from the setup below (run it once; it uses the global cap, so run CLEANUP of scenario 2 first).
------------------------------------------------------------------------------------------------------------------
DELETE FROM public.email_outbox WHERE dedupe_key LIKE 'test-race-011-g%';
SELECT public.place_order('00000011-0000-4000-8000-0000000000b1', encode(sha256('test-race-011-o1'::bytea), 'hex'), 'race.shop@okbank', 'Race Buyer', '919876543210',
  'test-race-011-o1@example.invalid', 'addr', 'en', 10000,
  jsonb_build_array(jsonb_build_object('product_id', '00000011-0000-4000-8000-0000000000c1', 'quantity', 1, 'expected_price_paise', 10000, 'title', 'T', 'title_lang', 'en')), NULL);
-- Tab A: places another order and holds the transaction open.
BEGIN;
SELECT public.place_order('00000011-0000-4000-8000-0000000000b1', encode(sha256('test-race-011-o2'::bytea), 'hex'), 'race.shop@okbank', 'Race Buyer', '919876543210',
  'test-race-011-o2@example.invalid', 'addr', 'en', 10000,
  jsonb_build_array(jsonb_build_object('product_id', '00000011-0000-4000-8000-0000000000c1', 'quantity', 1, 'expected_price_paise', 10000, 'title', 'T', 'title_lang', 'en')), NULL);
SELECT pg_sleep(15);
COMMIT;
-- Tab B: cancels the first order as its customer (it locks the order row and the product stock, and queues an email) while A is open.
SELECT public.cancel_order('00000011-0000-4000-8000-0000000000b1', (SELECT id FROM public.orders WHERE status_token_hash = encode(sha256('test-race-011-o1'::bytea), 'hex')),
  'customer', NULL, encode(sha256('test-race-011-o1'::bytea), 'hex'));
-- CHECK: both calls succeeded (no deadlock error), stock is 50 - 1 (only o2 still holds a unit), and each order has exactly one placed email.
SELECT (SELECT stock FROM public.products WHERE id = '00000011-0000-4000-8000-0000000000c1') AS stock_must_be_49,
       (SELECT count(*) FROM public.email_outbox WHERE dedupe_key LIKE 'order_placed:%' AND to_email LIKE 'test-race-011-o%') AS must_be_2,
       (SELECT count(*) FROM public.email_outbox WHERE dedupe_key LIKE 'order_cancelled:%' AND to_email = 'test-race-011-o1@example.invalid') AS must_be_1;

------------------------------------------------------------------------------------------------------------------
-- 9. CLEANUP (committed test data)
------------------------------------------------------------------------------------------------------------------
DELETE FROM public.email_outbox WHERE dedupe_key LIKE 'test-race-011-%' OR to_email LIKE 'test-race-011-%@example.invalid';
DELETE FROM public.orders WHERE store_id = '00000011-0000-4000-8000-0000000000b1';
DELETE FROM public.store_order_counters WHERE store_id = '00000011-0000-4000-8000-0000000000b1';
DELETE FROM public.products WHERE store_id = '00000011-0000-4000-8000-0000000000b1';
DELETE FROM public.stores WHERE id = '00000011-0000-4000-8000-0000000000b1';
DELETE FROM public.owners WHERE id = '00000011-0000-4000-8000-0000000000a1';
