-- Migration 001: owners, sessions, stores (Module 1: owner access and store setup).
-- Apply in the Supabase SQL editor. Idempotent: safe to run more than once.
-- No functions and no triggers are created. Application code uses the service role only.
-- Constraint and index names below are mirrored in src/domain/dbConstraints.js. Keep them in sync.

-- owners -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.owners (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text        NOT NULL,
  password_hash text        NOT NULL,
  is_demo       boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT owners_email_length_check CHECK (char_length(email) BETWEEN 3 AND 254),
  CONSTRAINT owners_email_lowercase_check CHECK (email = lower(email))
);

-- One account per email, case-insensitive. The app maps a violation of this name to "email already registered".
CREATE UNIQUE INDEX IF NOT EXISTS owners_email_lower_key ON public.owners (lower(email));

-- sessions -----------------------------------------------------------------------------------
-- Only the SHA-256 of the session token is stored, never the token.
CREATE TABLE IF NOT EXISTS public.sessions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid        NOT NULL REFERENCES public.owners (id) ON DELETE CASCADE,
  token_hash  text        NOT NULL,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_token_hash_key UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON public.sessions (expires_at);
CREATE INDEX IF NOT EXISTS sessions_owner_id_idx ON public.sessions (owner_id);

-- stores -------------------------------------------------------------------------------------
-- One store per owner (stores_owner_id_key). The slug regex must match SLUG_PATTERN in src/domain/dbConstraints.js.
-- The reserved list must match RESERVED_SLUGS in the same file (a unit test compares them).
CREATE TABLE IF NOT EXISTS public.stores (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         uuid        NOT NULL REFERENCES public.owners (id),
  slug             text        NOT NULL,
  name             text        NOT NULL,
  default_language text        NOT NULL,
  story            text        NOT NULL,
  contact_email    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stores_owner_id_key UNIQUE (owner_id),
  CONSTRAINT stores_slug_key UNIQUE (slug),
  CONSTRAINT stores_slug_format_check CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$'),
  CONSTRAINT stores_slug_not_reserved CHECK (slug NOT IN ('admin', 'support', 'api', 'internal', 'www')),
  CONSTRAINT stores_default_language_check CHECK (default_language IN ('en', 'gu', 'hi')),
  CONSTRAINT stores_name_length_check CHECK (char_length(name) BETWEEN 1 AND 80),
  CONSTRAINT stores_story_length_check CHECK (char_length(story) BETWEEN 1 AND 2000)
);

-- Row level security and privileges ----------------------------------------------------------
-- RLS is enabled with NO policies, so anon and authenticated can read and write nothing.
ALTER TABLE public.owners   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stores   ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.owners, public.sessions, public.stores FROM PUBLIC, anon, authenticated;

-- The server uses the service role, which bypasses RLS. Every query is still scoped by the application.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.owners, public.sessions, public.stores TO service_role;

-- Rollback (NOT executed; run by hand only if you decide to undo this module, and only on a database
-- that holds no data you need). Order matters because of the foreign keys:
--   DROP TABLE public.stores;
--   DROP TABLE public.sessions;
--   DROP TABLE public.owners;
