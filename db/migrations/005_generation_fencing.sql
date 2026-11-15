-- Migration 005: generation fencing token and atomic product review (Module 2b concurrency hardening).
-- Apply in the Supabase SQL editor AFTER migration 004. Idempotent: safe to run more than once.
--
-- 1. products.ai_generation_id: a fencing token. Every successful generation claim (an UPDATE issued by the backend,
--    src/repositories/productRepository.js) stamps a fresh random uuid. Whoever holds the current token owns the
--    generation; every later write of that run (save_ai_listing and the end-of-generation UPDATE) must present it.
--    A request that was superseded (its run went stale and was re-claimed), or whose product was deleted, no longer
--    matches and changes nothing. The token is NULL whenever nothing is generating. A deleted product takes its token
--    with it, so an outstanding token can never match anything again.
-- 2. save_ai_listing gains p_generation_id (new signature) and refuses with reason 'stale_generation' unless it matches.
-- 3. save_product_review gains p_story and p_stock (new signature), so ownership, the active-generation check, all
--    validation and every write (story, stock, translations, approvals, price, status) share ONE transaction.
--    It refuses with reason 'generating' while a generation is live.
--
-- Both functions change signature, so the migration-004 versions are DROPPED first. Leaving them would keep a callable
-- save_ai_listing that ignores the fencing token. Nothing else depends on them.
-- Row locking: both functions take SELECT ... FOR UPDATE on the product row first and re-read the token after the
-- lock is granted. That serialises them with the claim UPDATE, the finish UPDATE, delete and each other.
-- The 180 second stale window below mirrors STALE_GENERATION_MS in src/services/listingService.js (a unit test compares).

ALTER TABLE public.products ADD COLUMN IF NOT EXISTS ai_generation_id uuid;

DROP FUNCTION IF EXISTS public.save_ai_listing(uuid, uuid, jsonb, text, int, int, bigint);
DROP FUNCTION IF EXISTS public.save_product_review(uuid, uuid, bigint, jsonb, text[], boolean);

-- save_ai_listing ----------------------------------------------------------------------------
-- Stores an AI proposal for a DRAFT product: upserts all three translations (source ai, approved false, which
-- also resets every approval), records the ai_drafts audit row and clears the generation state and token.
-- p_translations: {"en": {"title","description","alt_text"}, "gu": {...}, "hi": {...}}, all three, all non-empty.
-- Returns {ok:true, draft_id} or {ok:false, reason: not_found | not_draft | stale_generation | invalid}.
-- A missing, stale or mismatched p_generation_id returns stale_generation before anything is written.
CREATE OR REPLACE FUNCTION public.save_ai_listing(
  p_store_id uuid, p_product_id uuid, p_generation_id uuid, p_translations jsonb, p_model text,
  p_tokens_in int, p_tokens_out int, p_cost bigint
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status text;
  v_ai_status text;
  v_token uuid;
  v_lang text;
  v_t jsonb;
  v_draft_id uuid;
BEGIN
  IF p_store_id IS NULL OR p_product_id IS NULL OR p_translations IS NULL OR p_model IS NULL
     OR p_tokens_in IS NULL OR p_tokens_out IS NULL OR p_cost IS NULL
     OR p_tokens_in < 0 OR p_tokens_out < 0 OR p_cost < 0
     OR char_length(p_model) NOT BETWEEN 1 AND 100
     OR jsonb_typeof(p_translations) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;

  SELECT status, ai_status, ai_generation_id INTO v_status, v_ai_status, v_token FROM public.products
    WHERE id = p_product_id AND store_id = p_store_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF v_status <> 'draft' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_draft');
  END IF;
  IF p_generation_id IS NULL OR v_token IS DISTINCT FROM p_generation_id OR v_ai_status <> 'generating' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'stale_generation');
  END IF;

  IF (SELECT count(*) FROM jsonb_object_keys(p_translations)) <> 3 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;
  FOREACH v_lang IN ARRAY ARRAY['en', 'gu', 'hi'] LOOP
    v_t := p_translations -> v_lang;
    IF jsonb_typeof(v_t) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_t -> 'title') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_t -> 'description') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_t -> 'alt_text') IS DISTINCT FROM 'string'
       OR char_length(v_t ->> 'title') NOT BETWEEN 1 AND 100
       OR char_length(v_t ->> 'description') NOT BETWEEN 1 AND 1200
       OR char_length(v_t ->> 'alt_text') NOT BETWEEN 1 AND 250 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
    END IF;
    -- Exactly title, description and alt_text: the three keys are present (above), so a count of 3 means no extra key.
    -- Separate statement: jsonb_object_keys raises on a non-object, which the check above has already refused.
    IF (SELECT count(*) FROM jsonb_object_keys(v_t)) <> 3 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
    END IF;
  END LOOP;

  FOREACH v_lang IN ARRAY ARRAY['en', 'gu', 'hi'] LOOP
    v_t := p_translations -> v_lang;
    INSERT INTO public.product_translations
      (product_id, store_id, language, title, description, alt_text, source, approved, updated_at)
    VALUES (p_product_id, p_store_id, v_lang, v_t ->> 'title', v_t ->> 'description', v_t ->> 'alt_text', 'ai', false, now())
    ON CONFLICT (product_id, language) DO UPDATE SET
      title = EXCLUDED.title, description = EXCLUDED.description, alt_text = EXCLUDED.alt_text,
      source = 'ai', approved = false, updated_at = now();
  END LOOP;

  INSERT INTO public.ai_drafts (store_id, kind, target_id, content, status, model, tokens_in, tokens_out, cost_micro_usd)
  VALUES (p_store_id, 'translation', p_product_id, p_translations, 'pending', p_model, p_tokens_in, p_tokens_out, p_cost)
  RETURNING id INTO v_draft_id;

  UPDATE public.products SET ai_status = 'idle', ai_started_at = NULL, ai_generation_id = NULL, updated_at = now()
    WHERE id = p_product_id AND store_id = p_store_id;

  RETURN jsonb_build_object('ok', true, 'draft_id', v_draft_id);
