-- Manual two-session race tests for migration 009 (10 minute reservation). NOT run automatically.
-- Apply migrations 008 and 009 first. HOW TO RUN: same as 008_orders_races.sql. Open TWO SQL editor tabs, A and B. For each
-- scenario paste the "A" block in tab A and the "B" block in tab B; press Run on A, then on B within a few seconds. A holds
-- its locks with pg_sleep(15) before COMMIT. Then run the scenario's CHECK. Run "0. SETUP" once, then "9. CLEANUP".
-- All rows use fixed ids and the prefix "test-race-009".
-- Scenarios 1-3 are independent: each sweep is limited (second argument of expire_overdue_orders) to the one product of
-- its own order (c1, c2, c3), so no scenario relies on, or disturbs, the overdue orders of another. Scenario 4 reuses c1
-- and so needs scenario 1 to have run first (it needs c1 back at stock 1).

------------------------------------------------------------------------------------------------------------------
-- 0. SETUP
------------------------------------------------------------------------------------------------------------------
INSERT INTO public.owners (id, email, password_hash)
  VALUES ('00000009-0000-4000-8000-0000000000a1', 'test-race-009@example.invalid', 'x') ON CONFLICT DO NOTHING;
INSERT INTO public.stores (id, owner_id, slug, name, default_language, story, upi_id)
  VALUES ('00000009-0000-4000-8000-0000000000b1', '00000009-0000-4000-8000-0000000000a1', 'test-race-009', 'Race 009', 'en', 'story', 'race.shop@okbank')
  ON CONFLICT DO NOTHING;
INSERT INTO public.products (id, store_id, status, price_paise, stock, image_path) VALUES
  ('00000009-0000-4000-8000-0000000000c1', '00000009-0000-4000-8000-0000000000b1', 'published', 10000, 1, 'test-race-009/c1.jpg'),
  ('00000009-0000-4000-8000-0000000000c2', '00000009-0000-4000-8000-0000000000b1', 'published', 10000, 1, 'test-race-009/c2.jpg'),
  ('00000009-0000-4000-8000-0000000000c3', '00000009-0000-4000-8000-0000000000b1', 'published', 10000, 1, 'test-race-009/c3.jpg')
  ON CONFLICT DO NOTHING;
-- Three orders (one per product), each placed normally (stock becomes 0) and then aged past the 10 minute deadline.
SELECT public.place_order('00000009-0000-4000-8000-0000000000b1', repeat('a', 64), 'race.shop@okbank', 'Buyer 1', '919876543210', NULL, 'Addr', 'en', 10000,
  '[{"product_id":"00000009-0000-4000-8000-0000000000c1","quantity":1,"expected_price_paise":10000,"title":"Race","title_lang":"en"}]'::jsonb);
SELECT public.place_order('00000009-0000-4000-8000-0000000000b1', repeat('b', 64), 'race.shop@okbank', 'Buyer 2', '919876543211', NULL, 'Addr', 'en', 10000,
  '[{"product_id":"00000009-0000-4000-8000-0000000000c2","quantity":1,"expected_price_paise":10000,"title":"Race","title_lang":"en"}]'::jsonb);
SELECT public.place_order('00000009-0000-4000-8000-0000000000b1', repeat('c', 64), 'race.shop@okbank', 'Buyer 3', '919876543212', NULL, 'Addr', 'en', 10000,
  '[{"product_id":"00000009-0000-4000-8000-0000000000c3","quantity":1,"expected_price_paise":10000,"title":"Race","title_lang":"en"}]'::jsonb);
UPDATE public.orders SET created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute'
  WHERE status_token_hash IN (repeat('a', 64), repeat('b', 64), repeat('c', 64));

------------------------------------------------------------------------------------------------------------------
-- 1. EXPIRY vs LATE UTR (order 'a', overdue but not yet swept). Both must leave ONE consistent result.
------------------------------------------------------------------------------------------------------------------
-- Tab A: the sweep expires it and holds the lock.
BEGIN;
SELECT public.expire_overdue_orders('00000009-0000-4000-8000-0000000000b1', ARRAY['00000009-0000-4000-8000-0000000000c1']::uuid[]) AS a_must_be_1;
SELECT pg_sleep(15);
COMMIT;
-- Tab B: the late UTR waits for the row lock (the sweep uses SKIP LOCKED, the UTR does not), then sees a cancelled order.
-- Must return {"ok": false, "reason": "invalid_transition"} (or "expired" if B ran first). Never {"ok": true}.
SELECT public.submit_payment_reference('00000009-0000-4000-8000-0000000000b1', repeat('a', 64), '100000000001') AS b_must_not_be_ok;
-- CHECK: cancelled/expired, no attempt row for that UTR, stock of c1 is exactly 1 (restored once).
SELECT (SELECT status || '/' || cancel_reason FROM public.orders WHERE status_token_hash = repeat('a', 64)) AS must_be_cancelled_expired,
       (SELECT count(*) FROM public.order_payment_attempts WHERE utr = '100000000001') AS attempts_must_be_0,
       (SELECT stock FROM public.products WHERE id = '00000009-0000-4000-8000-0000000000c1') AS stock_must_be_1;

