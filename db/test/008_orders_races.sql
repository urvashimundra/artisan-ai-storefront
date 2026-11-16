-- Manual two-session race tests for migration 008 (orders). NOT run automatically. Apply migration 008 first.
--
-- HOW TO RUN IN THE SUPABASE SQL EDITOR (no persistent sessions needed)
-- Open TWO editor tabs, A and B. In each scenario below, paste the "A" block in tab A and the "B" block in tab B.
-- Press Run on A, then press Run on B within a few seconds. A holds its transaction open with pg_sleep(15) before it
-- commits, so B starts while A's locks are held. Wait for both to finish, then run the scenario's CHECK query.
-- (With psql you can instead run "BEGIN; <call>;" in session A, run B in session B, then COMMIT in A.)
-- Each scenario says what B must show. Run "0. SETUP" once, scenarios in order, then "9. CLEANUP".
-- All rows use fixed ids and the prefix "test-race-008", so they are easy to find and remove.

------------------------------------------------------------------------------------------------------------------
-- 0. SETUP (committed test data: one owner, one store, products, and orders for the scenarios)
------------------------------------------------------------------------------------------------------------------
INSERT INTO public.owners (id, email, password_hash)
  VALUES ('00000008-0000-4000-8000-0000000000a1', 'test-race-008@example.invalid', 'x') ON CONFLICT DO NOTHING;
INSERT INTO public.stores (id, owner_id, slug, name, default_language, story, upi_id)
  VALUES ('00000008-0000-4000-8000-0000000000b1', '00000008-0000-4000-8000-0000000000a1', 'test-race-008', 'Race 008', 'en', 'story', 'race.shop@okbank')
  ON CONFLICT DO NOTHING;
INSERT INTO public.products (id, store_id, status, price_paise, stock, image_path) VALUES
  ('00000008-0000-4000-8000-0000000000c1', '00000008-0000-4000-8000-0000000000b1', 'published', 10000, 1,    'test-race-008/c1.jpg'),
  ('00000008-0000-4000-8000-0000000000c2', '00000008-0000-4000-8000-0000000000b1', 'published', 10000, NULL, 'test-race-008/c2.jpg'),
  ('00000008-0000-4000-8000-0000000000c3', '00000008-0000-4000-8000-0000000000b1', 'published', 10000, 5,    'test-race-008/c3.jpg'),
  ('00000008-0000-4000-8000-0000000000c4', '00000008-0000-4000-8000-0000000000b1', 'published', 10000, 1,    'test-race-008/c4.jpg')
  ON CONFLICT DO NOTHING;

------------------------------------------------------------------------------------------------------------------
-- 1. LAST UNIT: product c1 has stock 1. Exactly one buyer must succeed.
------------------------------------------------------------------------------------------------------------------
-- Tab A:
BEGIN;
SELECT public.place_order('00000008-0000-4000-8000-0000000000b1', repeat('1', 64), 'race.shop@okbank', 'Buyer A', '919876543210', NULL, NULL, 'en', 10000,
  '[{"product_id":"00000008-0000-4000-8000-0000000000c1","quantity":1,"expected_price_paise":10000,"title":"Race","title_lang":"en"}]'::jsonb) AS a_result;
SELECT pg_sleep(15);
COMMIT;
-- Tab B (start within 15 s of A): it waits for A, then must return {"ok": false, "reason": "insufficient_stock"}.
SELECT public.place_order('00000008-0000-4000-8000-0000000000b1', repeat('2', 64), 'race.shop@okbank', 'Buyer B', '919876543211', NULL, NULL, 'en', 10000,
  '[{"product_id":"00000008-0000-4000-8000-0000000000c1","quantity":1,"expected_price_paise":10000,"title":"Race","title_lang":"en"}]'::jsonb) AS b_result;
-- CHECK: stock 0 and exactly one order for c1.
SELECT (SELECT stock FROM public.products WHERE id = '00000008-0000-4000-8000-0000000000c1') AS stock_must_be_0,
       (SELECT count(*) FROM public.order_items WHERE product_id = '00000008-0000-4000-8000-0000000000c1') AS orders_must_be_1;

