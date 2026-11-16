-- Manual smoke test for migration 007. Run the WHOLE file in the Supabase SQL editor (as the default postgres role),
-- AFTER migration 007 is applied. Success: one row with "ALL CHECKS PASSED". Failure: an error "FAIL: <check name>".
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

-- Runs one statement and requires it to succeed.
CREATE OR REPLACE FUNCTION pg_temp.accepts(p_sql text, p_name text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
EXCEPTION WHEN check_violation OR not_null_violation OR unique_violation OR foreign_key_violation THEN
  RAISE EXCEPTION 'FAIL: % (valid value rejected: %)', p_name, SQLERRM;
END;
$$;

-- Runs one statement and requires it to fail with a message that names the given constraint or column.
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

CREATE OR REPLACE FUNCTION pg_temp.smoke_007() RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_owner uuid; v_store uuid; v_row public.store_translations; v_insert text; v_update text;
BEGIN
  INSERT INTO public.owners (email, password_hash)
    VALUES ('smoke-007-' || gen_random_uuid() || '@example.invalid', 'x') RETURNING id INTO v_owner;
  INSERT INTO public.stores (owner_id, slug, name, default_language, story)
    VALUES (v_owner, 'smoke-007-' || substr(gen_random_uuid()::text, 1, 8), 'Smoke 007', 'gu', 'story')
    RETURNING id INTO v_store;
  v_insert := format('INSERT INTO public.store_translations (store_id, language, source) VALUES (%L, ', v_store);
  v_update := format('UPDATE public.store_translations SET %%s WHERE store_id = %L AND language = %L', v_store, 'en');

  -- defaults ---------------------------------------------------------------------------------------
  EXECUTE v_insert || '''en'', ''ai'')';
  SELECT * INTO v_row FROM public.store_translations WHERE store_id = v_store AND language = 'en';
  PERFORM pg_temp.check_that(v_row.tagline = '' AND v_row.story = '' AND v_row.approved = false AND v_row.updated_at IS NOT NULL,
    'defaults: empty text, not approved, updated_at set');

  -- language: en, gu, hi only ---------------------------------------------------------------------------
  PERFORM pg_temp.accepts(v_insert || '''gu'', ''owner'')', 'language gu');
  PERFORM pg_temp.accepts(v_insert || '''hi'', ''owner'')', 'language hi');
  PERFORM pg_temp.rejects(v_insert || '''fr'', ''owner'')', 'store_translations_language_check', 'language fr');
  PERFORM pg_temp.rejects(v_insert || '''EN'', ''owner'')', 'store_translations_language_check', 'language wrong case');
  PERFORM pg_temp.rejects(v_insert || ''''', ''owner'')', 'store_translations_language_check', 'language empty');

  -- primary key (store_id, language) --------------------------------------------------------------------
  PERFORM pg_temp.rejects(v_insert || '''en'', ''owner'')', 'store_translations_pkey', 'duplicate store and language');

  -- source: owner or ai --------------------------------------------------------------------------------
  PERFORM pg_temp.rejects(format(v_update, 'source = ''human'''), 'store_translations_source_check', 'source human');
  PERFORM pg_temp.rejects(format(v_update, 'source = '''''), 'store_translations_source_check', 'source empty');
  PERFORM pg_temp.rejects(format(v_update, 'source = NULL'), 'source', 'source null');
  PERFORM pg_temp.accepts(format(v_update, 'source = ''ai'''), 'source ai');
  PERFORM pg_temp.accepts(format(v_update, 'source = ''owner'''), 'source owner');

  -- tagline: <= 120 code points -------------------------------------------------------------------------
  PERFORM pg_temp.accepts(format(v_update, 'tagline = repeat(''x'', 120)'), 'tagline 120 ascii');
  PERFORM pg_temp.accepts(format(v_update, 'tagline = repeat(''અ'', 120)'), 'tagline 120 gujarati code points');
  PERFORM pg_temp.rejects(format(v_update, 'tagline = repeat(''x'', 121)'), 'store_translations_tagline_length_check', 'tagline 121');
  PERFORM pg_temp.rejects(format(v_update, 'tagline = repeat(''અ'', 121)'), 'store_translations_tagline_length_check', 'tagline 121 gujarati');
  PERFORM pg_temp.rejects(format(v_update, 'tagline = NULL'), 'tagline', 'tagline null');

  -- story: <= 2000 code points (same maximum as stores.story) ---------------------------------------------
  PERFORM pg_temp.accepts(format(v_update, 'story = repeat(''x'', 2000)'), 'story 2000 ascii');
  PERFORM pg_temp.accepts(format(v_update, 'story = repeat(''અ'', 2000)'), 'story 2000 gujarati code points');
  PERFORM pg_temp.rejects(format(v_update, 'story = repeat(''x'', 2001)'), 'store_translations_story_length_check', 'story 2001');
  PERFORM pg_temp.rejects(format(v_update, 'story = repeat(''અ'', 2001)'), 'store_translations_story_length_check', 'story 2001 gujarati');
  PERFORM pg_temp.rejects(format(v_update, 'story = NULL'), 'story', 'story null');

  -- approved: boolean, never null -----------------------------------------------------------------------
  PERFORM pg_temp.accepts(format(v_update, 'approved = true'), 'approved true');
  PERFORM pg_temp.rejects(format(v_update, 'approved = NULL'), 'approved', 'approved null');

  -- foreign key and cascade ---------------------------------------------------------------------------
  PERFORM pg_temp.rejects(
    format('INSERT INTO public.store_translations (store_id, language, source) VALUES (%L, %L, %L)', gen_random_uuid(), 'en', 'owner'),
    'store_translations_store_fkey', 'unknown store');
  DELETE FROM public.stores WHERE id = v_store;
  PERFORM pg_temp.check_that(NOT EXISTS (SELECT 1 FROM public.store_translations WHERE store_id = v_store),
    'rows cascade away with their store');

  -- RLS on, no policies, browser roles have no privileges, service_role has CRUD --------------------------------
  PERFORM pg_temp.check_that((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.store_translations'::regclass), 'RLS enabled');
  PERFORM pg_temp.check_that(NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'store_translations'), 'no policies');
  PERFORM pg_temp.check_that(NOT has_table_privilege('anon', 'public.store_translations', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), 'anon has no privileges');
  PERFORM pg_temp.check_that(NOT has_table_privilege('authenticated', 'public.store_translations', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), 'authenticated has no privileges');
  PERFORM pg_temp.check_that(has_table_privilege('service_role', 'public.store_translations', 'SELECT,INSERT,UPDATE,DELETE'), 'service_role has CRUD');

  RAISE EXCEPTION 'smoke complete, rolling back' USING ERRCODE = 'AB001';
EXCEPTION
  WHEN SQLSTATE 'AB001' THEN
    RETURN 'ALL CHECKS PASSED';
END;
$$;

SELECT pg_temp.smoke_007() AS result;
