-- Migration 013: persistent customer chat conversations (Module 7). Apply AFTER migration 012, on STAGING first (a separate Supabase project).
-- Idempotent: safe to run more than once. Additive: enquiries and store_knowledge are NOT touched.
-- STATUS: written, NOT applied. The developer applies it, then runs db/verify/013_conversations_checks.sql, db/test/013_conversations_smoke.sql
-- and the two-session tests in db/test/013_conversations_races.sql. Rollback: db/rollback/013_conversations_rollback.sql.
--
-- Tables
--   conversations          one private chat between a customer and a shop. token_hash is the SHA-256 of the private link token (the only lookup
--                          key). token_enc is the same token encrypted by the app (AES-256-GCM, ORDER_LINK_KEY, same helper as order links) ONLY so
--                          the seller's WhatsApp reply can carry the customer's private link. ai_run_id is non-null while ONE assistant run is in
--                          flight: the row lock plus this column is what allows at most one run per conversation.
--   conversation_messages  customer, assistant and seller messages in order (seq). client_msg_id is the idempotency key of a submitted message.
--   conversation_usage     per India day counters: scope 'customer' counts persisted questions per customer (subject = SHA-256 of the number, never
--                          the number) per store; scope 'store_ai' counts answers per store (used = successfully persisted AI answers,
--                          reserved = AI runs in flight). Rows older than 3 days are purged.
-- Limits (mirrored in src/domain/conversationRules.js, a unit test compares them)
--   6 questions per customer per store per India day, counted when the question is persisted even if the AI later fails or escalates.
--   200 persisted AI answers per store per India day: reserved when a run starts, settled (used + 1) only when an answer is persisted, released
--   when the run fails or escalates to the seller. 200 messages per conversation (the customer can post while message_count <= 198, so the
--   assistant reply always fits; the seller has 10 extra). The existing AI budget guard (migration 002) is independent and untouched.
-- Security model (same as 008 to 012): every function is SECURITY INVOKER, sets search_path = public, pg_temp, has EXECUTE revoked from PUBLIC,
--   anon and authenticated and granted to service_role only. Every table has RLS on, no policy, browser roles revoked, service_role only.

CREATE TABLE IF NOT EXISTS public.conversations (
  id                 uuid        NOT NULL DEFAULT gen_random_uuid(),
  store_id           uuid        NOT NULL,
  product_id         uuid,
  language           text        NOT NULL,
  customer_name      text        NOT NULL,
  customer_phone     text        NOT NULL,
  status             text        NOT NULL DEFAULT 'open',
  flag_reason        text,
  token_hash         text        NOT NULL,
  token_enc          text,
  start_key          uuid        NOT NULL,
  message_count      integer     NOT NULL DEFAULT 0,
  last_message_role  text,
  last_preview       text        NOT NULL DEFAULT '',
  escalation_count   integer     NOT NULL DEFAULT 0,
  ai_run_id          uuid,
  ai_run_day         date,
  ai_run_started_at  timestamptz,
  legacy_enquiry_id  uuid,
  last_activity_at   timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversations_pkey PRIMARY KEY (id),
  CONSTRAINT conversations_id_store_key UNIQUE (id, store_id),
  CONSTRAINT conversations_store_fkey FOREIGN KEY (store_id) REFERENCES public.stores (id) ON DELETE CASCADE,
  CONSTRAINT conversations_product_fkey FOREIGN KEY (product_id, store_id) REFERENCES public.products (id, store_id) ON DELETE SET NULL (product_id),
  CONSTRAINT conversations_token_hash_key UNIQUE (token_hash),
  CONSTRAINT conversations_start_key_key UNIQUE (store_id, start_key),
  CONSTRAINT conversations_legacy_enquiry_key UNIQUE (legacy_enquiry_id),
  CONSTRAINT conversations_language_check CHECK (language IN ('en', 'gu', 'hi')),
  CONSTRAINT conversations_customer_name_check CHECK (char_length(customer_name) BETWEEN 1 AND 80),
  CONSTRAINT conversations_customer_phone_check CHECK (customer_phone ~ '^[0-9]{10,15}$'),
  CONSTRAINT conversations_status_check CHECK (status IN ('open', 'needs_you', 'handled')),
  CONSTRAINT conversations_flag_reason_check CHECK (flag_reason IS NULL OR flag_reason IN (
    'not_in_document', 'source_conflict', 'budget', 'store_limit', 'provider_limit', 'provider_error', 'timeout', 'network',
    'invalid_output', 'refused', 'too_complex', 'unverified_amount', 'knowledge_too_long', 'unavailable')),
  CONSTRAINT conversations_token_hash_format_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT conversations_token_enc_check CHECK (token_enc IS NULL OR (char_length(token_enc) BETWEEN 1 AND 200 AND token_enc ~ '^[A-Za-z0-9_-]+$')),
  CONSTRAINT conversations_message_count_check CHECK (message_count BETWEEN 0 AND 210),
  CONSTRAINT conversations_last_role_check CHECK (last_message_role IS NULL OR last_message_role IN ('customer', 'assistant', 'seller')),
  CONSTRAINT conversations_preview_check CHECK (char_length(last_preview) <= 160),
  CONSTRAINT conversations_escalation_count_check CHECK (escalation_count >= 0),
  CONSTRAINT conversations_ai_run_check CHECK ((ai_run_id IS NULL) = (ai_run_day IS NULL) AND (ai_run_id IS NULL) = (ai_run_started_at IS NULL))
);

