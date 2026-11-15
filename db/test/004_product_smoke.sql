-- Manual smoke test for migration 004. Run the WHOLE file in the Supabase SQL editor (as the default postgres role).
-- Success: one row with "ALL CHECKS PASSED". Failure: an error starting with "FAIL:" naming the broken check.
-- Leaves no data: the checks run inside a sub-transaction that is always rolled back (a sentinel exception
-- with SQLSTATE AB001 is raised at the end and caught). Uses two throwaway owners and stores.

CREATE OR REPLACE FUNCTION pg_temp.check_that(p_ok boolean, p_name text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN
    RAISE EXCEPTION 'FAIL: %', p_name;
  END IF;
END;
$$;

-- Three complete translations; only the Gujarati title varies, so tests can edit one field.
CREATE OR REPLACE FUNCTION pg_temp.tr3(p_gu_title text) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'en', jsonb_build_object('title', 'Clay pot', 'description', 'Hand-made clay pot.', 'alt_text', 'A round clay pot.'),
    'gu', jsonb_build_object('title', p_gu_title, 'description', 'gu description', 'alt_text', 'gu alt'),
    'hi', jsonb_build_object('title', 'hi title', 'description', 'hi description', 'alt_text', 'hi alt'));
$$;

CREATE OR REPLACE FUNCTION pg_temp.smoke_004() RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_owner_a uuid; v_owner_b uuid;
  v_store_a uuid; v_store_b uuid;
  v_p1 uuid; v_p2 uuid; v_p3 uuid;
  v_r jsonb;
  v_n int;
  v_caught boolean;
