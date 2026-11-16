-- Migration 007: translated shop tagline and story (Module 3 polish). Apply in the Supabase SQL editor AFTER migration 006.
-- Idempotent: safe to run more than once. No functions.
--
-- The shop's default language keeps its tagline and story in public.stores (the source of truth). This table holds the
-- OTHER languages only (the service enforces that). The shop name is never translated. A row is public only when
-- approved = true; the app sets approved = false whenever the default-language text changes.
-- Limits mirror src/domain/storeTranslations.js and stores (tagline <= 120, story <= 2000); a unit test compares them.

CREATE TABLE IF NOT EXISTS public.store_translations (
  store_id   uuid        NOT NULL,
  language   text        NOT NULL,
  tagline    text        NOT NULL DEFAULT '',
  story      text        NOT NULL DEFAULT '',
  source     text        NOT NULL,
  approved   boolean     NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_translations_pkey PRIMARY KEY (store_id, language),
  CONSTRAINT store_translations_store_fkey FOREIGN KEY (store_id) REFERENCES public.stores (id) ON DELETE CASCADE,
  CONSTRAINT store_translations_language_check CHECK (language IN ('en', 'gu', 'hi')),
  CONSTRAINT store_translations_tagline_length_check CHECK (char_length(tagline) <= 120),
  CONSTRAINT store_translations_story_length_check CHECK (char_length(story) <= 2000),
  CONSTRAINT store_translations_source_check CHECK (source IN ('owner', 'ai'))
);

-- Row level security and privileges: service_role only (the app); browser roles get nothing and there are no policies.
ALTER TABLE public.store_translations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.store_translations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.store_translations TO service_role;

-- Rollback (manual, only if needed):
--   DROP TABLE IF EXISTS public.store_translations;