CREATE TABLE IF NOT EXISTS public.conversation_messages (
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  store_id        uuid        NOT NULL,
  conversation_id uuid        NOT NULL,
  seq             integer     NOT NULL,
  role            text        NOT NULL,
  kind            text        NOT NULL DEFAULT 'text',
  body            text        NOT NULL,
  client_msg_id   uuid,
  flag_reason     text,
  sources         jsonb       NOT NULL DEFAULT '[]'::jsonb,
  conflict        jsonb,
  trace           jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_messages_pkey PRIMARY KEY (id),
  CONSTRAINT conversation_messages_conversation_fkey FOREIGN KEY (conversation_id, store_id)
    REFERENCES public.conversations (id, store_id) ON DELETE CASCADE,
  CONSTRAINT conversation_messages_seq_key UNIQUE (conversation_id, seq),
  CONSTRAINT conversation_messages_seq_check CHECK (seq BETWEEN 1 AND 210),
  CONSTRAINT conversation_messages_role_check CHECK (role IN ('customer', 'assistant', 'seller')),
  CONSTRAINT conversation_messages_kind_check CHECK (kind IN ('text', 'escalation', 'notice', 'conflict')),
  CONSTRAINT conversation_messages_body_check CHECK (char_length(body) BETWEEN 1 AND 3000),
  CONSTRAINT conversation_messages_customer_body_check CHECK (role <> 'customer' OR char_length(body) <= 500),
  CONSTRAINT conversation_messages_seller_body_check CHECK (role <> 'seller' OR char_length(body) <= 1000),
  CONSTRAINT conversation_messages_kind_role_check CHECK (kind = 'text' OR role = 'assistant'),
  CONSTRAINT conversation_messages_flag_reason_check CHECK (flag_reason IS NULL OR flag_reason IN (
    'not_in_document', 'source_conflict', 'budget', 'store_limit', 'provider_limit', 'provider_error', 'timeout', 'network',
    'invalid_output', 'refused', 'too_complex', 'unverified_amount', 'knowledge_too_long', 'unavailable')),
  CONSTRAINT conversation_messages_sources_check CHECK (CASE WHEN jsonb_typeof(sources) = 'array' THEN jsonb_array_length(sources) <= 8 ELSE false END),
  CONSTRAINT conversation_messages_conflict_check CHECK (conflict IS NULL OR (jsonb_typeof(conflict) = 'object' AND char_length(conflict::text) <= 4000)),
  CONSTRAINT conversation_messages_trace_check
    CHECK (CASE WHEN jsonb_typeof(trace) = 'array'
                THEN jsonb_array_length(trace) <= 12 AND NOT jsonb_path_exists(trace, '$[*] ? (@.type() != "string")')
                ELSE false END)
);