END;
$$;

-- save_product_review ------------------------------------------------------------------------
-- The owner's Save / Publish, in one transaction. Works on draft and published products. Order: argument checks,
-- row lock + ownership, active-generation check, price/publish gates, story/stock/translation/approval validation,
-- then ALL writes. Any refusal happens before the first write, so a refusal changes nothing (story and stock included).
-- Refuses with 'generating' while ai_status = 'generating' and the run started less than 180 seconds ago. An older
-- 'generating' state is an abandoned run: the review proceeds and resets ai_status to idle and clears the token, which
-- also fences the abandoned run out should it still be alive.
-- Upserts the SUBMITTED translations (source 'owner' only where text differs from what is stored), sets approval flags
-- EXACTLY from p_approved_langs, saves story, stock (NULL = not tracked) and price (NULL clears it), optionally publishes.
-- Publishing needs a price and an approved, non-empty store-default-language translation.
-- Returns {ok:true, status} or {ok:false, reason: not_found | generating | price_required |
--   default_language_not_approved | invalid}.
CREATE OR REPLACE FUNCTION public.save_product_review(
  p_store_id uuid, p_product_id uuid, p_story text, p_stock int, p_price_paise bigint, p_translations jsonb,
  p_approved_langs text[], p_publish boolean
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status text;
  v_ai_status text;
  v_ai_started timestamptz;
  v_default text;
  v_lang text;
  v_t jsonb;
  v_row public.product_translations;
  v_will_be_published boolean;
BEGIN
  IF p_store_id IS NULL OR p_product_id IS NULL OR p_translations IS NULL OR p_approved_langs IS NULL
     OR p_publish IS NULL OR p_story IS NULL OR char_length(p_story) > 1500
     OR (p_stock IS NOT NULL AND (p_stock < 0 OR p_stock > 1000000))
     OR jsonb_typeof(p_translations) IS DISTINCT FROM 'object'
     OR (p_price_paise IS NOT NULL AND (p_price_paise < 1 OR p_price_paise > 100000000))
     OR EXISTS (SELECT 1 FROM unnest(p_approved_langs) l WHERE l IS NULL OR l NOT IN ('en', 'gu', 'hi')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;
  -- Separate statement: jsonb_object_keys raises on a non-object, so it must run only after the type check.
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_translations) k WHERE k NOT IN ('en', 'gu', 'hi')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;

  SELECT status, ai_status, ai_started_at INTO v_status, v_ai_status, v_ai_started FROM public.products
    WHERE id = p_product_id AND store_id = p_store_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_ai_status = 'generating'
   AND v_ai_started IS NOT NULL
   AND v_ai_started > now() - interval '180 seconds' THEN
  RETURN jsonb_build_object('ok', false, 'reason', 'generating');
  END IF;

  v_will_be_published := p_publish OR v_status = 'published';
  IF v_will_be_published AND p_price_paise IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'price_required');
  END IF;

  SELECT default_language INTO v_default FROM public.stores WHERE id = p_store_id;
  IF v_will_be_published
   AND NOT (v_default = ANY (p_approved_langs)) THEN
  RETURN jsonb_build_object('ok', false, 'reason', 'default_language_not_approved');
