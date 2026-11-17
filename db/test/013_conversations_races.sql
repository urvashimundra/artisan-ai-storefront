-- Manual two-session race tests for migration 013 (limits, one run per conversation, idempotency). NOT run automatically. Run on STAGING only,
-- after migration 013 and the smoke test.
--
-- HOW TO RUN IN THE SUPABASE SQL EDITOR (same method as 011_email_races.sql)
-- Open TWO editor tabs, A and B. In each scenario paste the "A" block in tab A and the "B" block in tab B. Press Run on A, then Run on B within a few
-- seconds: A keeps its transaction open with pg_sleep(15) before it commits, so B starts while A holds the row lock and must WAIT for it.
-- Wait for both to finish, then run the scenario's CHECK query. Run "0. SETUP" once, the scenarios in order, then "9. CLEANUP".
-- All rows use the prefix "test-race-013" and example.invalid, so they are easy to find and remove.

------------------------------------------------------------------------------------------------------------------
-- 0. SETUP
------------------------------------------------------------------------------------------------------------------
INSERT INTO public.owners (id, email, password_hash)
  VALUES ('00000013-0000-4000-8000-0000000000a1', 'test-race-013@example.invalid', 'x') ON CONFLICT DO NOTHING;
INSERT INTO public.stores (id, owner_id, slug, name, default_language, story)
  VALUES ('00000013-0000-4000-8000-0000000000b1', '00000013-0000-4000-8000-0000000000a1', 'test-race-013', 'Race 013', 'en', 'story')
  ON CONFLICT DO NOTHING;
-- A conversation with no run in flight, for scenarios 3 and 4.
INSERT INTO public.conversations (id, store_id, language, customer_name, customer_phone, token_hash, start_key, message_count, last_message_role)
  VALUES ('00000013-0000-4000-8000-0000000000c1', '00000013-0000-4000-8000-0000000000b1', 'en', 'Race', '9876500130', repeat('1', 64),
          '00000013-0000-4000-8000-0000000000d1', 1, 'customer') ON CONFLICT DO NOTHING;
INSERT INTO public.conversation_messages (store_id, conversation_id, seq, role, body)
  VALUES ('00000013-0000-4000-8000-0000000000b1', '00000013-0000-4000-8000-0000000000c1', 1, 'customer', 'seed') ON CONFLICT DO NOTHING;

------------------------------------------------------------------------------------------------------------------
-- 1. CUSTOMER LIMIT (6 per day): the customer already used 5. Two starts at once. Exactly ONE may be ok, the other 'customer_limit'.
------------------------------------------------------------------------------------------------------------------
INSERT INTO public.conversation_usage (store_id, usage_day, scope, subject, used)
  VALUES ('00000013-0000-4000-8000-0000000000b1', public.conversation_india_day(), 'customer',
          encode(sha256(convert_to('9876500131', 'UTF8')), 'hex'), 5)
  ON CONFLICT (store_id, usage_day, scope, subject) DO UPDATE SET used = 5;
-- Tab A:
BEGIN;
SELECT public.conversation_start('00000013-0000-4000-8000-0000000000b1', NULL, 'en', 'A', '9876500131', repeat('2', 64), NULL,
  gen_random_uuid(), gen_random_uuid(), 'race a', 'n')->>'reason' AS a_reason;
SELECT pg_sleep(15);
COMMIT;
-- Tab B (run while A sleeps; B must WAIT, then answer after A commits):
SELECT public.conversation_start('00000013-0000-4000-8000-0000000000b1', NULL, 'en', 'B', '9876500131', repeat('3', 64), NULL,
  gen_random_uuid(), gen_random_uuid(), 'race b', 'n')->>'reason' AS b_reason;
-- CHECK: exactly one of a_reason / b_reason is NULL (ok) and the other 'customer_limit'; this must return 6.
SELECT used AS must_be_6 FROM public.conversation_usage
  WHERE store_id = '00000013-0000-4000-8000-0000000000b1' AND scope = 'customer' AND subject = encode(sha256(convert_to('9876500131', 'UTF8')), 'hex')
    AND usage_day = public.conversation_india_day();

------------------------------------------------------------------------------------------------------------------
-- 2. STORE LIMIT (200 per day): used 199, reserved 0. Two starts from different customers at once. Exactly ONE gets a run, the other is escalated.
------------------------------------------------------------------------------------------------------------------
UPDATE public.conversation_usage SET used = 199, reserved = 0
  WHERE store_id = '00000013-0000-4000-8000-0000000000b1' AND scope = 'store_ai' AND usage_day = public.conversation_india_day();
INSERT INTO public.conversation_usage (store_id, usage_day, scope, subject, used)
  VALUES ('00000013-0000-4000-8000-0000000000b1', public.conversation_india_day(), 'store_ai', '', 199) ON CONFLICT DO NOTHING;
-- Tab A:
BEGIN;
SELECT public.conversation_start('00000013-0000-4000-8000-0000000000b1', NULL, 'en', 'A', '9876500141', repeat('4', 64), NULL,
  gen_random_uuid(), gen_random_uuid(), 'race a', 'n')->>'escalated' AS a_escalated;
