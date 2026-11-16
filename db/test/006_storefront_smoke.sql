-- Manual smoke test for migration 006. Run the WHOLE file in the Supabase SQL editor (as the default postgres role),
-- AFTER migration 006 is applied. Success: one row with "ALL CHECKS PASSED". Failure: an error "FAIL: <check name>".
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

-- Runs an UPDATE of the throwaway store and requires it to succeed.
CREATE OR REPLACE FUNCTION pg_temp.accepts(p_store uuid, p_set text, p_name text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('UPDATE public.stores SET %s WHERE id = %L', p_set, p_store);
EXCEPTION WHEN check_violation THEN
  RAISE EXCEPTION 'FAIL: % (valid value rejected: %)', p_name, SQLERRM;
END;
$$;

-- Runs an UPDATE of the throwaway store and requires the named CHECK to reject it.
CREATE OR REPLACE FUNCTION pg_temp.rejects(p_store uuid, p_set text, p_constraint text, p_name text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('UPDATE public.stores SET %s WHERE id = %L', p_set, p_store);
  RAISE EXCEPTION 'FAIL: % (invalid value accepted)', p_name;
EXCEPTION WHEN check_violation THEN
  IF position(p_constraint IN SQLERRM) = 0 THEN
    RAISE EXCEPTION 'FAIL: % (rejected by the wrong constraint: %)', p_name, SQLERRM;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.smoke_006() RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_owner uuid; v_store uuid; v_row public.stores;
  v_key text;
BEGIN
  INSERT INTO public.owners (email, password_hash)
    VALUES ('smoke-006-' || gen_random_uuid() || '@example.invalid', 'x') RETURNING id INTO v_owner;
  INSERT INTO public.stores (owner_id, slug, name, default_language, story)
    VALUES (v_owner, 'smoke-006-' || substr(gen_random_uuid()::text, 1, 8), 'Smoke 006', 'gu', 'story')
    RETURNING id INTO v_store;

  -- defaults for a store created the old way ---------------------------------------------------
  SELECT * INTO v_row FROM public.stores WHERE id = v_store;
  PERFORM pg_temp.check_that(v_row.tagline = '' AND v_row.accent_key = 'terracotta' AND v_row.whatsapp_number IS NULL
    AND v_row.whatsapp_enabled = false AND v_row.instagram_handle IS NULL AND v_row.upi_id IS NULL, 'defaults on a new store');

  -- tagline: <= 120 code points (Gujarati counts per code point) -----------------------------------
  PERFORM pg_temp.accepts(v_store, 'tagline = repeat(''x'', 120)', 'tagline 120 ascii');
  PERFORM pg_temp.accepts(v_store, 'tagline = repeat(''અ'', 120)', 'tagline 120 gujarati code points');
  PERFORM pg_temp.accepts(v_store, 'tagline = ''''', 'tagline empty');
  PERFORM pg_temp.rejects(v_store, 'tagline = repeat(''x'', 121)', 'stores_tagline_length_check', 'tagline 121');
  PERFORM pg_temp.rejects(v_store, 'tagline = repeat(''અ'', 121)', 'stores_tagline_length_check', 'tagline 121 gujarati');

  -- accent_key: exactly the six keys ----------------------------------------------------------------
  FOREACH v_key IN ARRAY ARRAY['terracotta', 'indigo', 'forest', 'plum', 'teal', 'saffron'] LOOP
    PERFORM pg_temp.accepts(v_store, format('accent_key = %L', v_key), 'accent ' || v_key);
  END LOOP;
  PERFORM pg_temp.rejects(v_store, 'accent_key = ''red''', 'stores_accent_key_check', 'accent unknown key');
  PERFORM pg_temp.rejects(v_store, 'accent_key = ''''', 'stores_accent_key_check', 'accent empty');
  PERFORM pg_temp.rejects(v_store, 'accent_key = ''Terracotta''', 'stores_accent_key_check', 'accent wrong case');

  -- whatsapp_number: 10 to 15 digits only ------------------------------------------------------------
  PERFORM pg_temp.accepts(v_store, 'whatsapp_number = ''9876543210''', 'whatsapp 10 digits');
  PERFORM pg_temp.accepts(v_store, 'whatsapp_number = ''919876543210''', 'whatsapp 12 digits');
  PERFORM pg_temp.accepts(v_store, 'whatsapp_number = ''123456789012345''', 'whatsapp 15 digits');
  PERFORM pg_temp.accepts(v_store, 'whatsapp_number = NULL', 'whatsapp null');
  PERFORM pg_temp.rejects(v_store, 'whatsapp_number = ''987654321''', 'stores_whatsapp_number_format_check', 'whatsapp 9 digits');
  PERFORM pg_temp.rejects(v_store, 'whatsapp_number = ''1234567890123456''', 'stores_whatsapp_number_format_check', 'whatsapp 16 digits');
  PERFORM pg_temp.rejects(v_store, 'whatsapp_number = ''+919876543210''', 'stores_whatsapp_number_format_check', 'whatsapp plus sign');
  PERFORM pg_temp.rejects(v_store, 'whatsapp_number = ''98765 43210''', 'stores_whatsapp_number_format_check', 'whatsapp space');
  PERFORM pg_temp.rejects(v_store, 'whatsapp_number = ''98765abcde''', 'stores_whatsapp_number_format_check', 'whatsapp letters');
  PERFORM pg_temp.rejects(v_store, 'whatsapp_number = ''9876543210'' || chr(10)', 'stores_whatsapp_number_format_check', 'whatsapp trailing newline');

  -- whatsapp_enabled requires a number ---------------------------------------------------------------
  PERFORM pg_temp.rejects(v_store, 'whatsapp_enabled = true', 'stores_whatsapp_enabled_requires_number_check', 'enabled without number');
  PERFORM pg_temp.accepts(v_store, 'whatsapp_number = ''9876543210'', whatsapp_enabled = true', 'enabled with number');
  PERFORM pg_temp.rejects(v_store, 'whatsapp_number = NULL', 'stores_whatsapp_enabled_requires_number_check', 'removing number while enabled');
  PERFORM pg_temp.accepts(v_store, 'whatsapp_enabled = false, whatsapp_number = NULL', 'disable and clear together');

  -- instagram_handle: 1 to 30 of letters, digits, dot, underscore ---------------------------------------
  PERFORM pg_temp.accepts(v_store, 'instagram_handle = ''a.b_C9''', 'instagram valid mix');
  PERFORM pg_temp.accepts(v_store, 'instagram_handle = repeat(''a'', 30)', 'instagram 30 chars');
  PERFORM pg_temp.accepts(v_store, 'instagram_handle = NULL', 'instagram null');
  PERFORM pg_temp.rejects(v_store, 'instagram_handle = repeat(''a'', 31)', 'stores_instagram_handle_format_check', 'instagram 31 chars');
  PERFORM pg_temp.rejects(v_store, 'instagram_handle = ''''', 'stores_instagram_handle_format_check', 'instagram empty');
  PERFORM pg_temp.rejects(v_store, 'instagram_handle = ''@abc''', 'stores_instagram_handle_format_check', 'instagram leading at');
  PERFORM pg_temp.rejects(v_store, 'instagram_handle = ''a b''', 'stores_instagram_handle_format_check', 'instagram space');
  PERFORM pg_temp.rejects(v_store, 'instagram_handle = ''a-b''', 'stores_instagram_handle_format_check', 'instagram hyphen');
  PERFORM pg_temp.rejects(v_store, 'instagram_handle = ''abc/def''', 'stores_instagram_handle_format_check', 'instagram slash');

  -- upi_id: conservative name@handle, <= 100 characters ------------------------------------------------------
  PERFORM pg_temp.accepts(v_store, 'upi_id = ''asha.patel-1@okhdfcbank''', 'upi valid');
  PERFORM pg_temp.accepts(v_store, 'upi_id = ''9876543210@ybl''', 'upi phone style');
  PERFORM pg_temp.accepts(v_store, 'upi_id = NULL', 'upi null');
  PERFORM pg_temp.rejects(v_store, 'upi_id = ''name''', 'stores_upi_id_format_check', 'upi without at');
  PERFORM pg_temp.rejects(v_store, 'upi_id = ''name@''', 'stores_upi_id_format_check', 'upi empty handle');
  PERFORM pg_temp.rejects(v_store, 'upi_id = ''@bank''', 'stores_upi_id_format_check', 'upi empty name');
  PERFORM pg_temp.rejects(v_store, 'upi_id = ''a@bank''', 'stores_upi_id_format_check', 'upi one-character name');
  PERFORM pg_temp.rejects(v_store, 'upi_id = ''na me@bank''', 'stores_upi_id_format_check', 'upi space');
  PERFORM pg_temp.rejects(v_store, 'upi_id = ''a.b@c@d''', 'stores_upi_id_format_check', 'upi two ats');
  PERFORM pg_temp.rejects(v_store, 'upi_id = ''name@bank'' || chr(10)', 'stores_upi_id_format_check', 'upi trailing newline');
  PERFORM pg_temp.rejects(v_store, 'upi_id = repeat(''a'', 50) || ''@'' || repeat(''b'', 60)', 'stores_upi_id_format_check', 'upi over 100 characters');

  RAISE EXCEPTION 'smoke complete, rolling back' USING ERRCODE = 'AB001';
EXCEPTION
  WHEN SQLSTATE 'AB001' THEN
    RETURN 'ALL CHECKS PASSED';
END;
$$;

SELECT pg_temp.smoke_006() AS result;
