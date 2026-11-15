-- Manual smoke test for migration 005. Run the WHOLE file in the Supabase SQL editor (as the default postgres role),
-- AFTER migration 005 is applied. Success: one row with "ALL CHECKS PASSED". Failure: an error "FAIL: <check name>".
-- Leaves no data: all work runs in a sub-transaction that is always rolled back (sentinel SQLSTATE AB001).
-- Single session only: it proves the token and atomicity rules serially. It cannot prove behaviour under two
-- simultaneous connections (row-lock waits); that needs two SQL editor tabs and is not covered here.
-- Do NOT run db/test/004_product_smoke.sql after this migration: it calls the dropped 004 signatures.

CREATE OR REPLACE FUNCTION pg_temp.check_that(p_ok boolean, p_name text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN
    RAISE EXCEPTION 'FAIL: %', p_name;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.tr3(p_en_title text) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'en', jsonb_build_object('title', p_en_title, 'description', 'en description', 'alt_text', 'en alt'),
    'gu', jsonb_build_object('title', 'gu title', 'description', 'gu description', 'alt_text', 'gu alt'),
    'hi', jsonb_build_object('title', 'hi title', 'description', 'hi description', 'alt_text', 'hi alt'));
$$;

-- Same conditional UPDATE the backend issues to claim a generation. Returns the new token, or NULL when not claimable.
CREATE OR REPLACE FUNCTION pg_temp.claim(p_store uuid, p_product uuid, p_story text) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_token uuid := gen_random_uuid(); v_n int;
BEGIN
  UPDATE public.products
    SET ai_status = 'generating', ai_started_at = now(), ai_generation_id = v_token, story = p_story, updated_at = now()
    WHERE id = p_product AND store_id = p_store AND status = 'draft'
      AND (ai_status <> 'generating' OR ai_started_at IS NULL OR ai_started_at < now() - interval '180 seconds');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN CASE WHEN v_n = 1 THEN v_token ELSE NULL END;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.smoke_005() RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_owner_a uuid; v_owner_b uuid; v_store_a uuid; v_store_b uuid;
  v_p uuid; v_p2 uuid; v_p3 uuid; v_p4 uuid;
  v_t1 uuid; v_t2 uuid; v_r jsonb; v_n int;
  v_before_product jsonb; v_before_translations jsonb;
