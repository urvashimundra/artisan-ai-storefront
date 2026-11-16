-- Migration 008: orders, order_items, order_payment_attempts, per-store counter, and the order functions (Module 4a).
-- Apply in the Supabase SQL editor AFTER migration 007. Idempotent: safe to run more than once.
-- STATUS: written, NOT applied. The developer applies it, then runs db/verify/008_orders_checks.sql and
-- db/test/008_orders_smoke.sql (and the two-session race tests in db/test/008_orders_races.sql).
--
-- Manual UPI: the customer pays outside this app and submits the bank reference (UTR); the OWNER verifies the money and
-- marks the order paid. Nothing here verifies a payment automatically.
-- Limits and names are mirrored in src/domain/orderRules.js and src/domain/dbConstraints.js (a unit test compares them).
-- Every function sets search_path, is revoked from public/anon/authenticated and granted to service_role only.
-- Lock order (to avoid deadlocks): orders swept by id (SKIP LOCKED) -> products ascending id -> counter row -> inserts.

-- Per-store reference counter -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.store_order_counters (
  store_id    uuid    PRIMARY KEY REFERENCES public.stores (id) ON DELETE CASCADE,
  last_number integer NOT NULL,
  CONSTRAINT store_order_counters_last_number_check CHECK (last_number >= 1001)
);