CREATE TABLE IF NOT EXISTS public.conversation_usage (
  store_id  uuid    NOT NULL,
  usage_day date    NOT NULL,
  scope     text    NOT NULL,
  subject   text    NOT NULL DEFAULT '',
  used      integer NOT NULL DEFAULT 0,
  reserved  integer NOT NULL DEFAULT 0,
  CONSTRAINT conversation_usage_pkey PRIMARY KEY (store_id, usage_day, scope, subject),
  CONSTRAINT conversation_usage_store_fkey FOREIGN KEY (store_id) REFERENCES public.stores (id) ON DELETE CASCADE,
  CONSTRAINT conversation_usage_scope_check CHECK (scope IN ('customer', 'store_ai')),
  CONSTRAINT conversation_usage_counts_check CHECK (used >= 0 AND reserved >= 0)
);

CREATE INDEX IF NOT EXISTS conversations_store_activity_idx ON public.conversations (store_id, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS conversations_store_status_activity_idx ON public.conversations (store_id, status, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS conversations_activity_idx ON public.conversations (last_activity_at);
CREATE INDEX IF NOT EXISTS conversation_messages_conversation_seq_idx ON public.conversation_messages (conversation_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS conversation_messages_client_msg_key ON public.conversation_messages (conversation_id, client_msg_id) WHERE client_msg_id IS NOT NULL;

ALTER TABLE public.conversations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_usage    ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.conversations, public.conversation_messages, public.conversation_usage FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.conversations, public.conversation_messages, public.conversation_usage TO service_role;

-- Helpers ---------------------------------------------------------------------------------------
-- The India calendar day (no daylight saving).
CREATE OR REPLACE FUNCTION public.conversation_india_day() RETURNS date
LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $$ SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date $$;

-- Takes one of the customer's 6 daily question slots. ONE statement: the upsert row lock serializes concurrent callers, and the WHERE is
-- re-evaluated against the committed row, so the 7th concurrent caller is refused. The subject is a hash of the number.
CREATE OR REPLACE FUNCTION public.conversation_take_customer_slot(p_store_id uuid, p_phone text) RETURNS boolean
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  c_limit CONSTANT integer := 6;
BEGIN
  INSERT INTO public.conversation_usage AS u (store_id, usage_day, scope, subject, used)
    VALUES (p_store_id, public.conversation_india_day(), 'customer', encode(sha256(convert_to(p_phone, 'UTF8')), 'hex'), 1)
    ON CONFLICT (store_id, usage_day, scope, subject) DO UPDATE SET used = u.used + 1 WHERE u.used < c_limit;
  RETURN FOUND;
END;
$$;

-- Reserves one of the store's 200 daily AI answers (reserved + 1) while used + reserved < 200. Returns the India day reserved on, or NULL.
CREATE OR REPLACE FUNCTION public.conversation_reserve_ai(p_store_id uuid) RETURNS date
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  c_limit CONSTANT integer := 200;
  v_day date := public.conversation_india_day();
BEGIN
  INSERT INTO public.conversation_usage AS u (store_id, usage_day, scope, subject, reserved)
    VALUES (p_store_id, v_day, 'store_ai', '', 1)
    ON CONFLICT (store_id, usage_day, scope, subject) DO UPDATE SET reserved = u.reserved + 1 WHERE u.used + u.reserved < c_limit;
  IF FOUND THEN
    RETURN v_day;
  END IF;
  RETURN NULL;
END;
$$;

-- Settles (answered: reserved - 1, used + 1) or releases (reserved - 1) the reservation of a run, on the day it was made.
CREATE OR REPLACE FUNCTION public.conversation_settle_ai(p_store_id uuid, p_day date, p_answered boolean) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.conversation_usage
    SET reserved = greatest(reserved - 1, 0), used = used + CASE WHEN p_answered THEN 1 ELSE 0 END
    WHERE store_id = p_store_id AND usage_day = p_day AND scope = 'store_ai' AND subject = '';
END;
$$;

-- Starts a run on a locked conversation row, or escalates straight to the seller when the store limit is reached (the fixed customer text is
-- passed in by the app). Returns the new run id, or NULL when escalated. The caller holds the row lock.
CREATE OR REPLACE FUNCTION public.conversation_begin_run(p_conversation_id uuid, p_store_id uuid, p_limit_notice text) RETURNS uuid
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  v_day date := public.conversation_reserve_ai(p_store_id);
  v_run uuid;
  v_seq integer;
BEGIN
  IF v_day IS NOT NULL THEN
    v_run := gen_random_uuid();
    UPDATE public.conversations SET ai_run_id = v_run, ai_run_day = v_day, ai_run_started_at = now() WHERE id = p_conversation_id AND store_id = p_store_id;
    RETURN v_run;
  END IF;
  UPDATE public.conversations
    SET message_count = message_count + 1, status = 'needs_you', flag_reason = 'store_limit', last_message_role = 'assistant',
        last_preview = left(p_limit_notice, 160), last_activity_at = now(), updated_at = now(),
        escalation_count = escalation_count + CASE WHEN status = 'needs_you' THEN 0 ELSE 1 END
    WHERE id = p_conversation_id AND store_id = p_store_id
    RETURNING message_count INTO v_seq;
  INSERT INTO public.conversation_messages (store_id, conversation_id, seq, role, kind, body, flag_reason)
    VALUES (p_store_id, p_conversation_id, v_seq, 'assistant', 'escalation', p_limit_notice, 'store_limit');
  RETURN NULL;
END;
$$;

-- conversation_start ----------------------------------------------------------------------------
-- Creates a conversation with its first customer message, takes the customer's slot and starts (or refuses) the AI run, ALL in one
-- transaction. Idempotent on (store, p_start_key): a repeat returns the existing conversation with duplicate = true and its encrypted token.
-- Result: { ok, reason, duplicate, conversation_id, message_id, run_id, escalated, escalation_count, token_enc }.
CREATE OR REPLACE FUNCTION public.conversation_start(
  p_store_id uuid, p_product_id uuid, p_language text, p_name text, p_phone text, p_token_hash text, p_token_enc text,
  p_start_key uuid, p_message_id uuid, p_body text, p_limit_notice text
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing public.conversations;
  v_id uuid;
  v_run uuid;
BEGIN
  SELECT * INTO v_existing FROM public.conversations WHERE store_id = p_store_id AND start_key = p_start_key;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'conversation_id', v_existing.id, 'token_enc', v_existing.token_enc);
  END IF;
  BEGIN
    IF NOT public.conversation_take_customer_slot(p_store_id, p_phone) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'customer_limit');
    END IF;
    INSERT INTO public.conversations
        (store_id, product_id, language, customer_name, customer_phone, token_hash, token_enc, start_key, message_count, last_message_role, last_preview)
      VALUES (p_store_id, p_product_id, p_language, p_name, p_phone, p_token_hash, p_token_enc, p_start_key, 1, 'customer', left(p_body, 160))
      RETURNING id INTO v_id;
    INSERT INTO public.conversation_messages (store_id, conversation_id, seq, role, body, client_msg_id)
      VALUES (p_store_id, v_id, 1, 'customer', p_body, p_message_id);
    v_run := public.conversation_begin_run(v_id, p_store_id, p_limit_notice);
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_existing FROM public.conversations WHERE store_id = p_store_id AND start_key = p_start_key;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', true, 'duplicate', true, 'conversation_id', v_existing.id, 'token_enc', v_existing.token_enc);
    END IF;
    RAISE;
  END;
  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'conversation_id', v_id, 'message_id', p_message_id, 'run_id', v_run,
    'escalated', v_run IS NULL, 'escalation_count', (SELECT escalation_count FROM public.conversations WHERE id = v_id AND store_id = p_store_id));
END;
$$;

-- conversation_post_message ---------------------------------------------------------------------
-- A customer's follow-up message. Locks the conversation row, so two submissions at once are serialized. Order of checks: not found, repeat of
-- the same p_message_id (duplicate, nothing else changes), conversation full, run already in flight ('busy'), customer limit; then it persists the
-- message and starts or refuses the AI run. Result: { ok, reason, duplicate, message_id, run_id, escalated, escalation_count }.
CREATE OR REPLACE FUNCTION public.conversation_post_message(
  p_store_id uuid, p_conversation_id uuid, p_message_id uuid, p_body text, p_limit_notice text
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  c_customer_max_count CONSTANT integer := 198;
  v_conv public.conversations;
  v_run uuid;
BEGIN
  SELECT * INTO v_conv FROM public.conversations WHERE id = p_conversation_id AND store_id = p_store_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF EXISTS (SELECT 1 FROM public.conversation_messages WHERE conversation_id = v_conv.id AND client_msg_id = p_message_id) THEN
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'message_id', p_message_id);
  END IF;
  IF v_conv.message_count > c_customer_max_count THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'conversation_full');
  END IF;
  IF v_conv.ai_run_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'busy');
  END IF;
  IF NOT public.conversation_take_customer_slot(p_store_id, v_conv.customer_phone) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'customer_limit');
  END IF;
  INSERT INTO public.conversation_messages (store_id, conversation_id, seq, role, body, client_msg_id)
    VALUES (p_store_id, v_conv.id, v_conv.message_count + 1, 'customer', p_body, p_message_id);
  UPDATE public.conversations
    SET message_count = message_count + 1, last_message_role = 'customer', last_preview = left(p_body, 160), last_activity_at = now(),
        updated_at = now(), status = CASE WHEN status = 'handled' THEN 'open' ELSE status END
    WHERE id = v_conv.id AND store_id = p_store_id;
  v_run := public.conversation_begin_run(v_conv.id, p_store_id, p_limit_notice);
  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'message_id', p_message_id, 'run_id', v_run, 'escalated', v_run IS NULL,
    'escalation_count', (SELECT escalation_count FROM public.conversations WHERE id = v_conv.id AND store_id = p_store_id));