BEGIN
  INSERT INTO public.owners (email, password_hash)
    VALUES ('smoke-005a-' || gen_random_uuid() || '@example.invalid', 'x') RETURNING id INTO v_owner_a;
  INSERT INTO public.owners (email, password_hash)
    VALUES ('smoke-005b-' || gen_random_uuid() || '@example.invalid', 'x') RETURNING id INTO v_owner_b;
  INSERT INTO public.stores (owner_id, slug, name, default_language, story)
    VALUES (v_owner_a, 'smoke-005a-' || substr(gen_random_uuid()::text, 1, 8), 'Smoke A', 'en', 'story') RETURNING id INTO v_store_a;
  INSERT INTO public.stores (owner_id, slug, name, default_language, story)
    VALUES (v_owner_b, 'smoke-005b-' || substr(gen_random_uuid()::text, 1, 8), 'Smoke B', 'en', 'story') RETURNING id INTO v_store_b;
  INSERT INTO public.products (store_id, image_path) VALUES (v_store_a, v_store_a || '/p/x.jpg') RETURNING id INTO v_p;

  -- claims: one owner at a time, fresh token each time ------------------------------------------
  v_t1 := pg_temp.claim(v_store_a, v_p, 'story one');
  PERFORM pg_temp.check_that(v_t1 IS NOT NULL, 'claim: first claim succeeds');
  PERFORM pg_temp.check_that(pg_temp.claim(v_store_a, v_p, 'story two') IS NULL, 'claim: second claim while generating gets nothing');
  PERFORM pg_temp.check_that((SELECT ai_generation_id FROM public.products WHERE id = v_p) = v_t1
    AND (SELECT story FROM public.products WHERE id = v_p) = 'story one', 'claim: loser changed neither token nor story');
  PERFORM pg_temp.check_that(pg_temp.claim(v_store_b, v_p, 'x') IS NULL, 'claim: other store gets nothing');

  -- save_ai_listing: missing / stale / wrong token write nothing ---------------------------------
  v_r := public.save_ai_listing(v_store_a, v_p, NULL, pg_temp.tr3('t'), 'm', 1, 1, 1);
  PERFORM pg_temp.check_that(NOT (v_r->>'ok')::boolean AND v_r->>'reason' = 'stale_generation', 'ai listing: NULL token refused');
  v_r := public.save_ai_listing(v_store_a, v_p, gen_random_uuid(), pg_temp.tr3('t'), 'm', 1, 1, 1);
  PERFORM pg_temp.check_that(v_r->>'reason' = 'stale_generation', 'ai listing: wrong token refused');
  v_r := public.save_ai_listing(v_store_b, v_p, v_t1, pg_temp.tr3('t'), 'm', 1, 1, 1);
  PERFORM pg_temp.check_that(v_r->>'reason' = 'not_found', 'ai listing: other store with the right token gets not_found');
  PERFORM pg_temp.check_that((SELECT count(*) FROM public.product_translations WHERE product_id = v_p) = 0
    AND NOT EXISTS (SELECT 1 FROM public.ai_drafts WHERE target_id = v_p), 'ai listing: refusals wrote no translations and no audit row');
  PERFORM pg_temp.check_that((SELECT ai_status FROM public.products WHERE id = v_p) = 'generating'
    AND (SELECT ai_generation_id FROM public.products WHERE id = v_p) = v_t1, 'ai listing: refusals left the generation state alone');

  -- review is refused while a generation is live, and changes nothing --------------------------
  v_r := public.save_product_review(v_store_a, v_p, 'manual story', 7, 5000, pg_temp.tr3('manual'), ARRAY['en'], false);
  PERFORM pg_temp.check_that(NOT (v_r->>'ok')::boolean AND v_r->>'reason' = 'generating', 'review: refused while generating');
  PERFORM pg_temp.check_that((SELECT story FROM public.products WHERE id = v_p) = 'story one'
    AND (SELECT stock FROM public.products WHERE id = v_p) IS NULL
    AND (SELECT price_paise FROM public.products WHERE id = v_p) IS NULL
    AND (SELECT count(*) FROM public.product_translations WHERE product_id = v_p) = 0, 'review: generating refusal left story, stock, price and translations untouched');

  -- a superseded (stale) run cannot save over the newer claim -----------------------------------
  UPDATE public.products SET ai_started_at = now() - interval '200 seconds' WHERE id = v_p;
  v_t2 := pg_temp.claim(v_store_a, v_p, 'story three');
  PERFORM pg_temp.check_that(v_t2 IS NOT NULL AND v_t2 <> v_t1, 'claim: stale run is taken over with a fresh token');
  v_r := public.save_ai_listing(v_store_a, v_p, v_t1, pg_temp.tr3('old run'), 'm', 1, 1, 1);
  PERFORM pg_temp.check_that(v_r->>'reason' = 'stale_generation', 'ai listing: superseded token refused');
  PERFORM pg_temp.check_that((SELECT count(*) FROM public.product_translations WHERE product_id = v_p) = 0
    AND (SELECT ai_generation_id FROM public.products WHERE id = v_p) = v_t2, 'ai listing: superseded run wrote nothing and kept the newer token');

  -- the finish UPDATE (as issued by the backend) only matches the holder of the token ------------
  UPDATE public.products SET ai_status = 'failed', ai_started_at = NULL, ai_generation_id = NULL
    WHERE id = v_p AND store_id = v_store_a AND ai_status = 'generating' AND ai_generation_id = v_t1;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM pg_temp.check_that(v_n = 0 AND (SELECT ai_status FROM public.products WHERE id = v_p) = 'generating', 'finish: stale token clears nothing');

  -- success with the current token: translations, audit row, state and token cleared ------------
  v_r := public.save_ai_listing(v_store_a, v_p, v_t2, pg_temp.tr3('new run'), 'claude-haiku-5-5', 10, 20, 30);
  PERFORM pg_temp.check_that((v_r->>'ok')::boolean AND v_r->>'draft_id' IS NOT NULL, 'ai listing: current token succeeds');
  PERFORM pg_temp.check_that((SELECT count(*) FROM public.product_translations WHERE product_id = v_p AND source = 'ai' AND NOT approved) = 3
    AND (SELECT count(*) FROM public.ai_drafts WHERE target_id = v_p) = 1, 'ai listing: three ai translations and one audit row');
  PERFORM pg_temp.check_that((SELECT ai_status FROM public.products WHERE id = v_p) = 'idle'
    AND (SELECT ai_generation_id FROM public.products WHERE id = v_p) IS NULL
    AND (SELECT ai_started_at FROM public.products WHERE id = v_p) IS NULL, 'ai listing: state and token cleared');
  v_r := public.save_ai_listing(v_store_a, v_p, v_t2, pg_temp.tr3('replay'), 'm', 1, 1, 1);
  PERFORM pg_temp.check_that(v_r->>'reason' = 'stale_generation', 'ai listing: the token cannot be replayed after success');

  -- review after completion: story, stock, price and translations together -----------------------
  v_r := public.save_product_review(v_store_a, v_p, 'manual story', 7, 5000, pg_temp.tr3('manual'), ARRAY['en'], false);
  PERFORM pg_temp.check_that((v_r->>'ok')::boolean AND v_r->>'status' = 'draft', 'review: succeeds after generation');
  PERFORM pg_temp.check_that((SELECT story FROM public.products WHERE id = v_p) = 'manual story'
    AND (SELECT stock FROM public.products WHERE id = v_p) = 7
    AND (SELECT price_paise FROM public.products WHERE id = v_p) = 5000
    AND (SELECT title FROM public.product_translations WHERE product_id = v_p AND language = 'en') = 'manual', 'review: all fields written');

  -- review is atomic: a refusal writes nothing, story and stock included --------------------------
  v_r := public.save_product_review(v_store_a, v_p, 'refused story', 99, 5000, '{"en": {"title": "", "description": "", "alt_text": ""}}'::jsonb, ARRAY['en'], false);
  PERFORM pg_temp.check_that(v_r->>'reason' = 'invalid', 'review: approving an empty language refused');
  v_r := public.save_product_review(v_store_a, v_p, 'refused story', 99, NULL, '{}'::jsonb, ARRAY['en'], true);
  PERFORM pg_temp.check_that(v_r->>'reason' = 'price_required', 'review: publish without price refused');
  PERFORM pg_temp.check_that((SELECT story FROM public.products WHERE id = v_p) = 'manual story'
    AND (SELECT stock FROM public.products WHERE id = v_p) = 7, 'review: refusals left story and stock untouched');
  PERFORM pg_temp.check_that(public.save_product_review(v_store_a, v_p, NULL, 1, 5000, '{}'::jsonb, ARRAY[]::text[], false)->>'reason' = 'invalid', 'review: NULL story invalid');
  PERFORM pg_temp.check_that(public.save_product_review(v_store_a, v_p, repeat('x', 1501), 1, 5000, '{}'::jsonb, ARRAY[]::text[], false)->>'reason' = 'invalid', 'review: 1501 character story invalid');
  PERFORM pg_temp.check_that(public.save_product_review(v_store_a, v_p, 's', -1, 5000, '{}'::jsonb, ARRAY[]::text[], false)->>'reason' = 'invalid', 'review: negative stock invalid');
  PERFORM pg_temp.check_that(public.save_product_review(v_store_a, v_p, 's', 1000001, 5000, '{}'::jsonb, ARRAY[]::text[], false)->>'reason' = 'invalid', 'review: stock above 1,000,000 invalid');
  PERFORM pg_temp.check_that(public.save_product_review(v_store_b, v_p, 's', 1, 5000, '{}'::jsonb, ARRAY[]::text[], false)->>'reason' = 'not_found', 'review: other store gets not_found');
  PERFORM pg_temp.check_that((SELECT story FROM public.products WHERE id = v_p) = 'manual story', 'review: more refusals changed nothing');
  v_r := public.save_product_review(v_store_a, v_p, '', NULL, 5000, '{}'::jsonb, ARRAY['en'], false);
  PERFORM pg_temp.check_that((v_r->>'ok')::boolean AND (SELECT stock FROM public.products WHERE id = v_p) IS NULL
    AND (SELECT story FROM public.products WHERE id = v_p) = '', 'review: empty story and NULL stock are allowed');

  -- an abandoned (stale) generation does not block the owner, and the review fences the old run --
  v_t1 := pg_temp.claim(v_store_a, v_p, 'story four');
  UPDATE public.products SET ai_started_at = now() - interval '200 seconds' WHERE id = v_p;
  v_r := public.save_product_review(v_store_a, v_p, 'after crash', 2, 5000, '{}'::jsonb, ARRAY['en'], false);
  PERFORM pg_temp.check_that((v_r->>'ok')::boolean, 'review: allowed over an abandoned generation');
  PERFORM pg_temp.check_that((SELECT ai_status FROM public.products WHERE id = v_p) = 'idle'
    AND (SELECT ai_generation_id FROM public.products WHERE id = v_p) IS NULL, 'review: abandoned generation state and token cleared');
  v_r := public.save_ai_listing(v_store_a, v_p, v_t1, pg_temp.tr3('zombie'), 'm', 1, 1, 1);
  PERFORM pg_temp.check_that(v_r->>'reason' = 'stale_generation', 'ai listing: the abandoned run is fenced out by the review');

  -- a generating product with a NULL timestamp is abandoned; review clears its token ------------
  INSERT INTO public.products (store_id, image_path) VALUES (v_store_a, v_store_a || '/p3/x.jpg') RETURNING id INTO v_p3;
  v_t1 := gen_random_uuid();
  UPDATE public.products
    SET ai_status = 'generating', ai_started_at = NULL, ai_generation_id = v_t1
    WHERE id = v_p3 AND store_id = v_store_a;
  v_r := public.save_product_review(v_store_a, v_p3, 'review after null timestamp', 12, 7500,
    pg_temp.tr3('null timestamp review'), ARRAY['en'], false);
  PERFORM pg_temp.check_that((v_r->>'ok')::boolean, 'review: NULL generation timestamp is treated as abandoned');
  PERFORM pg_temp.check_that((SELECT ai_status = 'idle' AND ai_started_at IS NULL AND ai_generation_id IS NULL
    FROM public.products WHERE id = v_p3), 'review: NULL timestamp review clears generation state and token');
  PERFORM pg_temp.check_that((SELECT story = 'review after null timestamp' AND stock = 12 AND price_paise = 7500
    FROM public.products WHERE id = v_p3)
    AND (SELECT title = 'null timestamp review' FROM public.product_translations
      WHERE product_id = v_p3 AND language = 'en'),
    'review: NULL timestamp review saves story, stock, price and translation');
  v_r := public.save_ai_listing(v_store_a, v_p3, v_t1, pg_temp.tr3('late null timestamp run'), 'm', 1, 1, 1);
  PERFORM pg_temp.check_that(v_r->>'reason' = 'stale_generation',
    'review: old token after NULL timestamp review is fenced out');

  -- an already-published product cannot lose default-language approval on Save -------------------
  INSERT INTO public.products (store_id, image_path) VALUES (v_store_a, v_store_a || '/p4/x.jpg') RETURNING id INTO v_p4;
  v_r := public.save_product_review(v_store_a, v_p4, 'initial published story', 5, 9000,
    pg_temp.tr3('initial published title'), ARRAY['en'], true);
  PERFORM pg_temp.check_that((v_r->>'ok')::boolean AND v_r->>'status' = 'published',
    'review: setup publishes product with default language approved');
  SELECT to_jsonb(p) INTO v_before_product FROM public.products p WHERE p.id = v_p4;
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.language), '[]'::jsonb)
    INTO v_before_translations FROM public.product_translations t WHERE t.product_id = v_p4;
  v_r := public.save_product_review(v_store_a, v_p4, 'should not be saved', 99, 12000,
    pg_temp.tr3('changed title'), ARRAY[]::text[], false);
  PERFORM pg_temp.check_that(NOT (v_r->>'ok')::boolean AND v_r->>'reason' = 'default_language_not_approved',
    'review: published product cannot lose default-language approval on Save');
  PERFORM pg_temp.check_that((SELECT to_jsonb(p) = v_before_product FROM public.products p WHERE p.id = v_p4)
    AND (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.language), '[]'::jsonb) = v_before_translations
      FROM public.product_translations t WHERE t.product_id = v_p4),
    'review: rejected published Save leaves product and translations completely unchanged');

  -- deleting the product invalidates the token ----------------------------------------------------
  INSERT INTO public.products (store_id, image_path) VALUES (v_store_a, v_store_a || '/p2/x.jpg') RETURNING id INTO v_p2;
  v_t1 := pg_temp.claim(v_store_a, v_p2, 'doomed');
  DELETE FROM public.products WHERE id = v_p2;
  v_r := public.save_ai_listing(v_store_a, v_p2, v_t1, pg_temp.tr3('late'), 'm', 1, 1, 1);
  PERFORM pg_temp.check_that(v_r->>'reason' = 'not_found', 'delete: late save after deletion gets not_found');
  PERFORM pg_temp.check_that(NOT EXISTS (SELECT 1 FROM public.ai_drafts WHERE target_id = v_p2)
    AND NOT EXISTS (SELECT 1 FROM public.product_translations WHERE product_id = v_p2), 'delete: late save wrote nothing');

  RAISE EXCEPTION 'smoke complete, rolling back' USING ERRCODE = 'AB001';
EXCEPTION
  WHEN SQLSTATE 'AB001' THEN
    RETURN 'ALL CHECKS PASSED';
END;
$$;

SELECT pg_temp.smoke_005() AS result;
