-- Migration 004: products, product_translations, ai_drafts and two RPC functions (Module 2b).
-- Apply in the Supabase SQL editor. Idempotent: safe to run more than once.
-- Constraint and index names are mirrored in src/domain/dbConstraints.js. Length limits are mirrored in
-- src/domain/productRules.js (a unit test compares them). Keep them in sync.
-- Functions: save_ai_listing and save_product_review only. Both verify ownership (store_id + product_id) inside.

-- products -----------------------------------------------------------------------------------
-- image_path is NOT NULL: a product row exists only once its image is stored. The upload route creates it.
-- (id, store_id) is UNIQUE so child tables can reference both and can never disagree about the store.
CREATE TABLE IF NOT EXISTS public.products (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id           uuid        NOT NULL REFERENCES public.stores (id) ON DELETE CASCADE,
  status             text        NOT NULL DEFAULT 'draft',
  price_paise        bigint,
  stock              integer,
  story              text        NOT NULL DEFAULT '',
  image_path         text        NOT NULL,
  image_content_type text,
  ai_status          text        NOT NULL DEFAULT 'idle',
  ai_started_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT products_id_store_id_key UNIQUE (id, store_id),
  CONSTRAINT products_status_check CHECK (status IN ('draft', 'published')),
  CONSTRAINT products_price_paise_check CHECK (price_paise IS NULL OR (price_paise > 0 AND price_paise <= 100000000)),
  CONSTRAINT products_published_requires_price_check CHECK (status <> 'published' OR price_paise IS NOT NULL),
  CONSTRAINT products_stock_check CHECK (stock IS NULL OR stock >= 0),
  CONSTRAINT products_story_length_check CHECK (char_length(story) <= 1500),
  CONSTRAINT products_image_path_length_check CHECK (char_length(image_path) BETWEEN 1 AND 300),
  CONSTRAINT products_image_content_type_check CHECK (image_content_type IS NULL OR image_content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  CONSTRAINT products_ai_status_check CHECK (ai_status IN ('idle', 'generating', 'failed'))
);

CREATE INDEX IF NOT EXISTS products_store_id_created_at_idx ON public.products (store_id, created_at DESC);

-- product_translations -----------------------------------------------------------------------
-- Empty text is allowed while the owner is still writing; an approved translation must be complete.
CREATE TABLE IF NOT EXISTS public.product_translations (
  product_id  uuid        NOT NULL,
  store_id    uuid        NOT NULL,
  language    text        NOT NULL,
  title       text        NOT NULL DEFAULT '',
  description text        NOT NULL DEFAULT '',
  alt_text    text        NOT NULL DEFAULT '',
  source      text        NOT NULL DEFAULT 'owner',
  approved    boolean     NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_translations_pkey PRIMARY KEY (product_id, language),
  CONSTRAINT product_translations_product_fkey FOREIGN KEY (product_id, store_id)
    REFERENCES public.products (id, store_id) ON DELETE CASCADE,
  CONSTRAINT product_translations_language_check CHECK (language IN ('en', 'gu', 'hi')),
  CONSTRAINT product_translations_title_length_check CHECK (char_length(title) <= 100),
  CONSTRAINT product_translations_description_length_check CHECK (char_length(description) <= 1200),
  CONSTRAINT product_translations_alt_text_length_check CHECK (char_length(alt_text) <= 250),
  CONSTRAINT product_translations_source_check CHECK (source IN ('ai', 'owner')),
  CONSTRAINT product_translations_approved_complete_check CHECK (
    NOT approved OR (char_length(title) > 0 AND char_length(description) > 0 AND char_length(alt_text) > 0))
);

-- ai_drafts ----------------------------------------------------------------------------------
-- target_id points at a product, enquiry or order depending on kind, so it has no foreign key.
-- Drafts are kept when their target is deleted: they are the audit record of AI spend.
CREATE TABLE IF NOT EXISTS public.ai_drafts (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id       uuid        NOT NULL REFERENCES public.stores (id) ON DELETE CASCADE,
  kind           text        NOT NULL,
  target_id      uuid        NOT NULL,
  content        jsonb       NOT NULL,
  status         text        NOT NULL DEFAULT 'pending',
  model          text        NOT NULL,
  tokens_in      integer     NOT NULL,
  tokens_out     integer     NOT NULL,
  cost_micro_usd bigint      NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_drafts_kind_check CHECK (kind IN ('translation', 'reply', 'quote')),
  CONSTRAINT ai_drafts_status_check CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT ai_drafts_model_length_check CHECK (char_length(model) BETWEEN 1 AND 100),
  CONSTRAINT ai_drafts_usage_check CHECK (tokens_in >= 0 AND tokens_out >= 0 AND cost_micro_usd >= 0)
);

CREATE INDEX IF NOT EXISTS ai_drafts_store_id_created_at_idx ON public.ai_drafts (store_id, created_at);

-- Row level security and privileges ----------------------------------------------------------
ALTER TABLE public.products             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_translations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_drafts            ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.products, public.product_translations, public.ai_drafts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.products, public.product_translations, public.ai_drafts TO service_role;

-- save_ai_listing ----------------------------------------------------------------------------
-- Stores an AI proposal for a DRAFT product: upserts all three translations (source ai, approved false, which
-- also resets every approval), records the ai_drafts audit row and clears the generation state.
-- p_translations: {"en": {"title","description","alt_text"}, "gu": {...}, "hi": {...}}, all three, all non-empty.
-- Returns {ok:true, draft_id} or {ok:false, reason: not_found | not_draft | invalid}.
CREATE OR REPLACE FUNCTION public.save_ai_listing(
  p_store_id uuid, p_product_id uuid, p_translations jsonb, p_model text,
  p_tokens_in int, p_tokens_out int, p_cost bigint
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status text;
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

  SELECT status INTO v_status FROM public.products
    WHERE id = p_product_id AND store_id = p_store_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF v_status <> 'draft' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_draft');
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

  UPDATE public.products SET ai_status = 'idle', ai_started_at = NULL, updated_at = now()
    WHERE id = p_product_id AND store_id = p_store_id;

  RETURN jsonb_build_object('ok', true, 'draft_id', v_draft_id);
END;
$$;

-- save_product_review ------------------------------------------------------------------------
-- The owner's Save / Publish. Works on draft and published products. Upserts the SUBMITTED translations (each
-- needs title, description, alt_text), sets source to 'owner' only where the text differs from what is stored,
-- sets approval flags EXACTLY from p_approved_langs (every language not listed becomes unapproved), saves the
-- price (NULL clears it) and optionally publishes.
-- Publishing needs a price and an approved, non-empty store-default-language translation. A published product
-- always keeps a price. All gates run before any write, so a refusal changes nothing.
-- Returns {ok:true, status} or {ok:false, reason: not_found | price_required | default_language_not_approved | invalid}.
CREATE OR REPLACE FUNCTION public.save_product_review(
  p_store_id uuid, p_product_id uuid, p_price_paise bigint, p_translations jsonb,
  p_approved_langs text[], p_publish boolean
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status text;
  v_default text;
  v_lang text;
  v_t jsonb;
  v_row public.product_translations;
  v_will_be_published boolean;
BEGIN
  IF p_store_id IS NULL OR p_product_id IS NULL OR p_translations IS NULL OR p_approved_langs IS NULL
     OR p_publish IS NULL OR jsonb_typeof(p_translations) IS DISTINCT FROM 'object'
     OR (p_price_paise IS NOT NULL AND (p_price_paise < 1 OR p_price_paise > 100000000))
     OR EXISTS (SELECT 1 FROM unnest(p_approved_langs) l WHERE l IS NULL OR l NOT IN ('en', 'gu', 'hi')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;
  -- Separate statement: jsonb_object_keys raises on a non-object, so it must run only after the type check.
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_translations) k WHERE k NOT IN ('en', 'gu', 'hi')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;

  SELECT status INTO v_status FROM public.products
    WHERE id = p_product_id AND store_id = p_store_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  v_will_be_published := p_publish OR v_status = 'published';
  IF v_will_be_published AND p_price_paise IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'price_required');
  END IF;

  SELECT default_language INTO v_default FROM public.stores WHERE id = p_store_id;
  IF p_publish AND NOT (v_default = ANY (p_approved_langs)) THEN
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
    SET price_paise = p_price_paise,
        status = CASE WHEN v_will_be_published THEN 'published' ELSE status END,
        updated_at = now()
    WHERE id = p_product_id AND store_id = p_store_id
    RETURNING status INTO v_status;

  RETURN jsonb_build_object('ok', true, 'status', v_status);
END;
$$;

-- Function permissions: functions in the public schema are callable through the Supabase API by default.
REVOKE EXECUTE ON FUNCTION public.save_ai_listing(uuid, uuid, jsonb, text, int, int, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_ai_listing(uuid, uuid, jsonb, text, int, int, bigint) TO service_role;
REVOKE EXECUTE ON FUNCTION public.save_product_review(uuid, uuid, bigint, jsonb, text[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_product_review(uuid, uuid, bigint, jsonb, text[], boolean) TO service_role;

-- Rollback (NOT executed; run by hand only on a database that holds no data you need):
--   DROP FUNCTION public.save_product_review(uuid, uuid, bigint, jsonb, text[], boolean);
--   DROP FUNCTION public.save_ai_listing(uuid, uuid, jsonb, text, int, int, bigint);
--   DROP TABLE public.ai_drafts;
--   DROP TABLE public.product_translations;
--   DROP TABLE public.products;