END;
$$;

-- conversation_finish_run -----------------------------------------------------------------------
-- Ends the run p_run_id: persists the assistant message and settles or releases the store reservation. Only the call whose p_run_id is the
-- conversation's CURRENT run changes anything (the column is cleared), so settling twice is impossible and a stale or repeated call is a no-op.
-- p_outcome: 'answered' (reserved - 1, used + 1, status unchanged), 'escalated' or 'failed' (reserved - 1, status needs_you).
-- Result: { ok, changed, became_needs_you, escalation_count }.
CREATE OR REPLACE FUNCTION public.conversation_finish_run(
  p_store_id uuid, p_conversation_id uuid, p_run_id uuid, p_outcome text, p_kind text, p_body text, p_flag_reason text,
  p_sources jsonb, p_conflict jsonb, p_trace jsonb
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  v_conv public.conversations;
  v_to_seller boolean := p_outcome <> 'answered';
  v_became boolean;
BEGIN
  IF p_outcome NOT IN ('answered', 'escalated', 'failed') THEN
    RAISE EXCEPTION 'invalid outcome' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_conv FROM public.conversations
    WHERE id = p_conversation_id AND store_id = p_store_id AND ai_run_id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'changed', false);
  END IF;
  PERFORM public.conversation_settle_ai(p_store_id, v_conv.ai_run_day, p_outcome = 'answered');
  INSERT INTO public.conversation_messages (store_id, conversation_id, seq, role, kind, body, flag_reason, sources, conflict, trace)
    VALUES (p_store_id, v_conv.id, v_conv.message_count + 1, 'assistant', p_kind, p_body, p_flag_reason, coalesce(p_sources, '[]'::jsonb), p_conflict,
            coalesce(p_trace, '[]'::jsonb));
  v_became := v_to_seller AND v_conv.status <> 'needs_you';
  UPDATE public.conversations
    SET message_count = message_count + 1, last_message_role = 'assistant', last_preview = left(p_body, 160), last_activity_at = now(), updated_at = now(),
        status = CASE WHEN v_to_seller THEN 'needs_you' ELSE status END,
        flag_reason = CASE WHEN v_to_seller THEN p_flag_reason ELSE flag_reason END,
        escalation_count = escalation_count + CASE WHEN v_became THEN 1 ELSE 0 END,
        ai_run_id = NULL, ai_run_day = NULL, ai_run_started_at = NULL
    WHERE id = v_conv.id AND store_id = p_store_id;
  RETURN jsonb_build_object('ok', true, 'changed', true, 'became_needs_you', v_became,
    'escalation_count', v_conv.escalation_count + CASE WHEN v_became THEN 1 ELSE 0 END);
