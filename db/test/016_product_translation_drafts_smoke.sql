-- Manual smoke test for migration 016. Run the WHOLE file in the Supabase SQL editor (default postgres role), AFTER 004, 005 and 016.
-- Success: one row "ALL CHECKS PASSED". Failure: error "FAIL: <check name>". Leaves no data (sub-transaction rolled back, SQLSTATE AB001).
-- Test rows use the prefix "smoke-016".

CREATE OR REPLACE FUNCTION pg_temp.check_that(p_ok boolean, p_name text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN
    RAISE EXCEPTION 'FAIL: %', p_name;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.smoke_016() RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_owner uuid; v_other_owner uuid; s uuid; s2 uuid; p uuid; r jsonb;
BEGIN
  INSERT INTO public.owners (email, password_hash) VALUES ('smoke-016-a-' || gen_random_uuid() || '@example.invalid', 'x') RETURNING id INTO v_owner;
  INSERT INTO public.owners (email, password_hash) VALUES ('smoke-016-b-' || gen_random_uuid() || '@example.invalid', 'x') RETURNING id INTO v_other_owner;
  INSERT INTO public.stores (owner_id, slug, name, default_language, story) VALUES (v_owner, 'smoke-016-' || substr(gen_random_uuid()::text, 1, 8), 'Smoke 016', 'en', 'story') RETURNING id INTO s;
  INSERT INTO public.stores (owner_id, slug, name, default_language, story) VALUES (v_other_owner, 'smoke-016-' || substr(gen_random_uuid()::text, 1, 8), 'Smoke 016 other', 'en', 'story') RETURNING id INTO s2;
  p := gen_random_uuid();
  INSERT INTO public.products (id, store_id, status, price_paise, image_path) VALUES (p, s, 'draft', 10000, 'smoke-016/' || p || '.jpg');
  INSERT INTO public.product_translations (product_id, store_id, language, title, description, alt_text, source, approved) VALUES
    (p, s, 'en', 'Mug', 'A mug', 'alt en', 'owner', true),
    (p, s, 'gu', 'owner gu', 'owner gu text', 'alt gu', 'owner', true),
    (p, s, 'hi', 'old hi', 'old hi text', 'alt hi', 'ai', true);

  r := public.save_product_translation_drafts(s, p, '{"gu": {"title": "new gu", "description": "new gu text"}, "hi": {"title": "new hi", "description": "new hi text"}}'::jsonb);
  PERFORM pg_temp.check_that((r ->> 'ok')::boolean AND r -> 'saved' = '["hi"]'::jsonb AND r -> 'skipped' = '["gu"]'::jsonb, 'approved owner text is skipped, the rest saved');
  PERFORM pg_temp.check_that((SELECT title = 'owner gu' AND approved AND source = 'owner' FROM public.product_translations WHERE product_id = p AND language = 'gu'), 'approved owner text is untouched');
  PERFORM pg_temp.check_that((SELECT title = 'new hi' AND NOT approved AND source = 'ai' AND alt_text = 'alt hi' FROM public.product_translations WHERE product_id = p AND language = 'hi'), 'AI draft is unapproved and keeps its alt text');
  PERFORM pg_temp.check_that((SELECT title = 'Mug' AND approved FROM public.product_translations WHERE product_id = p AND language = 'en'), 'default language untouched');

  r := public.save_product_translation_drafts(s, p, '{"en": {"title": "x", "description": "y"}}'::jsonb);
  PERFORM pg_temp.check_that(NOT (r ->> 'ok')::boolean AND r ->> 'reason' = 'invalid', 'the default language is refused');
  r := public.save_product_translation_drafts(s, p, '{"hi": {"title": "x", "description": "y", "alt_text": "z"}}'::jsonb);
  PERFORM pg_temp.check_that(NOT (r ->> 'ok')::boolean AND r ->> 'reason' = 'invalid', 'extra keys are refused');
  r := public.save_product_translation_drafts(s, p, '{"hi": {"title": "", "description": "y"}}'::jsonb);
  PERFORM pg_temp.check_that(NOT (r ->> 'ok')::boolean AND r ->> 'reason' = 'invalid', 'empty text is refused');
  PERFORM pg_temp.check_that((SELECT title = 'new hi' FROM public.product_translations WHERE product_id = p AND language = 'hi'), 'a refusal changes nothing');
  r := public.save_product_translation_drafts(s2, p, '{"hi": {"title": "x", "description": "y"}}'::jsonb);
  PERFORM pg_temp.check_that(NOT (r ->> 'ok')::boolean AND r ->> 'reason' = 'not_found', 'another store cannot touch the product');
  r := public.save_product_translation_drafts(s, gen_random_uuid(), '{"hi": {"title": "x", "description": "y"}}'::jsonb);
  PERFORM pg_temp.check_that(NOT (r ->> 'ok')::boolean AND r ->> 'reason' = 'not_found', 'unknown product');

  UPDATE public.products SET ai_status = 'generating', ai_started_at = now() WHERE id = p;
  r := public.save_product_translation_drafts(s, p, '{"hi": {"title": "x", "description": "y"}}'::jsonb);
  PERFORM pg_temp.check_that(NOT (r ->> 'ok')::boolean AND r ->> 'reason' = 'generating', 'refused while a generation is running');
  RAISE EXCEPTION USING ERRCODE = 'AB001', MESSAGE = 'rollback';
END;
$$;

DO $$
BEGIN
  BEGIN
    PERFORM pg_temp.smoke_016();
  EXCEPTION WHEN SQLSTATE 'AB001' THEN
    NULL;
  END;
END;
$$;

SELECT 'ALL CHECKS PASSED' AS result;