-- orders --------------------------------------------------------------------------------------
-- status_token_hash is the SHA-256 (hex) of the private status-link token; the token itself is never stored.
-- payee_vpa and total_paise are snapshots taken at order time and never change. The status is the only source of truth
-- about the order; order_payment_attempts is history and is never used to infer a status.
CREATE TABLE IF NOT EXISTS public.orders (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id          uuid        NOT NULL REFERENCES public.stores (id) ON DELETE CASCADE,
  reference         text        NOT NULL,
  status            text        NOT NULL DEFAULT 'awaiting_payment',
  cancel_reason     text,
  status_token_hash text        NOT NULL,
  payee_vpa         text        NOT NULL,
  total_paise       bigint      NOT NULL,
  customer_name     text        NOT NULL,
  customer_phone    text        NOT NULL,
  customer_email    text,
  delivery_address  text,
  language          text        NOT NULL,
  utr               text,
  utr_submissions   smallint    NOT NULL DEFAULT 0,
  expires_at        timestamptz,
  stock_restored_at timestamptz,
  paid_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_id_store_id_key UNIQUE (id, store_id),
  CONSTRAINT orders_store_reference_key UNIQUE (store_id, reference),
  CONSTRAINT orders_status_token_hash_key UNIQUE (status_token_hash),
  CONSTRAINT orders_reference_format_check CHECK (reference ~ '^AS[0-9]{4,9}$'),
  CONSTRAINT orders_status_check CHECK (status IN ('awaiting_payment', 'payment_submitted', 'paid', 'not_received', 'cancelled')),
  CONSTRAINT orders_cancel_reason_check CHECK (cancel_reason IS NULL OR cancel_reason IN ('expired', 'customer', 'owner')),
  CONSTRAINT orders_cancel_reason_matches_status_check CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL)),
  CONSTRAINT orders_token_hash_format_check CHECK (status_token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT orders_payee_vpa_format_check CHECK (char_length(payee_vpa) <= 100 AND payee_vpa ~ '^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9.]{1,63}$'),
  CONSTRAINT orders_total_paise_check CHECK (total_paise > 0 AND total_paise <= 100000000000),
  CONSTRAINT orders_customer_name_length_check CHECK (char_length(customer_name) BETWEEN 1 AND 80),
  CONSTRAINT orders_customer_phone_format_check CHECK (customer_phone ~ '^91[6-9][0-9]{9}$'),
  CONSTRAINT orders_customer_email_check CHECK (customer_email IS NULL OR (char_length(customer_email) <= 254 AND customer_email ~ '^[^@[:space:]]+@[^@[:space:]]+$')),
  CONSTRAINT orders_delivery_address_length_check CHECK (delivery_address IS NULL OR char_length(delivery_address) BETWEEN 1 AND 300),
  CONSTRAINT orders_language_check CHECK (language IN ('en', 'gu', 'hi')),
  CONSTRAINT orders_utr_format_check CHECK (utr IS NULL OR utr ~ '^[0-9]{12}$'),
  CONSTRAINT orders_submitted_requires_utr_check CHECK (status <> 'payment_submitted' OR utr IS NOT NULL),
  CONSTRAINT orders_utr_submissions_check CHECK (utr_submissions BETWEEN 0 AND 3),
  CONSTRAINT orders_expires_at_matches_status_check CHECK ((status IN ('awaiting_payment', 'not_received')) = (expires_at IS NOT NULL)),
  CONSTRAINT orders_paid_at_matches_status_check CHECK ((status = 'paid') = (paid_at IS NOT NULL)),
  CONSTRAINT orders_stock_restored_only_when_cancelled_check CHECK ((status = 'cancelled') = (stock_restored_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS orders_status_expires_at_idx ON public.orders (status, expires_at);
CREATE INDEX IF NOT EXISTS orders_store_created_at_idx ON public.orders (store_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS orders_store_status_idx ON public.orders (store_id, status);

-- order_items ---------------------------------------------------------------------------------
-- Snapshots: title (chosen with the storefront's language rule), unit price, quantity, line total. There is no foreign key
-- to products on purpose: an owner may delete a product later and the order history must survive. stock_reserved says
-- whether this line took stock (products.stock NULL = unlimited, nothing to restore).
CREATE TABLE IF NOT EXISTS public.order_items (
  id               uuid     PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid     NOT NULL,
  store_id         uuid     NOT NULL,
  position         smallint NOT NULL,
  product_id       uuid     NOT NULL,
  title            text     NOT NULL,
  title_lang       text     NOT NULL,
  unit_price_paise bigint   NOT NULL,
  quantity         integer  NOT NULL,
  line_total_paise bigint   NOT NULL,
  stock_reserved   boolean  NOT NULL,
  CONSTRAINT order_items_order_fkey FOREIGN KEY (order_id, store_id) REFERENCES public.orders (id, store_id) ON DELETE CASCADE,
  CONSTRAINT order_items_order_product_key UNIQUE (order_id, product_id),
  CONSTRAINT order_items_title_length_check CHECK (char_length(title) BETWEEN 1 AND 100),
  CONSTRAINT order_items_title_lang_check CHECK (title_lang IN ('en', 'gu', 'hi')),
  CONSTRAINT order_items_unit_price_check CHECK (unit_price_paise > 0 AND unit_price_paise <= 100000000),
  CONSTRAINT order_items_quantity_check CHECK (quantity BETWEEN 1 AND 20),
  CONSTRAINT order_items_line_total_check CHECK (line_total_paise = unit_price_paise * quantity)
);

CREATE INDEX IF NOT EXISTS order_items_product_id_idx ON public.order_items (product_id);

-- order_payment_attempts ----------------------------------------------------------------------
-- Every UTR ever submitted. UNIQUE (store_id, utr) means a UTR can never be reused in the same store, not even after a
-- replacement. The same UTR is allowed in different stores.
CREATE TABLE IF NOT EXISTS public.order_payment_attempts (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   uuid        NOT NULL,
  store_id   uuid        NOT NULL,
  utr        text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_payment_attempts_order_fkey FOREIGN KEY (order_id, store_id) REFERENCES public.orders (id, store_id) ON DELETE CASCADE,
  CONSTRAINT order_payment_attempts_store_utr_key UNIQUE (store_id, utr),
  CONSTRAINT order_payment_attempts_utr_format_check CHECK (utr ~ '^[0-9]{12}$')
);

CREATE INDEX IF NOT EXISTS order_payment_attempts_order_id_idx ON public.order_payment_attempts (order_id, created_at);

-- Row level security and privileges ----------------------------------------------------------
ALTER TABLE public.store_order_counters   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_payment_attempts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.store_order_counters, public.orders, public.order_items, public.order_payment_attempts
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.store_order_counters, public.orders, public.order_items,
  public.order_payment_attempts TO service_role;

-- Helpers -------------------------------------------------------------------------------------
-- The payment window. The ONLY place the duration is defined in SQL (mirrored by ORDER_EXPIRY_MINUTES in JS).
CREATE OR REPLACE FUNCTION public.order_expiry_interval() RETURNS interval
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp
AS $$ SELECT interval '1 hour' $$;

-- Parses the item array sent by the app: [{product_id, quantity, expected_price_paise, title, title_lang}, ...].
CREATE OR REPLACE FUNCTION public.order_parse_items(p_items jsonb)
RETURNS TABLE (item_position int, product_id uuid, quantity int, expected_price_paise bigint, title text, title_lang text)
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp
AS $$
  SELECT e.ord::int, (e.item ->> 'product_id')::uuid, (e.item ->> 'quantity')::int,
         (e.item ->> 'expected_price_paise')::bigint, e.item ->> 'title', e.item ->> 'title_lang'
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS e(item, ord)
$$;

-- Cancels an order whose row the CALLER has already locked (FOR UPDATE) and puts its reserved stock back. The marker
-- stock_restored_at, set by the same guarded UPDATE, makes the restore happen at most once however callers race.
-- Does nothing for paid or already cancelled orders. Products are updated in ascending id order.
CREATE OR REPLACE FUNCTION public.order_cancel_locked(p_order_id uuid, p_reason text) RETURNS boolean
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  v_item record;
BEGIN
  UPDATE public.orders
     SET status = 'cancelled', cancel_reason = p_reason, expires_at = NULL, stock_restored_at = now(), updated_at = now()
   WHERE id = p_order_id AND status IN ('awaiting_payment', 'payment_submitted', 'not_received') AND stock_restored_at IS NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  FOR v_item IN
    SELECT product_id, store_id, quantity FROM public.order_items
     WHERE order_id = p_order_id AND stock_reserved ORDER BY product_id
  LOOP
    UPDATE public.products SET stock = stock + v_item.quantity
     WHERE id = v_item.product_id AND store_id = v_item.store_id AND stock IS NOT NULL;
  END LOOP;
  RETURN true;
END;
$$;

-- True when p_owner_id owns p_store_id. Owner-only functions call this first.
CREATE OR REPLACE FUNCTION public.order_owner_matches(p_store_id uuid, p_owner_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $$ SELECT EXISTS (SELECT 1 FROM public.stores WHERE id = p_store_id AND owner_id = p_owner_id) $$;

-- expire_overdue_orders ----------------------------------------------------------------------
-- Cancels (reason expired) this store's overdue awaiting_payment / not_received orders and restores their stock. Uses
-- FOR UPDATE SKIP LOCKED, so concurrent sweeps and cancels never block or double-process. p_product_ids (optional)
-- limits the sweep to orders containing those products. At most 100 orders per call. Uses database time only.
-- Returns how many orders were expired.
CREATE OR REPLACE FUNCTION public.expire_overdue_orders(p_store_id uuid, p_product_ids uuid[] DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_count integer := 0;
BEGIN
  IF p_store_id IS NULL THEN
    RETURN 0;
  END IF;
  FOR v_id IN
    SELECT o.id FROM public.orders o
     WHERE o.store_id = p_store_id
       AND o.status IN ('awaiting_payment', 'not_received')
       AND o.expires_at <= now()
       AND (p_product_ids IS NULL OR EXISTS (
             SELECT 1 FROM public.order_items i WHERE i.order_id = o.id AND i.product_id = ANY (p_product_ids)))
     ORDER BY o.id
     LIMIT 100
     FOR UPDATE OF o SKIP LOCKED
  LOOP
    IF public.order_cancel_locked(v_id, 'expired') THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;

-- place_order ---------------------------------------------------------------------------------
-- All-or-nothing: validate every line against the locked product rows, then reserve stock, allocate the reference and
-- insert. p_items is an array; every line carries the price the app computed from its own read, and any mismatch (status,
-- price, store, stock, payee) rejects the whole order with nothing written (apart from sweeping overdue orders first,
-- which is always correct). products.stock NULL means unlimited.
-- Returns {ok:true, order_id, reference, expires_at} or {ok:false, reason: invalid | store_not_found | payee_changed |
--   product_unavailable | price_changed | insufficient_stock | total_mismatch}.
CREATE OR REPLACE FUNCTION public.place_order(
  p_store_id uuid, p_token_hash text, p_payee_vpa text, p_customer_name text, p_customer_phone text,
  p_customer_email text, p_delivery_address text, p_language text, p_expected_total bigint, p_items jsonb
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  v_ids uuid[];
  v_lines int;
  v_upi text;
  v_row record;
  v_seen int := 0;
  v_total bigint := 0;
  v_number int;
  v_order_id uuid;
  v_reference text;
  v_expires timestamptz;
BEGIN
  IF p_store_id IS NULL OR p_token_hash IS NULL OR p_payee_vpa IS NULL OR p_customer_name IS NULL OR p_customer_phone IS NULL
     OR p_language IS NULL OR p_expected_total IS NULL OR p_items IS NULL OR jsonb_typeof(p_items) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 20 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;

  SELECT array_agg(product_id), count(*) INTO v_ids, v_lines FROM public.order_parse_items(p_items);
  IF v_lines <> jsonb_array_length(p_items) OR (SELECT count(DISTINCT x) FROM unnest(v_ids) AS x) <> v_lines
     OR EXISTS (SELECT 1 FROM public.order_parse_items(p_items) i WHERE i.quantity NOT BETWEEN 1 AND 20) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;

  PERFORM public.expire_overdue_orders(p_store_id, v_ids);

  SELECT upi_id INTO v_upi FROM public.stores WHERE id = p_store_id FOR SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'store_not_found');
  END IF;
  IF v_upi IS DISTINCT FROM p_payee_vpa THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'payee_changed');
  END IF;

  -- Pass 1: lock the products in ascending id order and validate every line. Nothing is written.
  FOR v_row IN
    SELECT p.id, p.status, p.price_paise, p.stock, i.quantity, i.expected_price_paise
      FROM public.products p JOIN public.order_parse_items(p_items) i ON i.product_id = p.id
     WHERE p.store_id = p_store_id ORDER BY p.id FOR UPDATE OF p
  LOOP
    v_seen := v_seen + 1;
    IF v_row.status <> 'published' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'product_unavailable');
    ELSIF v_row.price_paise IS DISTINCT FROM v_row.expected_price_paise THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'price_changed');
    ELSIF v_row.stock IS NOT NULL AND v_row.stock < v_row.quantity THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_stock');
    END IF;
    v_total := v_total + v_row.price_paise * v_row.quantity;
  END LOOP;
  IF v_seen <> v_lines THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'product_unavailable');
  END IF;
  IF v_total <> p_expected_total THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'total_mismatch');
  END IF;

  -- Pass 2: allocate the reference (atomic, no SELECT MAX), insert the order, reserve stock, insert the lines.
  INSERT INTO public.store_order_counters (store_id, last_number) VALUES (p_store_id, 1001)
    ON CONFLICT (store_id) DO UPDATE SET last_number = public.store_order_counters.last_number + 1
    RETURNING last_number INTO v_number;
  v_reference := 'AS' || v_number::text;
  v_expires := now() + public.order_expiry_interval();

  INSERT INTO public.orders (store_id, reference, status_token_hash, payee_vpa, total_paise, customer_name, customer_phone,
                             customer_email, delivery_address, language, expires_at)
    VALUES (p_store_id, v_reference, p_token_hash, p_payee_vpa, v_total, p_customer_name, p_customer_phone,
            p_customer_email, p_delivery_address, p_language, v_expires)
    RETURNING id INTO v_order_id;

  INSERT INTO public.order_items (order_id, store_id, position, product_id, title, title_lang, unit_price_paise, quantity,
                                  line_total_paise, stock_reserved)
    SELECT v_order_id, p_store_id, i.item_position, p.id, i.title, i.title_lang, p.price_paise, i.quantity,
           p.price_paise * i.quantity, p.stock IS NOT NULL
      FROM public.products p JOIN public.order_parse_items(p_items) i ON i.product_id = p.id
     WHERE p.store_id = p_store_id;

  UPDATE public.products p SET stock = p.stock - i.quantity
    FROM public.order_parse_items(p_items) i
   WHERE p.id = i.product_id AND p.store_id = p_store_id AND p.stock IS NOT NULL;

  RETURN jsonb_build_object('ok', true, 'order_id', v_order_id, 'reference', v_reference, 'expires_at', v_expires);
END;
$$;

-- submit_payment_reference --------------------------------------------------------------------
-- The customer's UTR. Allowed from awaiting_payment and not_received only; at most 3 submissions per order, counted by
-- orders.utr_submissions, which only this function increments. The attempt row and the status change commit together.
-- A repeat of the SAME utr on an order already payment_submitted is an idempotent success.
-- Returns {ok:true, already?} or {ok:false, reason: not_found | invalid | invalid_transition | expired | attempt_limit | utr_in_use}.
CREATE OR REPLACE FUNCTION public.submit_payment_reference(p_store_id uuid, p_token_hash text, p_utr text) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
BEGIN
  IF p_store_id IS NULL OR p_token_hash IS NULL OR p_utr IS NULL OR p_utr !~ '^[0-9]{12}$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;
  SELECT * INTO v_order FROM public.orders WHERE store_id = p_store_id AND status_token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF v_order.status = 'payment_submitted' AND v_order.utr = p_utr THEN
    RETURN jsonb_build_object('ok', true, 'already', true);
  END IF;
  IF v_order.status NOT IN ('awaiting_payment', 'not_received') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_transition');
  END IF;
  IF v_order.expires_at <= now() THEN
    PERFORM public.order_cancel_locked(v_order.id, 'expired');
    RETURN jsonb_build_object('ok', false, 'reason', 'expired');
  END IF;
  IF v_order.utr_submissions >= 3 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'attempt_limit');
  END IF;
  BEGIN
    INSERT INTO public.order_payment_attempts (order_id, store_id, utr) VALUES (v_order.id, p_store_id, p_utr);
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'utr_in_use');
  END;
  UPDATE public.orders
     SET status = 'payment_submitted', utr = p_utr, utr_submissions = utr_submissions + 1, expires_at = NULL, updated_at = now()
   WHERE id = v_order.id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- resolve_payment -----------------------------------------------------------------------------
