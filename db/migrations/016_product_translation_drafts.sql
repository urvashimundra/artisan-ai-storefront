-- Migration 016: "Update other languages from my edits" saves AI translation drafts for a product (Fix round A, item L2).
-- Apply in the Supabase SQL editor AFTER migration 015. Idempotent: safe to run more than once. Forward-only: 004 and 005 are NOT edited.
-- STATUS: written, NOT applied. The developer applies it, then runs db/verify/016_product_translation_drafts_checks.sql and
-- db/test/016_product_translation_drafts_smoke.sql.
--
-- save_product_translation_drafts(p_store_id, p_product_id, p_translations)
--   p_translations is {"gu": {"title": ..., "description": ...}, "hi": {...}}: only title and description, never alt_text, never the
--   store's default language, never anything else. Everything happens in ONE transaction, with the product row locked FOR UPDATE (the lock
--   save_product_review also takes), so an approval made at the same moment cannot be overwritten.
--   * A language whose row is APPROVED and written by the OWNER is skipped and reported (the same rule as store translations).
--   * Any other row (missing, unapproved, or AI text) gets the new title and description, source 'ai', approved false, and keeps its
--     alt_text. The text is therefore never public until the owner approves it.
--   * Refused while a listing generation is running (the same 180 second window as migration 005).
-- Returns {ok:true, saved:[...], skipped:[...]} or {ok:false, reason: invalid | not_found | generating}.
-- Security model unchanged: SECURITY INVOKER, search_path = public, pg_temp, EXECUTE for service_role only.

CREATE OR REPLACE FUNCTION public.save_product_translation_drafts(p_store_id uuid, p_product_id uuid, p_translations jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  v_default text;
  v_ai_status text;
  v_ai_started timestamptz;
  v_lang text;
  v_t jsonb;
  v_row public.product_translations%ROWTYPE;
  v_saved text[] := ARRAY[]::text[];
  v_skipped text[] := ARRAY[]::text[];
BEGIN
  IF p_store_id IS NULL OR p_product_id IS NULL OR jsonb_typeof(p_translations) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_translations) k WHERE k NOT IN ('en', 'gu', 'hi')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;

  SELECT ai_status, ai_started_at INTO v_ai_status, v_ai_started FROM public.products
   WHERE id = p_product_id AND store_id = p_store_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF v_ai_status = 'generating' AND v_ai_started IS NOT NULL AND v_ai_started > now() - interval '180 seconds' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'generating');
  END IF;

  SELECT default_language INTO v_default FROM public.stores WHERE id = p_store_id;

  -- Validate every language before anything is written, so a refusal changes nothing.
  FOREACH v_lang IN ARRAY ARRAY['en', 'gu', 'hi'] LOOP
    v_t := p_translations -> v_lang;
    CONTINUE WHEN v_t IS NULL;
    IF v_lang = v_default
       OR jsonb_typeof(v_t) IS DISTINCT FROM 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(v_t)) <> 2
       OR jsonb_typeof(v_t -> 'title') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_t -> 'description') IS DISTINCT FROM 'string'
       OR char_length(v_t ->> 'title') NOT BETWEEN 1 AND 100
       OR char_length(v_t ->> 'description') NOT BETWEEN 1 AND 1200 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
    END IF;
  END LOOP;

  FOREACH v_lang IN ARRAY ARRAY['en', 'gu', 'hi'] LOOP
    v_t := p_translations -> v_lang;
    CONTINUE WHEN v_t IS NULL;
    SELECT * INTO v_row FROM public.product_translations WHERE product_id = p_product_id AND language = v_lang;
    IF FOUND AND v_row.approved AND v_row.source = 'owner' THEN
      v_skipped := v_skipped || v_lang;
      CONTINUE;
    END IF;
    INSERT INTO public.product_translations (product_id, store_id, language, title, description, alt_text, source, approved, updated_at)
      VALUES (p_product_id, p_store_id, v_lang, v_t ->> 'title', v_t ->> 'description', '', 'ai', false, now())
    ON CONFLICT (product_id, language) DO UPDATE SET
      title = EXCLUDED.title, description = EXCLUDED.description, source = 'ai', approved = false, updated_at = now();
    v_saved := v_saved || v_lang;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'saved', to_jsonb(v_saved), 'skipped', to_jsonb(v_skipped));
END;
$$;

REVOKE EXECUTE ON FUNCTION public.save_product_translation_drafts(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_product_translation_drafts(uuid, uuid, jsonb) TO service_role;

-- Rollback (manual): DROP FUNCTION public.save_product_translation_drafts(uuid, uuid, jsonb);