END;
$$;

-- conversation_seller_reply ---------------------------------------------------------------------
-- The seller's reply, appended to the customer's existing conversation, marking it handled. Idempotent on p_message_id (a double submit adds one).
-- The seller may post up to 210 messages (10 above the 200 customer/assistant cap). Result: { ok, reason, duplicate, message_id }.
CREATE OR REPLACE FUNCTION public.conversation_seller_reply(p_store_id uuid, p_conversation_id uuid, p_message_id uuid, p_body text) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  v_conv public.conversations;
BEGIN
  SELECT * INTO v_conv FROM public.conversations WHERE id = p_conversation_id AND store_id = p_store_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF EXISTS (SELECT 1 FROM public.conversation_messages WHERE conversation_id = v_conv.id AND client_msg_id = p_message_id) THEN
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'message_id', p_message_id);
  END IF;
  IF v_conv.message_count >= 210 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'conversation_full');
  END IF;
  INSERT INTO public.conversation_messages (store_id, conversation_id, seq, role, body, client_msg_id)
    VALUES (p_store_id, v_conv.id, v_conv.message_count + 1, 'seller', p_body, p_message_id);
  UPDATE public.conversations
    SET message_count = message_count + 1, last_message_role = 'seller', last_preview = left(p_body, 160), status = 'handled', flag_reason = NULL,
        last_activity_at = now(), updated_at = now()
    WHERE id = v_conv.id AND store_id = p_store_id;
  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'message_id', p_message_id);