------------------------------------------------------------------------------------------------------------------
-- 2. CONCURRENT REFERENCES: product c2 (unlimited). Two simultaneous orders must get different, consecutive references.
------------------------------------------------------------------------------------------------------------------
-- Tab A:
BEGIN;
SELECT public.place_order('00000008-0000-4000-8000-0000000000b1', repeat('3', 64), 'race.shop@okbank', 'Buyer A', '919876543210', NULL, NULL, 'en', 10000,
  '[{"product_id":"00000008-0000-4000-8000-0000000000c2","quantity":1,"expected_price_paise":10000,"title":"Race","title_lang":"en"}]'::jsonb) AS a_result;
SELECT pg_sleep(15);
COMMIT;
-- Tab B: waits for A's counter row, then returns the next reference (not a duplicate, not an error).
SELECT public.place_order('00000008-0000-4000-8000-0000000000b1', repeat('4', 64), 'race.shop@okbank', 'Buyer B', '919876543211', NULL, NULL, 'en', 10000,
  '[{"product_id":"00000008-0000-4000-8000-0000000000c2","quantity":1,"expected_price_paise":10000,"title":"Race","title_lang":"en"}]'::jsonb) AS b_result;
-- CHECK: references are distinct and consecutive (no gaps, no duplicates).
SELECT reference FROM public.orders WHERE store_id = '00000008-0000-4000-8000-0000000000b1' ORDER BY reference;

------------------------------------------------------------------------------------------------------------------
-- 3. CANCEL vs EXPIRY on one order. Product c3 (stock 5). First create an order and make it overdue:
------------------------------------------------------------------------------------------------------------------
SELECT public.place_order('00000008-0000-4000-8000-0000000000b1', repeat('5', 64), 'race.shop@okbank', 'Buyer C', '919876543212', NULL, NULL, 'en', 20000,
  '[{"product_id":"00000008-0000-4000-8000-0000000000c3","quantity":2,"expected_price_paise":10000,"title":"Race","title_lang":"en"}]'::jsonb);
UPDATE public.orders SET expires_at = now() - interval '1 minute' WHERE status_token_hash = repeat('5', 64);
-- (stock of c3 is now 3.)
-- 3a. Tab A: owner cancels and holds the lock.
BEGIN;
SELECT public.cancel_order('00000008-0000-4000-8000-0000000000b1',
  (SELECT id FROM public.orders WHERE status_token_hash = repeat('5', 64)), 'owner', '00000008-0000-4000-8000-0000000000a1', NULL) AS cancel_result;
SELECT pg_sleep(15);
COMMIT;
-- 3a. Tab B: the sweep uses SKIP LOCKED, so it returns 0 immediately (does not wait, does not double-process).
SELECT public.expire_overdue_orders('00000008-0000-4000-8000-0000000000b1') AS expired_must_be_0;
-- CHECK after both: order cancelled with reason 'owner', stock of c3 is exactly 5 (restored ONCE).
SELECT o.status, o.cancel_reason, (SELECT stock FROM public.products WHERE id = '00000008-0000-4000-8000-0000000000c3') AS stock_must_be_5
  FROM public.orders o WHERE o.status_token_hash = repeat('5', 64);
-- 3b. Reverse: repeat 3 with a new order (hash repeat('6',64)), but Tab A runs the sweep (expire_overdue_orders) with pg_sleep,
--     and Tab B runs cancel_order for it. B waits for A, then must return {"ok": true, "already": true}; stock restored once.

------------------------------------------------------------------------------------------------------------------
-- 4. EXPIRY vs NEW ORDER: product c4 (stock 1) is held by an overdue order. A new buyer must be able to buy it.
------------------------------------------------------------------------------------------------------------------
SELECT public.place_order('00000008-0000-4000-8000-0000000000b1', repeat('7', 64), 'race.shop@okbank', 'Buyer D', '919876543213', NULL, NULL, 'en', 10000,
  '[{"product_id":"00000008-0000-4000-8000-0000000000c4","quantity":1,"expected_price_paise":10000,"title":"Race","title_lang":"en"}]'::jsonb);
