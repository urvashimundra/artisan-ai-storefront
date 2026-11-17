-- Manual smoke test for migration 013. Run the WHOLE file in the Supabase SQL editor (default postgres role) on STAGING, AFTER migration 013.
-- Success: one row with "ALL CHECKS PASSED". Failure: an error "FAIL: <check name>".
-- Leaves no data: all work runs in a sub-transaction that is always rolled back (sentinel SQLSTATE AB001). All rows use the prefix "smoke-013".

CREATE OR REPLACE FUNCTION pg_temp.check_that(p_ok boolean, p_name text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN
    RAISE EXCEPTION 'FAIL: %', p_name;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.rejects(p_sql text, p_constraint text, p_name text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RAISE EXCEPTION 'FAIL: % (invalid value accepted)', p_name;
EXCEPTION WHEN check_violation OR not_null_violation OR unique_violation OR foreign_key_violation THEN
  IF position(p_constraint IN SQLERRM) = 0 THEN
    RAISE EXCEPTION 'FAIL: % (rejected by the wrong constraint: %)', p_name, SQLERRM;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.start_chat(p_store uuid, p_phone text, p_tag text) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT public.conversation_start(p_store, NULL, 'en', 'Smoke', p_phone, encode(sha256(convert_to('smoke-013-' || p_tag, 'UTF8')), 'hex'),
    'smoke013enc', gen_random_uuid(), gen_random_uuid(), 'Hello ' || p_tag, 'Limit reached notice')
$$;

CREATE OR REPLACE FUNCTION pg_temp.smoke_013() RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_owner uuid; v_store uuid; v_other uuid; v_owner2 uuid;
  v_r jsonb; v_conv uuid; v_run uuid; v_msg uuid := gen_random_uuid(); v_key uuid := gen_random_uuid();
  v_usage public.conversation_usage; v_day date := public.conversation_india_day();
  v_phone text := '9876500013';
BEGIN
  INSERT INTO public.owners (email, password_hash) VALUES ('smoke-013-' || gen_random_uuid() || '@example.invalid', 'x') RETURNING id INTO v_owner;
  INSERT INTO public.stores (owner_id, slug, name, default_language, story)
    VALUES (v_owner, 'smoke-013-' || substr(gen_random_uuid()::text, 1, 8), 'Smoke 013', 'en', 'story') RETURNING id INTO v_store;
  INSERT INTO public.owners (email, password_hash) VALUES ('smoke-013b-' || gen_random_uuid() || '@example.invalid', 'x') RETURNING id INTO v_owner2;
  INSERT INTO public.stores (owner_id, slug, name, default_language, story)
    VALUES (v_owner2, 'smoke-013-' || substr(gen_random_uuid()::text, 1, 8), 'Smoke 013 other', 'en', 'story') RETURNING id INTO v_other;

  -- start: creates the conversation, message 1, and starts a run (reserved 1) --------------------------------------------
  v_r := public.conversation_start(v_store, NULL, 'en', 'Asha', v_phone, repeat('a', 64), 'enc013', v_key, v_msg, 'Is this in stock?', 'notice');
  PERFORM pg_temp.check_that((v_r->>'ok')::boolean AND NOT (v_r->>'duplicate')::boolean AND v_r->>'run_id' IS NOT NULL, 'start ok with a run');
  v_conv := (v_r->>'conversation_id')::uuid; v_run := (v_r->>'run_id')::uuid;
  PERFORM pg_temp.check_that((SELECT message_count = 1 AND ai_run_id = v_run AND last_message_role = 'customer' FROM public.conversations WHERE id = v_conv), 'conversation row after start');
  SELECT * INTO v_usage FROM public.conversation_usage WHERE store_id = v_store AND scope = 'store_ai' AND usage_day = v_day;
  PERFORM pg_temp.check_that(v_usage.reserved = 1 AND v_usage.used = 0, 'store reservation taken');
  PERFORM pg_temp.check_that((SELECT used = 1 AND subject <> v_phone FROM public.conversation_usage WHERE store_id = v_store AND scope = 'customer'),
    'customer slot counted, subject is a hash not the number');

  -- start is idempotent on start_key ------------------------------------------------------------------------------------
  v_r := public.conversation_start(v_store, NULL, 'en', 'Asha', v_phone, repeat('b', 64), 'other', v_key, gen_random_uuid(), 'Is this in stock?', 'notice');
  PERFORM pg_temp.check_that((v_r->>'duplicate')::boolean AND (v_r->>'conversation_id')::uuid = v_conv AND v_r->>'token_enc' = 'enc013', 'start repeat is a duplicate');
  PERFORM pg_temp.check_that((SELECT count(*) = 1 FROM public.conversations WHERE store_id = v_store)
    AND (SELECT used = 1 FROM public.conversation_usage WHERE store_id = v_store AND scope = 'customer'), 'repeat created nothing and used no slot');

  -- one run in flight per conversation -------------------------------------------------------------------------------------
  v_r := public.conversation_post_message(v_store, v_conv, gen_random_uuid(), 'second', 'notice');
  PERFORM pg_temp.check_that(NOT (v_r->>'ok')::boolean AND v_r->>'reason' = 'busy', 'post while a run is in flight is busy');

  -- cross-store access -----------------------------------------------------------------------------------------------------
  v_r := public.conversation_post_message(v_other, v_conv, gen_random_uuid(), 'x', 'notice');
  PERFORM pg_temp.check_that(v_r->>'reason' = 'not_found', 'another store cannot post');
  v_r := public.conversation_finish_run(v_other, v_conv, v_run, 'answered', 'text', 'x', NULL, '[]', NULL, '[]');
  PERFORM pg_temp.check_that(NOT (v_r->>'changed')::boolean, 'another store cannot finish the run');
  PERFORM pg_temp.check_that(public.conversation_delete(v_other, v_conv) = 'none', 'another store cannot delete');

  -- finish a wrong run id does nothing; the right one settles ---------------------------------------------------------------
  v_r := public.conversation_finish_run(v_store, v_conv, gen_random_uuid(), 'answered', 'text', 'x', NULL, '[]', NULL, '[]');
  PERFORM pg_temp.check_that(NOT (v_r->>'changed')::boolean, 'wrong run id changes nothing');
  v_r := public.conversation_finish_run(v_store, v_conv, v_run, 'answered', 'text', 'In stock.', NULL, '[{"label":"live_catalog"}]', NULL, '["Checked product"]');
  PERFORM pg_temp.check_that((v_r->>'changed')::boolean AND NOT (v_r->>'became_needs_you')::boolean, 'answered finish');
  SELECT * INTO v_usage FROM public.conversation_usage WHERE store_id = v_store AND scope = 'store_ai' AND usage_day = v_day;
  PERFORM pg_temp.check_that(v_usage.reserved = 0 AND v_usage.used = 1, 'answered settles: reserved 0, used 1');
  v_r := public.conversation_finish_run(v_store, v_conv, v_run, 'answered', 'text', 'again', NULL, '[]', NULL, '[]');
  PERFORM pg_temp.check_that(NOT (v_r->>'changed')::boolean AND (SELECT message_count = 2 FROM public.conversations WHERE id = v_conv), 'finishing twice changes nothing');
  PERFORM pg_temp.check_that((SELECT ai_run_id IS NULL AND last_message_role = 'assistant' FROM public.conversations WHERE id = v_conv), 'run cleared');

  -- follow-up message: idempotent on the message id --------------------------------------------------------------------------
  v_r := public.conversation_post_message(v_store, v_conv, v_msg, 'dup of the first id', 'notice');
  PERFORM pg_temp.check_that((v_r->>'duplicate')::boolean, 'reusing a message id is a duplicate');
  v_msg := gen_random_uuid();
  v_r := public.conversation_post_message(v_store, v_conv, v_msg, 'Do you ship to Pune?', 'notice');
  PERFORM pg_temp.check_that((v_r->>'ok')::boolean AND v_r->>'run_id' IS NOT NULL, 'follow-up starts a run');
  v_run := (v_r->>'run_id')::uuid;
  v_r := public.conversation_post_message(v_store, v_conv, v_msg, 'Do you ship to Pune?', 'notice');
  PERFORM pg_temp.check_that((v_r->>'duplicate')::boolean AND v_r->>'run_id' IS NULL, 'retry of the same message neither saves nor runs twice');
  PERFORM pg_temp.check_that((SELECT count(*) = 3 FROM public.conversation_messages WHERE conversation_id = v_conv), 'three messages so far');

  -- escalation and failure release the reservation, never use an answer; escalation alerts once ---------------------------------
  v_r := public.conversation_finish_run(v_store, v_conv, v_run, 'escalated', 'escalation', 'The seller will reply.', 'not_in_document', '[]', NULL, '[]');
  PERFORM pg_temp.check_that((v_r->>'became_needs_you')::boolean AND (v_r->>'escalation_count')::int = 1, 'escalation becomes needs_you once');
  SELECT * INTO v_usage FROM public.conversation_usage WHERE store_id = v_store AND scope = 'store_ai' AND usage_day = v_day;
  PERFORM pg_temp.check_that(v_usage.reserved = 0 AND v_usage.used = 1, 'escalation releases without using an answer');
  v_r := public.conversation_post_message(v_store, v_conv, gen_random_uuid(), 'hello?', 'notice');
  v_run := (v_r->>'run_id')::uuid;
  v_r := public.conversation_finish_run(v_store, v_conv, v_run, 'failed', 'notice', 'Assistant unavailable.', 'provider_error', '[]', NULL, '[]');
  PERFORM pg_temp.check_that(NOT (v_r->>'became_needs_you')::boolean AND (v_r->>'escalation_count')::int = 1, 'second escalation while needs_you does not alert again');
  SELECT * INTO v_usage FROM public.conversation_usage WHERE store_id = v_store AND scope = 'store_ai' AND usage_day = v_day;
  PERFORM pg_temp.check_that(v_usage.reserved = 0 AND v_usage.used = 1, 'failure releases without using an answer');

  -- seller reply: appended to the same conversation, idempotent, handled ------------------------------------------------------
  v_msg := gen_random_uuid();
  v_r := public.conversation_seller_reply(v_store, v_conv, v_msg, 'Yes, we ship to Pune.');
  PERFORM pg_temp.check_that((v_r->>'ok')::boolean AND NOT (v_r->>'duplicate')::boolean, 'seller reply saved');
  v_r := public.conversation_seller_reply(v_store, v_conv, v_msg, 'Yes, we ship to Pune.');
  PERFORM pg_temp.check_that((v_r->>'duplicate')::boolean AND (SELECT count(*) = 1 FROM public.conversation_messages WHERE conversation_id = v_conv AND role = 'seller'),
    'seller reply double submit adds one message');
  PERFORM pg_temp.check_that((SELECT status = 'handled' AND last_message_role = 'seller' FROM public.conversations WHERE id = v_conv), 'seller reply marks handled');
  PERFORM pg_temp.check_that(public.conversation_seller_reply(v_other, v_conv, gen_random_uuid(), 'x')->>'reason' = 'not_found', 'seller of another store cannot reply');

  -- customer limit: 6 per customer per store per India day, counted even when the AI fails -----------------------------------
  v_r := pg_temp.start_chat(v_store, '9876500099', 'l1');
  FOR i IN 2..6 LOOP
    v_r := public.conversation_post_message(v_store, (v_r->>'conversation_id')::uuid, gen_random_uuid(), 'q', 'n');
  END LOOP;
  PERFORM pg_temp.check_that(v_r->>'reason' = 'busy', 'busy blocks follow-ups while a run is in flight (limit not consumed by refused posts)');
  PERFORM pg_temp.check_that((SELECT used = 1 FROM public.conversation_usage WHERE store_id = v_store AND scope = 'customer' AND subject = encode(sha256(convert_to('9876500099', 'UTF8')), 'hex')),
    'refused (busy) posts did not consume question slots');
  FOR i IN 2..6 LOOP
    v_r := pg_temp.start_chat(v_store, '9876500098', 'c' || i);
    PERFORM pg_temp.check_that((v_r->>'ok')::boolean, 'customer question within limit');
  END LOOP;
  v_r := pg_temp.start_chat(v_store, '9876500098', 'c1');
  PERFORM pg_temp.check_that((v_r->>'ok')::boolean, 'sixth question allowed');
  v_r := pg_temp.start_chat(v_store, '9876500098', 'c7');
  PERFORM pg_temp.check_that(NOT (v_r->>'ok')::boolean AND v_r->>'reason' = 'customer_limit', 'seventh question refused');
  PERFORM pg_temp.check_that(NOT EXISTS (SELECT 1 FROM public.conversations WHERE token_hash = encode(sha256(convert_to('smoke-013-c7', 'UTF8')), 'hex')), 'refused start persisted nothing');
  v_r := pg_temp.start_chat(v_other, '9876500098', 'o1');
  PERFORM pg_temp.check_that((v_r->>'ok')::boolean, 'the limit is per store');

  -- store limit: 200 answers per store per day; reservations count; escalation does not consume ---------------------------------
  UPDATE public.conversation_usage SET used = 198, reserved = 0 WHERE store_id = v_store AND scope = 'store_ai' AND usage_day = v_day;
  v_r := pg_temp.start_chat(v_store, '9876500071', 's1');
  PERFORM pg_temp.check_that(v_r->>'run_id' IS NOT NULL, '199th answer reserved');
  v_r := pg_temp.start_chat(v_store, '9876500072', 's2');
  PERFORM pg_temp.check_that(v_r->>'run_id' IS NOT NULL, '200th answer reserved');
  v_r := pg_temp.start_chat(v_store, '9876500073', 's3');
  PERFORM pg_temp.check_that(v_r->>'run_id' IS NULL AND (v_r->>'escalated')::boolean, '201st is escalated to the seller, no run');
  PERFORM pg_temp.check_that((SELECT status = 'needs_you' AND flag_reason = 'store_limit' FROM public.conversations WHERE id = (v_r->>'conversation_id')::uuid)
    AND (SELECT count(*) = 2 FROM public.conversation_messages WHERE conversation_id = (v_r->>'conversation_id')::uuid), 'store limit escalation saved with its notice');
  PERFORM pg_temp.check_that((SELECT used + reserved = 200 FROM public.conversation_usage WHERE store_id = v_store AND scope = 'store_ai' AND usage_day = v_day),
    'used + reserved capped at 200');

  -- purge: 12 months after the last activity, only old rows --------------------------------------------------------------------
  UPDATE public.conversations SET last_activity_at = now() - interval '13 months', ai_run_id = NULL, ai_run_day = NULL, ai_run_started_at = NULL WHERE id = v_conv;
  v_r := public.conversation_purge_expired(200, false);
  PERFORM pg_temp.check_that((v_r->>'conversations')::int >= 1 AND NOT EXISTS (SELECT 1 FROM public.conversations WHERE id = v_conv)
    AND NOT EXISTS (SELECT 1 FROM public.conversation_messages WHERE conversation_id = v_conv), 'purge deletes expired conversations and their messages');
  PERFORM pg_temp.check_that(EXISTS (SELECT 1 FROM public.conversations WHERE store_id = v_store), 'purge keeps recent conversations');

  -- seller deletion removes the conversation, messages and token material --------------------------------------------------------
  UPDATE public.conversation_usage SET used = 10, reserved = 0 WHERE store_id = v_store AND scope = 'store_ai' AND usage_day = v_day;
  v_r := pg_temp.start_chat(v_store, '9876500055', 'd1');
  v_conv := (v_r->>'conversation_id')::uuid;
  PERFORM pg_temp.check_that((SELECT reserved = 1 FROM public.conversation_usage WHERE store_id = v_store AND scope = 'store_ai' AND usage_day = v_day), 'run in flight reserved');
  PERFORM pg_temp.check_that(public.conversation_delete(v_store, v_conv) = 'conversation', 'seller deletes a conversation');
  PERFORM pg_temp.check_that(NOT EXISTS (SELECT 1 FROM public.conversations WHERE id = v_conv OR token_hash = encode(sha256(convert_to('smoke-013-d1', 'UTF8')), 'hex'))
    AND NOT EXISTS (SELECT 1 FROM public.conversation_messages WHERE conversation_id = v_conv), 'deletion removed rows and token');
  PERFORM pg_temp.check_that((SELECT reserved = 0 AND used = 10 FROM public.conversation_usage WHERE store_id = v_store AND scope = 'store_ai' AND usage_day = v_day),
    'deleting an in-flight conversation released its reservation without using an answer');

  -- table constraints -----------------------------------------------------------------------------------------------------------
  PERFORM pg_temp.rejects(format('INSERT INTO public.conversations (store_id, language, customer_name, customer_phone, token_hash, start_key) VALUES (%L, ''en'', ''A'', ''12'', %L, %L)',
    v_store, repeat('c', 64), gen_random_uuid()), 'conversations_customer_phone_check', 'short phone');
  PERFORM pg_temp.rejects(format('INSERT INTO public.conversations (store_id, language, customer_name, customer_phone, token_hash, start_key) VALUES (%L, ''fr'', ''A'', ''9876543210'', %L, %L)',
    v_store, repeat('d', 64), gen_random_uuid()), 'conversations_language_check', 'language');
  PERFORM pg_temp.rejects(format('INSERT INTO public.conversations (store_id, language, customer_name, customer_phone, token_hash, start_key) VALUES (%L, ''en'', ''A'', ''9876543210'', %L, %L)',
    gen_random_uuid(), repeat('e', 64), gen_random_uuid()), 'conversations_store_fkey', 'unknown store');
  PERFORM pg_temp.rejects(format('INSERT INTO public.conversation_usage (store_id, usage_day, scope, used) VALUES (%L, current_date, ''customer'', -1)', v_store),
    'conversation_usage_counts_check', 'negative usage');

  -- RLS on, no policies, browser roles have nothing, service_role only on functions -----------------------------------------------
  PERFORM pg_temp.check_that((SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('public.conversations'::regclass, 'public.conversation_messages'::regclass,
    'public.conversation_usage'::regclass)), 'RLS enabled on all three tables');
  PERFORM pg_temp.check_that(NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename LIKE 'conversation%'), 'no policies');
  PERFORM pg_temp.check_that(NOT has_function_privilege('anon', 'public.conversation_start(uuid, uuid, text, text, text, text, text, uuid, uuid, text, text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.conversation_post_message(uuid, uuid, uuid, text, text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.conversation_purge_expired(integer, boolean)', 'EXECUTE')
    AND has_function_privilege('service_role', 'public.conversation_delete(uuid, uuid)', 'EXECUTE'), 'function privileges');

  RAISE EXCEPTION 'smoke complete, rolling back' USING ERRCODE = 'AB001';
EXCEPTION
  WHEN SQLSTATE 'AB001' THEN
    RETURN 'ALL CHECKS PASSED';
END;
$$;

SELECT pg_temp.smoke_013() AS result;