-- Owner only (p_owner_id must own p_store_id). payment_submitted -> paid | not_received. not_received gets a fresh
-- payment window and keeps the stock held; paid is terminal and never restores stock. A repeat of the same outcome is an
-- idempotent success. Customers have no way to call this.
-- Returns {ok:true, already?} or {ok:false, reason: not_found | invalid | invalid_transition}.
CREATE OR REPLACE FUNCTION public.resolve_payment(p_store_id uuid, p_owner_id uuid, p_order_id uuid, p_outcome text) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
BEGIN
  IF p_store_id IS NULL OR p_owner_id IS NULL OR p_order_id IS NULL OR p_outcome IS NULL OR p_outcome NOT IN ('paid', 'not_received') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;
  IF NOT public.order_owner_matches(p_store_id, p_owner_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id AND store_id = p_store_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF v_order.status = p_outcome THEN
    RETURN jsonb_build_object('ok', true, 'already', true);
  END IF;
  IF v_order.status <> 'payment_submitted' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_transition');
  END IF;
  IF p_outcome = 'paid' THEN
    UPDATE public.orders SET status = 'paid', paid_at = now(), expires_at = NULL, updated_at = now() WHERE id = v_order.id;
  ELSE
    UPDATE public.orders SET status = 'not_received', expires_at = now() + public.order_expiry_interval(), updated_at = now()
     WHERE id = v_order.id;
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- cancel_order --------------------------------------------------------------------------------
-- p_actor 'owner': p_owner_id must own the store; allowed from awaiting_payment, payment_submitted, not_received.
-- p_actor 'customer': p_token_hash must match the order; allowed from awaiting_payment and not_received only.
-- Paid is terminal. Cancelling twice (or after expiry) is an idempotent success. Stock is restored once (see
-- order_cancel_locked). Returns {ok:true, already?} or {ok:false, reason: not_found | invalid | invalid_transition}.
CREATE OR REPLACE FUNCTION public.cancel_order(p_store_id uuid, p_order_id uuid, p_actor text, p_owner_id uuid, p_token_hash text)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
BEGIN
  IF p_store_id IS NULL OR p_order_id IS NULL OR p_actor IS NULL OR p_actor NOT IN ('owner', 'customer') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;
  IF p_actor = 'owner' AND (p_owner_id IS NULL OR NOT public.order_owner_matches(p_store_id, p_owner_id)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id AND store_id = p_store_id FOR UPDATE;
  IF NOT FOUND OR (p_actor = 'customer' AND v_order.status_token_hash IS DISTINCT FROM p_token_hash) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF v_order.status = 'cancelled' THEN
    RETURN jsonb_build_object('ok', true, 'already', true);
  END IF;
  IF v_order.status = 'paid' OR (p_actor = 'customer' AND v_order.status = 'payment_submitted') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_transition');
  END IF;
  PERFORM public.order_cancel_locked(v_order.id, p_actor);
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Function privileges -------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.order_expiry_interval() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.order_parse_items(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.order_cancel_locked(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.order_owner_matches(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.expire_overdue_orders(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.place_order(uuid, text, text, text, text, text, text, text, bigint, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.submit_payment_reference(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.resolve_payment(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cancel_order(uuid, uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.order_expiry_interval() TO service_role;
GRANT EXECUTE ON FUNCTION public.order_parse_items(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_cancel_locked(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_owner_matches(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.expire_overdue_orders(uuid, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.place_order(uuid, text, text, text, text, text, text, text, bigint, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.submit_payment_reference(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_payment(uuid, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_order(uuid, uuid, text, uuid, text) TO service_role;

-- Rollback (manual, only if needed, and only on a database holding no orders you need):
--   DROP FUNCTION public.cancel_order(uuid, uuid, text, uuid, text);
--   DROP FUNCTION public.resolve_payment(uuid, uuid, uuid, text);
--   DROP FUNCTION public.submit_payment_reference(uuid, text, text);
--   DROP FUNCTION public.place_order(uuid, text, text, text, text, text, text, text, bigint, jsonb);
--   DROP FUNCTION public.expire_overdue_orders(uuid, uuid[]);
--   DROP FUNCTION public.order_owner_matches(uuid, uuid);
--   DROP FUNCTION public.order_cancel_locked(uuid, text);
--   DROP FUNCTION public.order_parse_items(jsonb);
--   DROP FUNCTION public.order_expiry_interval();
--   DROP TABLE public.order_payment_attempts; DROP TABLE public.order_items; DROP TABLE public.orders;
--   DROP TABLE public.store_order_counters;