------------------------------------------------------------------------------------------------------------------
-- 2. LATE UTR first, then EXPIRY (order 'b'): the UTR holds the row lock and finds the order overdue.
------------------------------------------------------------------------------------------------------------------
-- Tab A: the late UTR expires the order itself and holds the lock.
BEGIN;
SELECT public.submit_payment_reference('00000009-0000-4000-8000-0000000000b1', repeat('b', 64), '100000000002') AS a_must_be_expired;
SELECT pg_sleep(15);
COMMIT;
-- Tab B: the sweep skips the locked order: returns 0 immediately, does not restore stock a second time.
SELECT public.expire_overdue_orders('00000009-0000-4000-8000-0000000000b1', ARRAY['00000009-0000-4000-8000-0000000000c2']::uuid[]) AS b_must_be_0;
-- CHECK: cancelled/expired, stock of c2 is exactly 1.
SELECT (SELECT status || '/' || cancel_reason FROM public.orders WHERE status_token_hash = repeat('b', 64)) AS must_be_cancelled_expired,
       (SELECT stock FROM public.products WHERE id = '00000009-0000-4000-8000-0000000000c2') AS stock_must_be_1;

------------------------------------------------------------------------------------------------------------------
-- 3. EXPIRY vs NEW ORDER for the last unit (order 'c' holds product c3, overdue).
------------------------------------------------------------------------------------------------------------------
-- Tab A: the sweep expires the holder (stock back to 1) and keeps the transaction open.
BEGIN;
SELECT public.expire_overdue_orders('00000009-0000-4000-8000-0000000000b1', ARRAY['00000009-0000-4000-8000-0000000000c3']::uuid[]) AS a_must_be_1;
SELECT pg_sleep(15);
COMMIT;
-- Tab B: its own sweep skips the locked order, then waits for the product row. After A commits stock is 1: B must succeed.
SELECT public.place_order('00000009-0000-4000-8000-0000000000b1', repeat('d', 64), 'race.shop@okbank', 'Buyer 4', '919876543213', NULL, 'Addr', 'en', 10000,
  '[{"product_id":"00000009-0000-4000-8000-0000000000c3","quantity":1,"expected_price_paise":10000,"title":"Race","title_lang":"en"}]'::jsonb) AS b_must_be_ok;
-- CHECK: stock 0 (not negative), first order expired, second awaiting_payment.
SELECT (SELECT stock FROM public.products WHERE id = '00000009-0000-4000-8000-0000000000c3') AS stock_must_be_0,
       (SELECT cancel_reason FROM public.orders WHERE status_token_hash = repeat('c', 64)) AS first_must_be_expired,
       (SELECT status FROM public.orders WHERE status_token_hash = repeat('d', 64)) AS second_must_be_awaiting_payment;

------------------------------------------------------------------------------------------------------------------
-- 4. TWO BUYERS, ONE UNIT, both after the holder expired (product c1 again, stock 1 after scenario 1).
------------------------------------------------------------------------------------------------------------------
-- Tab A: buyer E.
BEGIN;
SELECT public.place_order('00000009-0000-4000-8000-0000000000b1', repeat('e', 64), 'race.shop@okbank', 'Buyer 5', '919876543214', NULL, 'Addr', 'en', 10000,
  '[{"product_id":"00000009-0000-4000-8000-0000000000c1","quantity":1,"expected_price_paise":10000,"title":"Race","title_lang":"en"}]'::jsonb) AS a_must_be_ok;
SELECT pg_sleep(15);
COMMIT;
-- Tab B: buyer F waits for the product row, then must return {"ok": false, "reason": "insufficient_stock"}.
SELECT public.place_order('00000009-0000-4000-8000-0000000000b1', repeat('f', 64), 'race.shop@okbank', 'Buyer 6', '919876543215', NULL, 'Addr', 'en', 10000,
  '[{"product_id":"00000009-0000-4000-8000-0000000000c1","quantity":1,"expected_price_paise":10000,"title":"Race","title_lang":"en"}]'::jsonb) AS b_must_be_insufficient_stock;
SELECT (SELECT stock FROM public.products WHERE id = '00000009-0000-4000-8000-0000000000c1') AS stock_must_be_0;

------------------------------------------------------------------------------------------------------------------
-- 9. CLEANUP (only the fixed test rows above; cascades to orders, items, attempts, counter)
------------------------------------------------------------------------------------------------------------------
DELETE FROM public.stores WHERE id = '00000009-0000-4000-8000-0000000000b1' AND slug = 'test-race-009';
DELETE FROM public.owners WHERE id = '00000009-0000-4000-8000-0000000000a1' AND email = 'test-race-009@example.invalid';