BEGIN
  INSERT INTO public.owners (email, password_hash)
    VALUES ('smoke-004a-' || gen_random_uuid() || '@example.invalid', 'x') RETURNING id INTO v_owner_a;
  INSERT INTO public.owners (email, password_hash)
    VALUES ('smoke-004b-' || gen_random_uuid() || '@example.invalid', 'x') RETURNING id INTO v_owner_b;
  -- Store A defaults to Gujarati so the default-language gate is not the English row.
  INSERT INTO public.stores (owner_id, slug, name, default_language, story)
    VALUES (v_owner_a, 'smoke-004a-' || substr(gen_random_uuid()::text, 1, 8), 'Smoke A', 'gu', 'story') RETURNING id INTO v_store_a;
  INSERT INTO public.stores (owner_id, slug, name, default_language, story)
    VALUES (v_owner_b, 'smoke-004b-' || substr(gen_random_uuid()::text, 1, 8), 'Smoke B', 'en', 'story') RETURNING id INTO v_store_b;
  INSERT INTO public.products (store_id, image_path, ai_status, ai_started_at)
    VALUES (v_store_a, v_store_a || '/p1/x.jpg', 'generating', now()) RETURNING id INTO v_p1;

  -- save_ai_listing: ownership ---------------------------------------------------------------
  v_r := public.save_ai_listing(v_store_b, v_p1, pg_temp.tr3('gu title'), 'm', 1, 1, 1);
  PERFORM pg_temp.check_that(NOT (v_r->>'ok')::boolean AND v_r->>'reason' = 'not_found', 'ai listing: other store gets not_found');
  v_r := public.save_ai_listing(v_store_a, gen_random_uuid(), pg_temp.tr3('gu title'), 'm', 1, 1, 1);
  PERFORM pg_temp.check_that(v_r->>'reason' = 'not_found', 'ai listing: unknown product gets not_found');
  SELECT count(*) INTO v_n FROM public.product_translations WHERE product_id = v_p1;
  PERFORM pg_temp.check_that(v_n = 0, 'ai listing: refused calls wrote nothing');

  -- save_ai_listing: validation --------------------------------------------------------------
  v_r := public.save_ai_listing(v_store_a, v_p1, pg_temp.tr3('gu title') - 'hi', 'm', 1, 1, 1);
  PERFORM pg_temp.check_that(v_r->>'reason' = 'invalid', 'ai listing: two languages invalid');
  v_r := public.save_ai_listing(v_store_a, v_p1, pg_temp.tr3(''), 'm', 1, 1, 1);
  PERFORM pg_temp.check_that(v_r->>'reason' = 'invalid', 'ai listing: empty title invalid');
  v_r := public.save_ai_listing(v_store_a, v_p1, pg_temp.tr3(repeat('x', 101)), 'm', 1, 1, 1);
  PERFORM pg_temp.check_that(v_r->>'reason' = 'invalid', 'ai listing: 101 char title invalid');
  v_r := public.save_ai_listing(v_store_a, v_p1, pg_temp.tr3('gu title') || '{"extra": {}}'::jsonb, 'm', 1, 1, 1);
  PERFORM pg_temp.check_that(v_r->>'reason' = 'invalid', 'ai listing: extra language key invalid');
  v_r := public.save_ai_listing(v_store_a, v_p1, jsonb_set(pg_temp.tr3('gu title'), '{en,price}', '5'), 'm', 1, 1, 1);
  PERFORM pg_temp.check_that(v_r->>'reason' = 'invalid', 'ai listing: extra nested key (en) invalid');
  v_r := public.save_ai_listing(v_store_a, v_p1, jsonb_set(pg_temp.tr3('gu title'), '{hi,status}', '"published"'), 'm', 1, 1, 1);
  PERFORM pg_temp.check_that(v_r->>'reason' = 'invalid', 'ai listing: extra nested key (hi) invalid');
  v_r := public.save_ai_listing(v_store_a, v_p1, pg_temp.tr3('gu title') #- '{gu,alt_text}', 'm', 1, 1, 1);
  PERFORM pg_temp.check_that(v_r->>'reason' = 'invalid', 'ai listing: missing nested key invalid');
  v_r := public.save_ai_listing(v_store_a, v_p1, jsonb_set(pg_temp.tr3('gu title') #- '{en,title}', '{en,name}', '"x"'), 'm', 1, 1, 1);
  PERFORM pg_temp.check_that(v_r->>'reason' = 'invalid', 'ai listing: renamed nested key invalid');
  SELECT count(*) INTO v_n FROM public.product_translations WHERE product_id = v_p1;
  PERFORM pg_temp.check_that(v_n = 0 AND NOT EXISTS (SELECT 1 FROM public.ai_drafts WHERE target_id = v_p1), 'ai listing: nested-key refusals wrote nothing');
  v_r := public.save_ai_listing(v_store_a, v_p1, pg_temp.tr3('gu title'), 'm', -1, 1, 1);
  PERFORM pg_temp.check_that(v_r->>'reason' = 'invalid', 'ai listing: negative tokens invalid');
  PERFORM pg_temp.check_that((SELECT ai_status FROM public.products WHERE id = v_p1) = 'generating', 'ai listing: invalid calls left generation state');

  -- save_ai_listing: success -----------------------------------------------------------------
  v_r := public.save_ai_listing(v_store_a, v_p1, pg_temp.tr3('gu title'), 'claude-haiku-5-5', 100, 200, 300);
  PERFORM pg_temp.check_that((v_r->>'ok')::boolean AND v_r->>'draft_id' IS NOT NULL, 'ai listing: success');
  SELECT count(*) INTO v_n FROM public.product_translations WHERE product_id = v_p1 AND source = 'ai' AND NOT approved;
  PERFORM pg_temp.check_that(v_n = 3, 'ai listing: three ai unapproved translations');
  PERFORM pg_temp.check_that((SELECT ai_status FROM public.products WHERE id = v_p1) = 'idle'
    AND (SELECT ai_started_at FROM public.products WHERE id = v_p1) IS NULL, 'ai listing: generation state cleared');
  SELECT count(*) INTO v_n FROM public.ai_drafts WHERE store_id = v_store_a AND target_id = v_p1 AND kind = 'translation'
    AND status = 'pending' AND model = 'claude-haiku-5-5' AND tokens_in = 100 AND tokens_out = 200 AND cost_micro_usd = 300;
  PERFORM pg_temp.check_that(v_n = 1, 'ai listing: one audit draft with usage');

  -- save_product_review: ownership and validation -------------------------------------------
  v_r := public.save_product_review(v_store_b, v_p1, 1000, '{}'::jsonb, ARRAY[]::text[], false);
  PERFORM pg_temp.check_that(v_r->>'reason' = 'not_found', 'review: other store gets not_found');
  v_r := public.save_product_review(v_store_a, gen_random_uuid(), 1000, '{}'::jsonb, ARRAY[]::text[], false);
  PERFORM pg_temp.check_that(v_r->>'reason' = 'not_found', 'review: unknown product gets not_found');
  PERFORM pg_temp.check_that((SELECT price_paise FROM public.products WHERE id = v_p1) IS NULL, 'review: refused calls changed nothing');
  PERFORM pg_temp.check_that(public.save_product_review(v_store_a, v_p1, 0, '{}'::jsonb, ARRAY[]::text[], false)->>'reason' = 'invalid', 'review: price 0 invalid');
  PERFORM pg_temp.check_that(public.save_product_review(v_store_a, v_p1, 100000001, '{}'::jsonb, ARRAY[]::text[], false)->>'reason' = 'invalid', 'review: price above 1,000,000 rupees invalid');
  PERFORM pg_temp.check_that(public.save_product_review(v_store_a, v_p1, 1000, '{"xx": {}}'::jsonb, ARRAY[]::text[], false)->>'reason' = 'invalid', 'review: unknown language key invalid');
  PERFORM pg_temp.check_that(public.save_product_review(v_store_a, v_p1, 1000, '{}'::jsonb, ARRAY['xx'], false)->>'reason' = 'invalid', 'review: unknown approved language invalid');
  PERFORM pg_temp.check_that(public.save_product_review(v_store_a, v_p1, 1000, '{"en": {"title": "t"}}'::jsonb, ARRAY[]::text[], false)->>'reason' = 'invalid', 'review: partial translation invalid');
  PERFORM pg_temp.check_that(public.save_product_review(v_store_a, v_p1, 1000, jsonb_build_object('en', pg_temp.tr3('x') -> 'en' || '{"price": 5}'::jsonb), ARRAY[]::text[], false)->>'reason' = 'invalid', 'review: extra nested key invalid');
  PERFORM pg_temp.check_that(public.save_product_review(v_store_a, v_p1, 1000, jsonb_build_object('gu', pg_temp.tr3('x') -> 'gu' || '{"status": "published"}'::jsonb), ARRAY[]::text[], false)->>'reason' = 'invalid', 'review: extra nested key (gu) invalid');
  PERFORM pg_temp.check_that(public.save_product_review(v_store_a, v_p1, 1000, jsonb_build_object('hi', (pg_temp.tr3('x') -> 'hi') - 'alt_text'), ARRAY[]::text[], false)->>'reason' = 'invalid', 'review: missing nested key invalid');
  PERFORM pg_temp.check_that(public.save_product_review(v_store_a, v_p1, 1000, jsonb_build_object('en', ((pg_temp.tr3('x') -> 'en') - 'title') || '{"name": "x"}'::jsonb), ARRAY[]::text[], false)->>'reason' = 'invalid', 'review: renamed nested key invalid');
  PERFORM pg_temp.check_that(public.save_product_review(v_store_a, v_p1, 1000, '{"en": null}'::jsonb, ARRAY[]::text[], false)->>'reason' = 'invalid', 'review: null language object invalid');
  PERFORM pg_temp.check_that((SELECT price_paise FROM public.products WHERE id = v_p1) IS NULL
    AND (SELECT count(*) FROM public.product_translations WHERE product_id = v_p1 AND source = 'ai') = 3
    AND (SELECT title FROM public.product_translations WHERE product_id = v_p1 AND language = 'en') = 'Clay pot', 'review: nested-key refusals wrote nothing');

  -- publishing gates -------------------------------------------------------------------------
  v_r := public.save_product_review(v_store_a, v_p1, NULL, '{}'::jsonb, ARRAY['gu'], true);
  PERFORM pg_temp.check_that(v_r->>'reason' = 'price_required', 'publish: no price refused');
  v_r := public.save_product_review(v_store_a, v_p1, 1000, '{}'::jsonb, ARRAY['en'], true);
  PERFORM pg_temp.check_that(v_r->>'reason' = 'default_language_not_approved', 'publish: default language (gu) not approved refused');
  v_r := public.save_product_review(v_store_a, v_p1, 1000, '{"gu": {"title": "", "description": "d", "alt_text": "a"}}'::jsonb, ARRAY['gu'], true);
  PERFORM pg_temp.check_that(v_r->>'reason' = 'default_language_not_approved', 'publish: empty default language refused');
  PERFORM pg_temp.check_that((SELECT status FROM public.products WHERE id = v_p1) = 'draft'
    AND (SELECT price_paise FROM public.products WHERE id = v_p1) IS NULL
    AND (SELECT title FROM public.product_translations WHERE product_id = v_p1 AND language = 'gu') = 'gu title', 'publish: refusals wrote nothing');

  -- save without publishing: exact approval flags and source rules -----------------------------
  v_r := public.save_product_review(v_store_a, v_p1, 1000, pg_temp.tr3('gu title'), ARRAY['en'], false);
  PERFORM pg_temp.check_that((v_r->>'ok')::boolean AND v_r->>'status' = 'draft', 'save: draft saved');
  SELECT count(*) INTO v_n FROM public.product_translations WHERE product_id = v_p1 AND source = 'ai';
  PERFORM pg_temp.check_that(v_n = 3, 'source: unchanged text keeps source ai');
  PERFORM pg_temp.check_that((SELECT array_agg(language ORDER BY language) FROM public.product_translations
    WHERE product_id = v_p1 AND approved) = ARRAY['en'], 'approval: exactly en approved');
  PERFORM pg_temp.check_that((SELECT price_paise FROM public.products WHERE id = v_p1) = 1000, 'save: price stored as integer paise');
  v_r := public.save_product_review(v_store_a, v_p1, 1000, pg_temp.tr3('edited gu title'), ARRAY['en', 'gu'], false);
  PERFORM pg_temp.check_that((v_r->>'ok')::boolean, 'save: edit saved');
  PERFORM pg_temp.check_that((SELECT source FROM public.product_translations WHERE product_id = v_p1 AND language = 'gu') = 'owner', 'source: edited text becomes owner');
  PERFORM pg_temp.check_that((SELECT source FROM public.product_translations WHERE product_id = v_p1 AND language = 'en') = 'ai', 'source: untouched language stays ai');
  PERFORM pg_temp.check_that((SELECT array_agg(language ORDER BY language) FROM public.product_translations
    WHERE product_id = v_p1 AND approved) = ARRAY['en', 'gu'], 'approval: exactly en and gu approved');
  v_r := public.save_product_review(v_store_a, v_p1, 1000, '{}'::jsonb, ARRAY['hi'], false);
  PERFORM pg_temp.check_that((SELECT array_agg(language ORDER BY language) FROM public.product_translations
    WHERE product_id = v_p1 AND approved) = ARRAY['hi'], 'approval: omitting languages unapproves them');
  PERFORM pg_temp.check_that(public.save_product_review(v_store_a, v_p1, 1000, '{}'::jsonb, ARRAY['hi', 'hi'], false)->>'ok' = 'true', 'approval: duplicate language entries are harmless');

  -- publish succeeds, is idempotent, and keeps its price ---------------------------------------
  v_r := public.save_product_review(v_store_a, v_p1, 1000, pg_temp.tr3('edited gu title'), ARRAY['gu', 'en', 'hi'], true);
  PERFORM pg_temp.check_that((v_r->>'ok')::boolean AND v_r->>'status' = 'published', 'publish: succeeds with price and approved default');
  v_r := public.save_product_review(v_store_a, v_p1, 1000, pg_temp.tr3('edited gu title'), ARRAY['gu', 'en', 'hi'], true);
  PERFORM pg_temp.check_that((v_r->>'ok')::boolean AND v_r->>'status' = 'published', 'publish: idempotent');
  v_r := public.save_product_review(v_store_a, v_p1, NULL, '{}'::jsonb, ARRAY['gu'], false);
  PERFORM pg_temp.check_that(v_r->>'reason' = 'price_required', 'published product cannot lose its price');
  v_r := public.save_product_review(v_store_a, v_p1, 2500, '{}'::jsonb, ARRAY['gu'], false);
  PERFORM pg_temp.check_that((v_r->>'ok')::boolean AND v_r->>'status' = 'published'
    AND (SELECT price_paise FROM public.products WHERE id = v_p1) = 2500, 'published product can be edited and stays published');

  -- regeneration is drafts only ----------------------------------------------------------------
  v_r := public.save_ai_listing(v_store_a, v_p1, pg_temp.tr3('new gu'), 'm', 1, 1, 1);
  PERFORM pg_temp.check_that(v_r->>'reason' = 'not_draft', 'ai listing: published product refused');
  PERFORM pg_temp.check_that((SELECT title FROM public.product_translations WHERE product_id = v_p1 AND language = 'gu') = 'edited gu title', 'ai listing: refused call kept owner text');

  -- regeneration replaces all three translations and resets approvals -------------------------
  INSERT INTO public.products (store_id, image_path) VALUES (v_store_a, v_store_a || '/p2/x.jpg') RETURNING id INTO v_p2;
  PERFORM public.save_ai_listing(v_store_a, v_p2, pg_temp.tr3('first gu'), 'm', 1, 1, 1);
  PERFORM public.save_product_review(v_store_a, v_p2, 500, pg_temp.tr3('owner gu'), ARRAY['en', 'gu', 'hi'], false);
  PERFORM pg_temp.check_that((SELECT count(*) FROM public.product_translations WHERE product_id = v_p2 AND approved) = 3, 'regen setup: all approved');
  v_r := public.save_ai_listing(v_store_a, v_p2, pg_temp.tr3('second gu'), 'm', 2, 2, 2);
  PERFORM pg_temp.check_that((v_r->>'ok')::boolean, 'regen: second generation saved');
  SELECT count(*) INTO v_n FROM public.product_translations WHERE product_id = v_p2 AND NOT approved AND source = 'ai';
  PERFORM pg_temp.check_that(v_n = 3, 'regen: all three unapproved and source ai');
  PERFORM pg_temp.check_that((SELECT title FROM public.product_translations WHERE product_id = v_p2 AND language = 'gu') = 'second gu', 'regen: owner edit replaced');
  PERFORM pg_temp.check_that((SELECT count(*) FROM public.ai_drafts WHERE target_id = v_p2) = 2, 'regen: two audit drafts');
  PERFORM pg_temp.check_that((SELECT price_paise FROM public.products WHERE id = v_p2) = 500, 'regen: price untouched');

  -- table constraints (backstop under the functions) ------------------------------------------
  v_caught := false;
  BEGIN
    UPDATE public.products SET price_paise = NULL WHERE id = v_p1;
  EXCEPTION WHEN check_violation THEN v_caught := true;
  END;
  PERFORM pg_temp.check_that(v_caught, 'constraint: published product cannot have no price');
  v_caught := false;
  BEGIN
    UPDATE public.product_translations SET title = '', approved = true WHERE product_id = v_p2 AND language = 'en';
  EXCEPTION WHEN check_violation THEN v_caught := true;
  END;
  PERFORM pg_temp.check_that(v_caught, 'constraint: approved translation cannot be empty');
  -- A third product with no translations, so the composite foreign key (not the primary key) is what fails.
  INSERT INTO public.products (store_id, image_path) VALUES (v_store_a, v_store_a || '/p3/x.jpg') RETURNING id INTO v_p3;
  v_caught := false;
  BEGIN
    INSERT INTO public.product_translations (product_id, store_id, language) VALUES (v_p3, v_store_b, 'en');
  EXCEPTION WHEN foreign_key_violation THEN v_caught := true;
  END;
  PERFORM pg_temp.check_that(v_caught, 'constraint: translation store_id must match the product store');

  -- cascades -----------------------------------------------------------------------------------
  DELETE FROM public.products WHERE id = v_p2;
  PERFORM pg_temp.check_that((SELECT count(*) FROM public.product_translations WHERE product_id = v_p2) = 0, 'cascade: deleting a product deletes its translations');
  PERFORM pg_temp.check_that((SELECT count(*) FROM public.ai_drafts WHERE target_id = v_p2) = 2, 'drafts are kept when their product is deleted');
  DELETE FROM public.stores WHERE id = v_store_a;
  PERFORM pg_temp.check_that((SELECT count(*) FROM public.products WHERE store_id = v_store_a) = 0
    AND (SELECT count(*) FROM public.product_translations WHERE store_id = v_store_a) = 0
    AND (SELECT count(*) FROM public.ai_drafts WHERE store_id = v_store_a) = 0, 'cascade: deleting a store deletes products, translations and drafts');

  RAISE EXCEPTION 'smoke complete, rolling back' USING ERRCODE = 'AB001';
EXCEPTION
  WHEN SQLSTATE 'AB001' THEN
    RETURN 'ALL CHECKS PASSED';
END;
$$;

SELECT pg_temp.smoke_004() AS result;