END;
$$;

-- conversation_delete ---------------------------------------------------------------------------
-- Seller-initiated deletion inside ONE store. Removes the conversation, its messages (cascade), the encrypted token, and the linked legacy
-- enquiry (name, number, question). An in-flight run's reservation is released first. If the id is not a conversation of this store but is a
-- legacy enquiry of this store, that enquiry is deleted. Result: 'conversation', 'enquiry' or 'none'.
CREATE OR REPLACE FUNCTION public.conversation_delete(p_store_id uuid, p_id uuid) RETURNS text
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  v_conv public.conversations;
BEGIN
  SELECT * INTO v_conv FROM public.conversations WHERE id = p_id AND store_id = p_store_id FOR UPDATE;
  IF FOUND THEN
    IF v_conv.ai_run_id IS NOT NULL THEN
      PERFORM public.conversation_settle_ai(p_store_id, v_conv.ai_run_day, false);
    END IF;
    DELETE FROM public.conversations WHERE id = v_conv.id AND store_id = p_store_id;
    IF v_conv.legacy_enquiry_id IS NOT NULL THEN
      DELETE FROM public.enquiries WHERE id = v_conv.legacy_enquiry_id AND store_id = p_store_id;
    END IF;
    RETURN 'conversation';
  END IF;
  DELETE FROM public.enquiries WHERE id = p_id AND store_id = p_store_id AND status <> 'answering';
  IF FOUND THEN
    RETURN 'enquiry';
  END IF;
  RETURN 'none';