SELECT pg_sleep(15);
COMMIT;
-- Tab B:
SELECT public.conversation_start('00000013-0000-4000-8000-0000000000b1', NULL, 'en', 'B', '9876500142', repeat('5', 64), NULL,
  gen_random_uuid(), gen_random_uuid(), 'race b', 'n')->>'escalated' AS b_escalated;
-- CHECK: exactly one escalated = true and one false; used + reserved must be 200 (never 201).
SELECT used, reserved, used + reserved AS must_be_200 FROM public.conversation_usage
  WHERE store_id = '00000013-0000-4000-8000-0000000000b1' AND scope = 'store_ai' AND usage_day = public.conversation_india_day();

------------------------------------------------------------------------------------------------------------------
-- 3. ONE RUN PER CONVERSATION: two follow-up messages (different ids) to the same conversation at once. Exactly ONE is ok with a run, the other 'busy'.
------------------------------------------------------------------------------------------------------------------
UPDATE public.conversation_usage SET used = 0, reserved = 0
  WHERE store_id = '00000013-0000-4000-8000-0000000000b1' AND scope = 'store_ai' AND usage_day = public.conversation_india_day();
-- Tab A:
BEGIN;
SELECT public.conversation_post_message('00000013-0000-4000-8000-0000000000b1', '00000013-0000-4000-8000-0000000000c1', gen_random_uuid(), 'follow a', 'n') AS a_result;
SELECT pg_sleep(15);
COMMIT;
-- Tab B:
SELECT public.conversation_post_message('00000013-0000-4000-8000-0000000000b1', '00000013-0000-4000-8000-0000000000c1', gen_random_uuid(), 'follow b', 'n') AS b_result;
-- CHECK: one result has a run_id, the other reason = 'busy'; reserved must be 1; the conversation must have exactly 2 messages.
SELECT (SELECT reserved FROM public.conversation_usage WHERE store_id = '00000013-0000-4000-8000-0000000000b1' AND scope = 'store_ai'
          AND usage_day = public.conversation_india_day()) AS reserved_must_be_1,
       (SELECT count(*) FROM public.conversation_messages WHERE conversation_id = '00000013-0000-4000-8000-0000000000c1') AS messages_must_be_2;

------------------------------------------------------------------------------------------------------------------
-- 4. IDEMPOTENT SUBMISSION: the SAME message id submitted twice at once (a double click). Exactly one persists, the other is a duplicate.
-- First finish the run from scenario 3 (as tab C, any time before this scenario):
--   SELECT public.conversation_finish_run('00000013-0000-4000-8000-0000000000b1', '00000013-0000-4000-8000-0000000000c1',
--     (SELECT ai_run_id FROM public.conversations WHERE id = '00000013-0000-4000-8000-0000000000c1'), 'failed', 'notice', 'n', 'unavailable', '[]', NULL, '[]');
------------------------------------------------------------------------------------------------------------------
-- Tab A:
BEGIN;
SELECT public.conversation_post_message('00000013-0000-4000-8000-0000000000b1', '00000013-0000-4000-8000-0000000000c1', '00000013-0000-4000-8000-0000000000e1', 'same', 'n') AS a_result;
SELECT pg_sleep(15);
COMMIT;
-- Tab B:
SELECT public.conversation_post_message('00000013-0000-4000-8000-0000000000b1', '00000013-0000-4000-8000-0000000000c1', '00000013-0000-4000-8000-0000000000e1', 'same', 'n') AS b_result;
-- CHECK: one result ok with duplicate false, the other duplicate true (or busy if it ran after A's run started: also correct, nothing saved twice).
SELECT count(*) AS must_be_1 FROM public.conversation_messages WHERE client_msg_id = '00000013-0000-4000-8000-0000000000e1';

------------------------------------------------------------------------------------------------------------------
-- 5. SETTLE ONCE: two finish calls for the same run at once. Exactly one changes anything.
------------------------------------------------------------------------------------------------------------------
-- Tab A:
BEGIN;
SELECT public.conversation_finish_run('00000013-0000-4000-8000-0000000000b1', '00000013-0000-4000-8000-0000000000c1',
  (SELECT ai_run_id FROM public.conversations WHERE id = '00000013-0000-4000-8000-0000000000c1'), 'answered', 'text', 'done', NULL, '[]', NULL, '[]')->>'changed' AS a_changed;
SELECT pg_sleep(15);
COMMIT;
-- Tab B (use the SAME run id: read it in tab A before pressing Run, then paste it here):
-- SELECT public.conversation_finish_run('00000013-0000-4000-8000-0000000000b1', '00000013-0000-4000-8000-0000000000c1', '<run id>', 'answered', 'text', 'done', NULL, '[]', NULL, '[]')->>'changed' AS b_changed;
-- CHECK: exactly one changed = true; used goes up by exactly 1 and reserved is 0.
SELECT used, reserved FROM public.conversation_usage
  WHERE store_id = '00000013-0000-4000-8000-0000000000b1' AND scope = 'store_ai' AND usage_day = public.conversation_india_day();

------------------------------------------------------------------------------------------------------------------
-- 9. CLEANUP
------------------------------------------------------------------------------------------------------------------
DELETE FROM public.stores WHERE id = '00000013-0000-4000-8000-0000000000b1';
DELETE FROM public.owners WHERE id = '00000013-0000-4000-8000-0000000000a1';