UPDATE public.orders SET expires_at = now() - interval '1 minute' WHERE status_token_hash = repeat('7', 64);
-- Tab A: the sweep expires the holder (restoring stock to 1) and keeps the transaction open.
BEGIN;
SELECT public.expire_overdue_orders('00000008-0000-4000-8000-0000000000b1') AS expired_must_be_1;
SELECT pg_sleep(15);
COMMIT;
-- Tab B: its own sweep skips the locked order, then waits for the product row. After A commits, stock is 1: B must succeed.
SELECT public.place_order('00000008-0000-4000-8000-0000000000b1', repeat('8', 64), 'race.shop@okbank', 'Buyer E', '919876543214', NULL, NULL, 'en', 10000,
  '[{"product_id":"00000008-0000-4000-8000-0000000000c4","quantity":1,"expected_price_paise":10000,"title":"Race","title_lang":"en"}]'::jsonb) AS b_must_be_ok;
-- CHECK: stock 0, the first order expired, the second awaiting_payment, no negative stock.
SELECT (SELECT stock FROM public.products WHERE id = '00000008-0000-4000-8000-0000000000c4') AS stock_must_be_0,
       (SELECT cancel_reason FROM public.orders WHERE status_token_hash = repeat('7', 64)) AS first_must_be_expired,
       (SELECT status FROM public.orders WHERE status_token_hash = repeat('8', 64)) AS second_must_be_awaiting_payment;

------------------------------------------------------------------------------------------------------------------
-- 5. CONCURRENT DUPLICATE UTR (same store, two different orders): exactly one may keep the UTR.
------------------------------------------------------------------------------------------------------------------
-- Orders from scenario 2 (hashes repeat('3',64) and repeat('4',64)) are used.
-- Tab A:
BEGIN;
SELECT public.submit_payment_reference('00000008-0000-4000-8000-0000000000b1', repeat('3', 64), '123456789012') AS a_must_be_ok;
SELECT pg_sleep(15);
COMMIT;
-- Tab B: waits on the unique index, then must return {"ok": false, "reason": "utr_in_use"}.
SELECT public.submit_payment_reference('00000008-0000-4000-8000-0000000000b1', repeat('4', 64), '123456789012') AS b_must_be_utr_in_use;
-- CHECK: one attempt row for this UTR; order '4' is still awaiting_payment with 0 submissions.
SELECT (SELECT count(*) FROM public.order_payment_attempts WHERE store_id = '00000008-0000-4000-8000-0000000000b1' AND utr = '123456789012') AS attempts_must_be_1,
       (SELECT status || '/' || utr_submissions FROM public.orders WHERE status_token_hash = repeat('4', 64)) AS must_be_awaiting_payment_0;

------------------------------------------------------------------------------------------------------------------
-- 6. DOUBLE SUBMIT on ONE order with two different UTRs (order '4'): the row lock serialises them.
------------------------------------------------------------------------------------------------------------------
-- Tab A:
BEGIN;
SELECT public.submit_payment_reference('00000008-0000-4000-8000-0000000000b1', repeat('4', 64), '210987654321') AS a_must_be_ok;
SELECT pg_sleep(15);
COMMIT;
-- Tab B: waits, then must return {"ok": false, "reason": "invalid_transition"} (already submitted with a different UTR).
SELECT public.submit_payment_reference('00000008-0000-4000-8000-0000000000b1', repeat('4', 64), '543210987654') AS b_must_be_invalid_transition;
-- CHECK: one submission counted.
SELECT utr_submissions AS must_be_1 FROM public.orders WHERE status_token_hash = repeat('4', 64);

------------------------------------------------------------------------------------------------------------------
-- 9. CLEANUP (removes only the fixed test rows above; cascades to orders, items, attempts, counter)
------------------------------------------------------------------------------------------------------------------
DELETE FROM public.stores WHERE id = '00000008-0000-4000-8000-0000000000b1' AND slug = 'test-race-008';
DELETE FROM public.owners WHERE id = '00000008-0000-4000-8000-0000000000a1' AND email = 'test-race-008@example.invalid';
