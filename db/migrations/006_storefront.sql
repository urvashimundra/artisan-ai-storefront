-- Migration 006: public storefront settings (Module 3). Apply in the Supabase SQL editor AFTER migration 005.
-- Idempotent: safe to run more than once. No functions, tables, RLS or grant changes.
--
-- Adds branding and contact columns to public.stores and a partial index for the public product listing.
-- Patterns and limits mirror src/domain/shopSettings.js and src/domain/palette.js (a unit test compares them).
-- upi_id is stored for Module 4 and is never rendered on public pages. whatsapp_number is only ever used to build a
-- wa.me link after the owner opted in (whatsapp_enabled).

ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS tagline           text    NOT NULL DEFAULT '';
ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS accent_key        text    NOT NULL DEFAULT 'terracotta';
ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS whatsapp_number   text;
ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS whatsapp_enabled  boolean NOT NULL DEFAULT false;
ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS instagram_handle  text;
ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS upi_id            text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stores_tagline_length_check' AND conrelid = 'public.stores'::regclass) THEN
    ALTER TABLE public.stores ADD CONSTRAINT stores_tagline_length_check CHECK (char_length(tagline) <= 120);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stores_accent_key_check' AND conrelid = 'public.stores'::regclass) THEN
    ALTER TABLE public.stores ADD CONSTRAINT stores_accent_key_check
      CHECK (accent_key IN ('terracotta', 'indigo', 'forest', 'plum', 'teal', 'saffron'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stores_whatsapp_number_format_check' AND conrelid = 'public.stores'::regclass) THEN
    ALTER TABLE public.stores ADD CONSTRAINT stores_whatsapp_number_format_check
      CHECK (whatsapp_number IS NULL OR whatsapp_number ~ '^[0-9]{10,15}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stores_whatsapp_enabled_requires_number_check' AND conrelid = 'public.stores'::regclass) THEN
    ALTER TABLE public.stores ADD CONSTRAINT stores_whatsapp_enabled_requires_number_check
      CHECK (NOT whatsapp_enabled OR whatsapp_number IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stores_instagram_handle_format_check' AND conrelid = 'public.stores'::regclass) THEN
    ALTER TABLE public.stores ADD CONSTRAINT stores_instagram_handle_format_check
      CHECK (instagram_handle IS NULL OR instagram_handle ~ '^[A-Za-z0-9._]{1,30}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stores_upi_id_format_check' AND conrelid = 'public.stores'::regclass) THEN
    ALTER TABLE public.stores ADD CONSTRAINT stores_upi_id_format_check
      CHECK (upi_id IS NULL OR (char_length(upi_id) <= 100 AND upi_id ~ '^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9.]{1,63}$'));
  END IF;
END
$$;

-- Public listing: newest published products of one store.
CREATE INDEX IF NOT EXISTS products_store_id_published_created_idx
  ON public.products (store_id, created_at DESC, id DESC) WHERE status = 'published';

-- Rollback (manual, only if needed):
--   DROP INDEX IF EXISTS public.products_store_id_published_created_idx;
--   ALTER TABLE public.stores DROP COLUMN tagline, DROP COLUMN accent_key, DROP COLUMN whatsapp_enabled,
--     DROP COLUMN whatsapp_number, DROP COLUMN instagram_handle, DROP COLUMN upi_id;
