-- Migration 012: shop knowledge assistant and seller enquiries inbox (Module 6). Apply in the Supabase SQL editor AFTER migration 011.
-- Idempotent: safe to run more than once. No functions: the one atomic step (claim pending -> answering) is a single conditional UPDATE
-- made by the app, so there is nothing to grant or revoke at function level. Tables follow the 007 / 008 conventions: RLS on, no policies,
-- every browser role revoked, service_role only.
-- STATUS: written, NOT applied. The developer applies it, then runs db/verify/012_assistant_checks.sql and db/test/012_assistant_smoke.sql.
--
-- store_knowledge: the seller's document (<= 20000 code points) and the bulk-discount tiers the seller CONFIRMED. The app clears the
--   tiers whenever the document is replaced. Tiers are [{ "minQty": 2..1000, "percentOff": 1..50 }], at most 5 (strict ordering and ranges
--   are validated by Zod in src/domain/knowledgeRules.js, mirrored there).
-- enquiries: a customer's question to the seller and what the assistant did with it. token_hash is the SHA-256 of the private link token
--   (the only lookup key). token_enc is the same token encrypted with the SAME AES-256-GCM helper and ORDER_LINK_KEY as order links
--   (migration 011, src/lib/linkCipher.js), so the seller's WhatsApp reply can carry the customer's private link.
--   Limits mirror src/domain/enquiryRules.js. ON DELETE SET NULL (product_id) needs PostgreSQL 15 or newer (Supabase Cloud has it).

CREATE TABLE IF NOT EXISTS public.store_knowledge (
  store_id   uuid        NOT NULL,
  content    text        NOT NULL DEFAULT '',
  bulk_rules jsonb       NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_knowledge_pkey PRIMARY KEY (store_id),
  CONSTRAINT store_knowledge_store_fkey FOREIGN KEY (store_id) REFERENCES public.stores (id) ON DELETE CASCADE,
  CONSTRAINT store_knowledge_content_length_check CHECK (char_length(content) <= 20000),
  CONSTRAINT store_knowledge_bulk_rules_check
    CHECK (CASE WHEN jsonb_typeof(bulk_rules) = 'array' THEN jsonb_array_length(bulk_rules) <= 5 ELSE false END)
);

CREATE TABLE IF NOT EXISTS public.enquiries (
  id             uuid        NOT NULL DEFAULT gen_random_uuid(),
  store_id       uuid        NOT NULL,
  product_id     uuid,
  language       text        NOT NULL,
  customer_name  text        NOT NULL,
  customer_phone text        NOT NULL,
  question       text        NOT NULL,
  status         text        NOT NULL DEFAULT 'pending',
  answer_text    text,
  flag_reason    text,
  trace          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  seller_reply   text,
  replied_at     timestamptz,
  token_hash     text        NOT NULL,
  token_enc      text,
  claimed_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT enquiries_pkey PRIMARY KEY (id),
  CONSTRAINT enquiries_store_fkey FOREIGN KEY (store_id) REFERENCES public.stores (id) ON DELETE CASCADE,
  CONSTRAINT enquiries_product_fkey FOREIGN KEY (product_id, store_id) REFERENCES public.products (id, store_id) ON DELETE SET NULL (product_id),
  CONSTRAINT enquiries_token_hash_key UNIQUE (token_hash),
  CONSTRAINT enquiries_language_check CHECK (language IN ('en', 'gu', 'hi')),
  CONSTRAINT enquiries_customer_name_check CHECK (char_length(customer_name) BETWEEN 1 AND 80),
  CONSTRAINT enquiries_customer_phone_check CHECK (customer_phone ~ '^[0-9]{10,15}$'),
  CONSTRAINT enquiries_question_check CHECK (char_length(question) BETWEEN 1 AND 500),
  CONSTRAINT enquiries_status_check CHECK (status IN ('pending', 'answering', 'answered', 'needs_you', 'handled')),
  CONSTRAINT enquiries_answer_text_check CHECK (answer_text IS NULL OR char_length(answer_text) BETWEEN 1 AND 3000),
  CONSTRAINT enquiries_answered_has_answer_check CHECK (status <> 'answered' OR answer_text IS NOT NULL),
  CONSTRAINT enquiries_flag_reason_check
    CHECK (flag_reason IS NULL OR flag_reason IN ('not_in_document', 'budget', 'error', 'too_complex', 'unverified_amount', 'daily_cap')),
  CONSTRAINT enquiries_trace_check
    CHECK (CASE WHEN jsonb_typeof(trace) = 'array'
                THEN jsonb_array_length(trace) <= 12 AND NOT jsonb_path_exists(trace, '$[*] ? (@.type() != "string")')
                ELSE false END),
  CONSTRAINT enquiries_seller_reply_check CHECK (seller_reply IS NULL OR char_length(seller_reply) BETWEEN 1 AND 1000),
  CONSTRAINT enquiries_reply_pair_check CHECK ((seller_reply IS NULL) = (replied_at IS NULL)),
  CONSTRAINT enquiries_token_hash_format_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT enquiries_token_enc_check CHECK (token_enc IS NULL OR (char_length(token_enc) BETWEEN 1 AND 200 AND token_enc ~ '^[A-Za-z0-9_-]+$'))
);

CREATE INDEX IF NOT EXISTS enquiries_store_status_created_idx ON public.enquiries (store_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS enquiries_store_phone_created_idx ON public.enquiries (store_id, customer_phone, created_at);

-- Row level security and privileges: service_role only (the app); browser roles get nothing and there are no policies.
ALTER TABLE public.store_knowledge ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enquiries       ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.store_knowledge, public.enquiries FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.store_knowledge, public.enquiries TO service_role;

-- Rollback (manual, only if needed):
--   DROP TABLE IF EXISTS public.enquiries;
--   DROP TABLE IF EXISTS public.store_knowledge;