END IF;

  -- Validate every submitted translation and every approval against the text that would be stored.
  FOREACH v_lang IN ARRAY ARRAY['en', 'gu', 'hi'] LOOP
    v_t := p_translations -> v_lang;
    IF v_t IS NOT NULL AND (jsonb_typeof(v_t) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_t -> 'title') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_t -> 'description') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_t -> 'alt_text') IS DISTINCT FROM 'string'
       OR char_length(v_t ->> 'title') > 100
       OR char_length(v_t ->> 'description') > 1200
       OR char_length(v_t ->> 'alt_text') > 250) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
    END IF;
    -- Exactly title, description and alt_text (all three are present, so a count of 3 means no extra key).
    -- Only reached for an object, so jsonb_object_keys cannot raise; an unsubmitted language has no keys and is skipped.
    IF v_t IS NOT NULL AND (SELECT count(*) FROM jsonb_object_keys(v_t)) <> 3 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
    END IF;
    IF v_lang = ANY (p_approved_langs) THEN
      SELECT * INTO v_row FROM public.product_translations WHERE product_id = p_product_id AND language = v_lang;
      IF char_length(coalesce(v_t ->> 'title', v_row.title, '')) = 0
         OR char_length(coalesce(v_t ->> 'description', v_row.description, '')) = 0
         OR char_length(coalesce(v_t ->> 'alt_text', v_row.alt_text, '')) = 0 THEN
        IF p_publish AND v_lang = v_default THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'default_language_not_approved');
        END IF;
        RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
      END IF;
    END IF;
  END LOOP;

  FOREACH v_lang IN ARRAY ARRAY['en', 'gu', 'hi'] LOOP
    v_t := p_translations -> v_lang;
    CONTINUE WHEN v_t IS NULL;
    INSERT INTO public.product_translations
      (product_id, store_id, language, title, description, alt_text, source, approved, updated_at)
    VALUES (p_product_id, p_store_id, v_lang, v_t ->> 'title', v_t ->> 'description', v_t ->> 'alt_text', 'owner', false, now())
    ON CONFLICT (product_id, language) DO UPDATE SET
      source = CASE
        WHEN (product_translations.title, product_translations.description, product_translations.alt_text)
             IS DISTINCT FROM (EXCLUDED.title, EXCLUDED.description, EXCLUDED.alt_text)
        THEN 'owner' ELSE product_translations.source END,
      updated_at = CASE
        WHEN (product_translations.title, product_translations.description, product_translations.alt_text)
             IS DISTINCT FROM (EXCLUDED.title, EXCLUDED.description, EXCLUDED.alt_text)
        THEN now() ELSE product_translations.updated_at END,
      title = EXCLUDED.title, description = EXCLUDED.description, alt_text = EXCLUDED.alt_text;
  END LOOP;

  UPDATE public.product_translations SET approved = (language = ANY (p_approved_langs))
    WHERE product_id = p_product_id AND store_id = p_store_id AND approved IS DISTINCT FROM (language = ANY (p_approved_langs));

  UPDATE public.products
    SET story = p_story,
        stock = p_stock,
        price_paise = p_price_paise,
        status = CASE WHEN v_will_be_published THEN 'published' ELSE status END,
        ai_status = CASE WHEN ai_status = 'generating' THEN 'idle' ELSE ai_status END,
        ai_started_at = CASE WHEN ai_status = 'generating' THEN NULL ELSE ai_started_at END,
        ai_generation_id = CASE WHEN ai_status = 'generating' THEN NULL ELSE ai_generation_id END,
        updated_at = now()
    WHERE id = p_product_id AND store_id = p_store_id
    RETURNING status INTO v_status;

  RETURN jsonb_build_object('ok', true, 'status', v_status);
END;
$$;

-- Function permissions: functions in the public schema are callable through the Supabase API by default.
REVOKE EXECUTE ON FUNCTION public.save_ai_listing(uuid, uuid, uuid, jsonb, text, int, int, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_ai_listing(uuid, uuid, uuid, jsonb, text, int, int, bigint) TO service_role;
REVOKE EXECUTE ON FUNCTION public.save_product_review(uuid, uuid, text, int, bigint, jsonb, text[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_product_review(uuid, uuid, text, int, bigint, jsonb, text[], boolean) TO service_role;

-- Rollback (NOT executed; run by hand only if you also redeploy the code from before this migration):
--   DROP FUNCTION public.save_product_review(uuid, uuid, text, int, bigint, jsonb, text[], boolean);
--   DROP FUNCTION public.save_ai_listing(uuid, uuid, uuid, jsonb, text, int, int, bigint);
--   ALTER TABLE public.products DROP COLUMN ai_generation_id;
--   then re-run migration 004 to recreate the original two functions.