END;
$$;

-- conversation_purge_expired --------------------------------------------------------------------
-- Retention: deletes conversations whose last activity is older than 12 months (and their linked legacy enquiry), at most p_limit per call, never one
-- with a run in flight newer than 10 minutes. Also deletes usage counters older than 3 days. Legacy enquiries that were never backfilled are
-- deleted only when p_include_legacy is true (default false: that is a change to existing data and needs the developer's approval).
-- Result: { conversations, legacy_enquiries, usage_rows }. Safe to run repeatedly and concurrently.
CREATE OR REPLACE FUNCTION public.conversation_purge_expired(p_limit integer DEFAULT 200, p_include_legacy boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  v_conversations integer := 0;
  v_legacy integer := 0;
  v_usage integer;
  v_cutoff timestamptz := now() - interval '12 months';
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'invalid limit' USING ERRCODE = '22023';
  END IF;
  WITH doomed AS (
    SELECT id, store_id, legacy_enquiry_id FROM public.conversations
      WHERE last_activity_at < v_cutoff AND (ai_run_started_at IS NULL OR ai_run_started_at < now() - interval '10 minutes')
      ORDER BY last_activity_at LIMIT p_limit FOR UPDATE SKIP LOCKED
  ), gone_enquiries AS (
    DELETE FROM public.enquiries e USING doomed d WHERE e.id = d.legacy_enquiry_id AND e.store_id = d.store_id RETURNING e.id
  ), gone AS (
    DELETE FROM public.conversations c USING doomed d WHERE c.id = d.id AND c.store_id = d.store_id RETURNING c.id
  )
  SELECT (SELECT count(*) FROM gone), (SELECT count(*) FROM gone_enquiries) INTO v_conversations, v_legacy;
  IF p_include_legacy THEN
    WITH old AS (
      SELECT id FROM public.enquiries WHERE updated_at < v_cutoff AND status <> 'answering'
        AND NOT EXISTS (SELECT 1 FROM public.conversations c WHERE c.legacy_enquiry_id = enquiries.id)
        ORDER BY updated_at LIMIT p_limit FOR UPDATE SKIP LOCKED
    ), removed AS (DELETE FROM public.enquiries e USING old WHERE e.id = old.id RETURNING e.id)
    SELECT v_legacy + count(*) INTO v_legacy FROM removed;
  END IF;
  DELETE FROM public.conversation_usage WHERE usage_day < public.conversation_india_day() - 3;
  GET DIAGNOSTICS v_usage = ROW_COUNT;
  RETURN jsonb_build_object('conversations', v_conversations, 'legacy_enquiries', v_legacy, 'usage_rows', v_usage);
END;
$$;

-- Function privileges: service_role only -------------------------------------------------------
REVOKE ALL ON FUNCTION public.conversation_india_day() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.conversation_take_customer_slot(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.conversation_reserve_ai(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.conversation_settle_ai(uuid, date, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.conversation_begin_run(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.conversation_start(uuid, uuid, text, text, text, text, text, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.conversation_post_message(uuid, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.conversation_finish_run(uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.conversation_seller_reply(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.conversation_delete(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.conversation_purge_expired(integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.conversation_india_day() TO service_role;
GRANT EXECUTE ON FUNCTION public.conversation_take_customer_slot(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.conversation_reserve_ai(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.conversation_settle_ai(uuid, date, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.conversation_begin_run(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.conversation_start(uuid, uuid, text, text, text, text, text, uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.conversation_post_message(uuid, uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.conversation_finish_run(uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.conversation_seller_reply(uuid, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.conversation_delete(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.conversation_purge_expired(integer, boolean) TO service_role;
