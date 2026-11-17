-- Manual smoke test for migration 012. Run the WHOLE file in the Supabase SQL editor (as the default postgres role),
-- AFTER migration 012 is applied. Success: one row with "ALL CHECKS PASSED". Failure: an error "FAIL: <check name>".
-- Leaves no data: all work runs in a sub-transaction that is always rolled back (sentinel SQLSTATE AB001).
-- Every CHECK is shown to accept valid values and to reject invalid ones, by constraint name.

CREATE OR REPLACE FUNCTION pg_temp.check_that(p_ok boolean, p_name text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN
    RAISE EXCEPTION 'FAIL: %', p_name;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.accepts(p_sql text, p_name text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
EXCEPTION WHEN check_violation OR not_null_violation OR unique_violation OR foreign_key_violation THEN
  RAISE EXCEPTION 'FAIL: % (valid value rejected: %)', p_name, SQLERRM;
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

CREATE OR REPLACE FUNCTION pg_temp.smoke_012() RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_owner uuid; v_store uuid; v_other uuid; v_product uuid; v_row public.enquiries;
  v_hash text := repeat('a', 64); v_ins text; v_upd text; v_know text;
BEGIN
  INSERT INTO public.owners (email, password_hash)
    VALUES ('smoke-012-' || gen_random_uuid() || '@example.invalid', 'x') RETURNING id INTO v_owner;
  INSERT INTO public.stores (owner_id, slug, name, default_language, story)
    VALUES (v_owner, 'smoke-012-' || substr(gen_random_uuid()::text, 1, 8), 'Smoke 012', 'gu', 'story') RETURNING id INTO v_store;
  INSERT INTO public.owners (email, password_hash)
    VALUES ('smoke-012b-' || gen_random_uuid() || '@example.invalid', 'x') RETURNING id INTO v_product;
  INSERT INTO public.stores (owner_id, slug, name, default_language, story)
    VALUES (v_product, 'smoke-012-' || substr(gen_random_uuid()::text, 1, 8), 'Smoke 012 other', 'gu', 'story') RETURNING id INTO v_other;
  INSERT INTO public.products (store_id, status, story, image_path) VALUES (v_store, 'draft', 'smoke', 'smoke/012.jpg') RETURNING id INTO v_product;

  v_ins := format('INSERT INTO public.enquiries (store_id, language, customer_name, customer_phone, question, token_hash) VALUES (%L, ''en'', ''Asha'', ''919876543210'', ''Do you ship?'', ', v_store);
  v_upd := format('UPDATE public.enquiries SET %%s WHERE store_id = %L', v_store);
  v_know := format('UPDATE public.store_knowledge SET %%s WHERE store_id = %L', v_store);

  -- store_knowledge ---------------------------------------------------------------------------------------
  PERFORM pg_temp.accepts(format('INSERT INTO public.store_knowledge (store_id) VALUES (%L)', v_store), 'knowledge row with defaults');
  PERFORM pg_temp.check_that((SELECT content = '' AND bulk_rules = '[]'::jsonb AND updated_at IS NOT NULL FROM public.store_knowledge WHERE store_id = v_store),
    'knowledge defaults: empty content, no rules');
  PERFORM pg_temp.rejects(format('INSERT INTO public.store_knowledge (store_id) VALUES (%L)', v_store), 'store_knowledge_pkey', 'one knowledge row per store');
  PERFORM pg_temp.rejects(format('INSERT INTO public.store_knowledge (store_id) VALUES (%L)', gen_random_uuid()), 'store_knowledge_store_fkey', 'knowledge unknown store');
  PERFORM pg_temp.accepts(format(v_know, 'content = repeat(''x'', 20000)'), 'content 20000 ascii');
  PERFORM pg_temp.accepts(format(v_know, 'content = repeat(''અ'', 20000)'), 'content 20000 gujarati code points');
  PERFORM pg_temp.rejects(format(v_know, 'content = repeat(''x'', 20001)'), 'store_knowledge_content_length_check', 'content 20001');
  PERFORM pg_temp.rejects(format(v_know, 'content = repeat(''અ'', 20001)'), 'store_knowledge_content_length_check', 'content 20001 gujarati');
  PERFORM pg_temp.rejects(format(v_know, 'content = NULL'), 'content', 'content null');
  PERFORM pg_temp.accepts(format(v_know, 'bulk_rules = ''[]''::jsonb'), 'bulk_rules empty array');
  PERFORM pg_temp.accepts(format(v_know, 'bulk_rules = ''[{"minQty":2,"percentOff":5},{"minQty":3,"percentOff":6},{"minQty":4,"percentOff":7},{"minQty":5,"percentOff":8},{"minQty":6,"percentOff":9}]''::jsonb'), 'bulk_rules five tiers');
  PERFORM pg_temp.rejects(format(v_know, 'bulk_rules = ''[1,2,3,4,5,6]''::jsonb'), 'store_knowledge_bulk_rules_check', 'bulk_rules six items');
  PERFORM pg_temp.rejects(format(v_know, 'bulk_rules = ''{"minQty":2}''::jsonb'), 'store_knowledge_bulk_rules_check', 'bulk_rules object');
  PERFORM pg_temp.rejects(format(v_know, 'bulk_rules = ''"x"''::jsonb'), 'store_knowledge_bulk_rules_check', 'bulk_rules scalar');
  PERFORM pg_temp.rejects(format(v_know, 'bulk_rules = NULL'), 'bulk_rules', 'bulk_rules null');

  -- enquiries: defaults and token --------------------------------------------------------------------------------
  EXECUTE v_ins || quote_literal(v_hash) || ')';
  SELECT * INTO v_row FROM public.enquiries WHERE token_hash = v_hash;
  PERFORM pg_temp.check_that(v_row.status = 'pending' AND v_row.trace = '[]'::jsonb AND v_row.answer_text IS NULL AND v_row.seller_reply IS NULL
    AND v_row.claimed_at IS NULL AND v_row.created_at IS NOT NULL AND v_row.updated_at IS NOT NULL AND v_row.id IS NOT NULL, 'enquiry defaults');
  PERFORM pg_temp.rejects(v_ins || quote_literal(v_hash) || ')', 'enquiries_token_hash_key', 'duplicate token hash');
  PERFORM pg_temp.rejects(v_ins || '''' || repeat('A', 64) || ''')', 'enquiries_token_hash_format_check', 'token hash uppercase');
  PERFORM pg_temp.rejects(v_ins || '''abc'')', 'enquiries_token_hash_format_check', 'token hash short');
  PERFORM pg_temp.accepts(format(v_upd, 'token_enc = ''abc_DEF-123'''), 'token_enc base64url');
  PERFORM pg_temp.accepts(format(v_upd, 'token_enc = repeat(''a'', 200)'), 'token_enc 200');
  PERFORM pg_temp.rejects(format(v_upd, 'token_enc = repeat(''a'', 201)'), 'enquiries_token_enc_check', 'token_enc 201');
  PERFORM pg_temp.rejects(format(v_upd, 'token_enc = ''has space'''), 'enquiries_token_enc_check', 'token_enc bad characters');
  PERFORM pg_temp.rejects(format(v_upd, 'token_enc = '''''), 'enquiries_token_enc_check', 'token_enc empty');
  PERFORM pg_temp.accepts(format(v_upd, 'token_enc = NULL'), 'token_enc null');

  -- language, name, phone, question ----------------------------------------------------------------------------
  PERFORM pg_temp.accepts(format(v_upd, 'language = ''gu'''), 'language gu');
  PERFORM pg_temp.accepts(format(v_upd, 'language = ''hi'''), 'language hi');
  PERFORM pg_temp.rejects(format(v_upd, 'language = ''fr'''), 'enquiries_language_check', 'language fr');
  PERFORM pg_temp.accepts(format(v_upd, 'customer_name = repeat(''x'', 80)'), 'name 80');
  PERFORM pg_temp.rejects(format(v_upd, 'customer_name = repeat(''x'', 81)'), 'enquiries_customer_name_check', 'name 81');
  PERFORM pg_temp.rejects(format(v_upd, 'customer_name = '''''), 'enquiries_customer_name_check', 'name empty');
  PERFORM pg_temp.accepts(format(v_upd, 'customer_phone = ''9876543210'''), 'phone 10 digits');
  PERFORM pg_temp.accepts(format(v_upd, 'customer_phone = repeat(''9'', 15)'), 'phone 15 digits');
  PERFORM pg_temp.rejects(format(v_upd, 'customer_phone = ''987654321'''), 'enquiries_customer_phone_check', 'phone 9 digits');
  PERFORM pg_temp.rejects(format(v_upd, 'customer_phone = repeat(''9'', 16)'), 'enquiries_customer_phone_check', 'phone 16 digits');
  PERFORM pg_temp.rejects(format(v_upd, 'customer_phone = ''+919876543210'''), 'enquiries_customer_phone_check', 'phone with plus');
  PERFORM pg_temp.accepts(format(v_upd, 'question = repeat(''અ'', 500)'), 'question 500 gujarati code points');
  PERFORM pg_temp.rejects(format(v_upd, 'question = repeat(''x'', 501)'), 'enquiries_question_check', 'question 501');
  PERFORM pg_temp.rejects(format(v_upd, 'question = '''''), 'enquiries_question_check', 'question empty');

  -- status, answer, flag reason ---------------------------------------------------------------------------------
  PERFORM pg_temp.accepts(format(v_upd, 'status = ''answering'', claimed_at = now()'), 'status answering');
  PERFORM pg_temp.accepts(format(v_upd, 'status = ''needs_you'', flag_reason = ''budget'''), 'status needs_you');
  PERFORM pg_temp.accepts(format(v_upd, 'status = ''handled'''), 'status handled');
  PERFORM pg_temp.rejects(format(v_upd, 'status = ''done'''), 'enquiries_status_check', 'status unknown');
  PERFORM pg_temp.rejects(format(v_upd, 'status = ''answered'', answer_text = NULL'), 'enquiries_answered_has_answer_check', 'answered needs an answer');
  PERFORM pg_temp.accepts(format(v_upd, 'status = ''answered'', answer_text = repeat(''x'', 3000)'), 'answer 3000');
  PERFORM pg_temp.rejects(format(v_upd, 'answer_text = repeat(''x'', 3001)'), 'enquiries_answer_text_check', 'answer 3001');
  PERFORM pg_temp.rejects(format(v_upd, 'answer_text = '''''), 'enquiries_answer_text_check', 'answer empty');
  PERFORM pg_temp.accepts(format(v_upd, 'flag_reason = ''not_in_document'''), 'flag not_in_document');
  PERFORM pg_temp.accepts(format(v_upd, 'flag_reason = ''unverified_amount'''), 'flag unverified_amount');
  PERFORM pg_temp.accepts(format(v_upd, 'flag_reason = ''daily_cap'''), 'flag daily_cap');
  PERFORM pg_temp.rejects(format(v_upd, 'flag_reason = ''bored'''), 'enquiries_flag_reason_check', 'flag unknown');

  -- trace: array of at most 12 strings ----------------------------------------------------------------------------
  PERFORM pg_temp.accepts(format(v_upd, 'trace = ''["a","b"]''::jsonb'), 'trace two strings');
  PERFORM pg_temp.accepts(format(v_upd, 'trace = (SELECT jsonb_agg(''s'') FROM generate_series(1, 12))'), 'trace 12 items');
  PERFORM pg_temp.rejects(format(v_upd, 'trace = (SELECT jsonb_agg(''s'') FROM generate_series(1, 13))'), 'enquiries_trace_check', 'trace 13 items');
  PERFORM pg_temp.rejects(format(v_upd, 'trace = ''{"a":1}''::jsonb'), 'enquiries_trace_check', 'trace object');
  PERFORM pg_temp.rejects(format(v_upd, 'trace = ''["a", 2]''::jsonb'), 'enquiries_trace_check', 'trace with a number');
  PERFORM pg_temp.rejects(format(v_upd, 'trace = NULL'), 'trace', 'trace null');

  -- seller reply: text and time travel together --------------------------------------------------------------------
  PERFORM pg_temp.accepts(format(v_upd, 'seller_reply = repeat(''x'', 1000), replied_at = now()'), 'reply 1000');
  PERFORM pg_temp.rejects(format(v_upd, 'seller_reply = repeat(''x'', 1001), replied_at = now()'), 'enquiries_seller_reply_check', 'reply 1001');
  PERFORM pg_temp.rejects(format(v_upd, 'seller_reply = '''', replied_at = now()'), 'enquiries_seller_reply_check', 'reply empty');
  PERFORM pg_temp.rejects(format(v_upd, 'replied_at = NULL'), 'enquiries_reply_pair_check', 'reply without a time');
  PERFORM pg_temp.accepts(format(v_upd, 'seller_reply = NULL, replied_at = NULL'), 'no reply');
  PERFORM pg_temp.rejects(format(v_upd, 'replied_at = now()'), 'enquiries_reply_pair_check', 'time without a reply');

  -- foreign keys: the product must belong to the same store; deleting a product keeps the enquiry ------------------
  PERFORM pg_temp.accepts(format(v_upd, format('product_id = %L', v_product)), 'product of the same store');
  PERFORM pg_temp.rejects(format('INSERT INTO public.enquiries (store_id, product_id, language, customer_name, customer_phone, question, token_hash) VALUES (%L, %L, ''en'', ''A'', ''9876543210'', ''q'', %L)', v_other, v_product, repeat('b', 64)),
    'enquiries_product_fkey', 'product of another store');
  PERFORM pg_temp.rejects(format('INSERT INTO public.enquiries (store_id, language, customer_name, customer_phone, question, token_hash) VALUES (%L, ''en'', ''A'', ''9876543210'', ''q'', %L)', gen_random_uuid(), repeat('c', 64)),
    'enquiries_store_fkey', 'unknown store');
  DELETE FROM public.products WHERE id = v_product;
  PERFORM pg_temp.check_that((SELECT product_id IS NULL AND store_id = v_store FROM public.enquiries WHERE token_hash = v_hash),
    'deleting a product clears product_id and keeps the enquiry and its store');

  -- cascade ---------------------------------------------------------------------------------------------------
  DELETE FROM public.stores WHERE id = v_store;
  PERFORM pg_temp.check_that(NOT EXISTS (SELECT 1 FROM public.enquiries WHERE token_hash = v_hash)
    AND NOT EXISTS (SELECT 1 FROM public.store_knowledge WHERE store_id = v_store), 'enquiries and knowledge cascade away with their store');

  -- RLS on, no policies, browser roles have no privileges, service_role has CRUD ----------------------------------
  PERFORM pg_temp.check_that((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.store_knowledge'::regclass), 'RLS enabled on store_knowledge');
  PERFORM pg_temp.check_that((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.enquiries'::regclass), 'RLS enabled on enquiries');
  PERFORM pg_temp.check_that(NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('store_knowledge', 'enquiries')), 'no policies');
  PERFORM pg_temp.check_that(NOT has_table_privilege('anon', 'public.enquiries', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT has_table_privilege('anon', 'public.store_knowledge', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), 'anon has no privileges');
  PERFORM pg_temp.check_that(NOT has_table_privilege('authenticated', 'public.enquiries', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT has_table_privilege('authenticated', 'public.store_knowledge', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), 'authenticated has no privileges');
  PERFORM pg_temp.check_that(has_table_privilege('service_role', 'public.enquiries', 'SELECT,INSERT,UPDATE,DELETE')
    AND has_table_privilege('service_role', 'public.store_knowledge', 'SELECT,INSERT,UPDATE,DELETE'), 'service_role has CRUD');

  RAISE EXCEPTION 'smoke complete, rolling back' USING ERRCODE = 'AB001';
EXCEPTION
  WHEN SQLSTATE 'AB001' THEN
    RETURN 'ALL CHECKS PASSED';
END;
$$;

SELECT pg_temp.smoke_012() AS result;
