-- Migration 002: AI budget guard (Module 2a). Money unit: integer micro-USD.
-- Apply in the Supabase SQL editor after 001. Idempotent: safe to run more than once.
-- The budget day is computed here, never passed by the app: (now() at time zone 'Asia/Kolkata')::date.
--
-- LOCK ORDER (fixed, all three functions): the global day row FIRST, then the owner day row, then the
-- reservation row. reserve_ai_budget always locks TODAY's global row first, so every reservation is
-- serialized on it and cannot deadlock with another reservation. settle/release lock only the global and
-- owner rows of the reservation's own date, in the same order. A holder of an owner row always already
-- holds that date's global row, so no lock cycle can form.
--
-- Expired reservations are CHARGED as spent (the call may have reached the provider).
-- Settling above the reserved amount records the full actual as spent (overshoot is not capped).

-- Tables --------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_usage_daily (
  owner_id           uuid   NOT NULL REFERENCES public.owners (id) ON DELETE CASCADE,
  usage_date         date   NOT NULL,
  reserved_micro_usd bigint NOT NULL DEFAULT 0,
  spent_micro_usd    bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_id, usage_date),
  CONSTRAINT ai_usage_daily_amounts_check CHECK (reserved_micro_usd >= 0 AND spent_micro_usd >= 0)
);

CREATE TABLE IF NOT EXISTS public.ai_usage_global_daily (
  usage_date         date   PRIMARY KEY,
  reserved_micro_usd bigint NOT NULL DEFAULT 0,
  spent_micro_usd    bigint NOT NULL DEFAULT 0,
  CONSTRAINT ai_usage_global_daily_amounts_check CHECK (reserved_micro_usd >= 0 AND spent_micro_usd >= 0)
);

CREATE TABLE IF NOT EXISTS public.ai_reservations (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         uuid        NOT NULL REFERENCES public.owners (id) ON DELETE CASCADE,
  usage_date       date        NOT NULL,
  amount_micro_usd bigint      NOT NULL,
  status           text        NOT NULL DEFAULT 'reserved',
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_reservations_amount_check CHECK (amount_micro_usd >= 0),
  CONSTRAINT ai_reservations_status_check CHECK (status IN ('reserved', 'settled', 'released', 'expired'))
);

CREATE INDEX IF NOT EXISTS ai_reservations_status_expires_idx ON public.ai_reservations (status, expires_at);

ALTER TABLE public.ai_usage_daily        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage_global_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_reservations       ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.ai_usage_daily, public.ai_usage_global_daily, public.ai_reservations
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.ai_usage_daily, public.ai_usage_global_daily, public.ai_reservations TO service_role;

-- reserve_ai_budget ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_ai_budget(
  p_owner_id uuid, p_amount bigint, p_owner_limit bigint, p_global_limit bigint, p_ttl_seconds int
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_stale record;
  v_stale_amount bigint;
  v_owner_total bigint;
  v_global_total bigint;
  v_id uuid;
BEGIN
  IF p_owner_id IS NULL OR p_amount IS NULL OR p_owner_limit IS NULL OR p_global_limit IS NULL
     OR p_ttl_seconds IS NULL OR p_amount <= 0 OR p_owner_limit < 0 OR p_global_limit < 0
     OR p_amount > p_owner_limit OR p_ttl_seconds < 30 OR p_ttl_seconds > 3600
     OR NOT EXISTS (SELECT 1 FROM public.owners WHERE id = p_owner_id) THEN
    RETURN jsonb_build_object('ok', false, 'reservation_id', null, 'reason', 'invalid');
  END IF;

  INSERT INTO public.ai_usage_global_daily (usage_date) VALUES (v_today) ON CONFLICT DO NOTHING;
  INSERT INTO public.ai_usage_daily (owner_id, usage_date) VALUES (p_owner_id, v_today) ON CONFLICT DO NOTHING;

  PERFORM 1 FROM public.ai_usage_global_daily WHERE usage_date = v_today FOR UPDATE;

  FOR v_stale IN
    SELECT id, owner_id, usage_date FROM public.ai_reservations
    WHERE status = 'reserved' AND expires_at < now() ORDER BY usage_date, id
  LOOP
    PERFORM 1 FROM public.ai_usage_global_daily WHERE usage_date = v_stale.usage_date FOR UPDATE;
    PERFORM 1 FROM public.ai_usage_daily
      WHERE owner_id = v_stale.owner_id AND usage_date = v_stale.usage_date FOR UPDATE;
    SELECT amount_micro_usd INTO v_stale_amount FROM public.ai_reservations
      WHERE id = v_stale.id AND status = 'reserved' AND expires_at < now() FOR UPDATE;
    IF FOUND THEN
      UPDATE public.ai_usage_daily
        SET reserved_micro_usd = reserved_micro_usd - v_stale_amount, spent_micro_usd = spent_micro_usd + v_stale_amount
        WHERE owner_id = v_stale.owner_id AND usage_date = v_stale.usage_date;
      UPDATE public.ai_usage_global_daily
        SET reserved_micro_usd = reserved_micro_usd - v_stale_amount, spent_micro_usd = spent_micro_usd + v_stale_amount
        WHERE usage_date = v_stale.usage_date;
      UPDATE public.ai_reservations SET status = 'expired' WHERE id = v_stale.id;
    END IF;
  END LOOP;

  SELECT reserved_micro_usd + spent_micro_usd INTO v_owner_total FROM public.ai_usage_daily
    WHERE owner_id = p_owner_id AND usage_date = v_today FOR UPDATE;
  SELECT reserved_micro_usd + spent_micro_usd INTO v_global_total FROM public.ai_usage_global_daily
    WHERE usage_date = v_today;

  IF v_owner_total + p_amount > p_owner_limit THEN
    RETURN jsonb_build_object('ok', false, 'reservation_id', null, 'reason', 'owner_limit');
  END IF;
  IF v_global_total + p_amount > p_global_limit THEN
    RETURN jsonb_build_object('ok', false, 'reservation_id', null, 'reason', 'global_limit');
  END IF;

  UPDATE public.ai_usage_daily SET reserved_micro_usd = reserved_micro_usd + p_amount
    WHERE owner_id = p_owner_id AND usage_date = v_today;
  UPDATE public.ai_usage_global_daily SET reserved_micro_usd = reserved_micro_usd + p_amount
    WHERE usage_date = v_today;
  INSERT INTO public.ai_reservations (owner_id, usage_date, amount_micro_usd, expires_at)
    VALUES (p_owner_id, v_today, p_amount, now() + make_interval(secs => p_ttl_seconds))
    RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'reservation_id', v_id, 'reason', null);
END;
$$;

-- settle_ai_budget ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.settle_ai_budget(p_reservation_id uuid, p_actual bigint)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_res record;
  v_amount bigint;
  v_spent bigint;
BEGIN
  IF p_reservation_id IS NULL OR p_actual IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'changed', false);
  END IF;
  SELECT owner_id, usage_date INTO v_res FROM public.ai_reservations WHERE id = p_reservation_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'changed', false);
  END IF;

  PERFORM 1 FROM public.ai_usage_global_daily WHERE usage_date = v_res.usage_date FOR UPDATE;
  PERFORM 1 FROM public.ai_usage_daily WHERE owner_id = v_res.owner_id AND usage_date = v_res.usage_date FOR UPDATE;
  SELECT amount_micro_usd INTO v_amount FROM public.ai_reservations
    WHERE id = p_reservation_id AND status = 'reserved' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'changed', false);
  END IF;

  v_spent := greatest(p_actual, 0);
  UPDATE public.ai_usage_daily
    SET reserved_micro_usd = reserved_micro_usd - v_amount, spent_micro_usd = spent_micro_usd + v_spent
    WHERE owner_id = v_res.owner_id AND usage_date = v_res.usage_date;
  UPDATE public.ai_usage_global_daily
    SET reserved_micro_usd = reserved_micro_usd - v_amount, spent_micro_usd = spent_micro_usd + v_spent
    WHERE usage_date = v_res.usage_date;
  UPDATE public.ai_reservations SET status = 'settled' WHERE id = p_reservation_id;
  RETURN jsonb_build_object('ok', true, 'changed', true);
END;
$$;

-- release_ai_budget ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_ai_budget(p_reservation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_res record;
  v_amount bigint;
BEGIN
  IF p_reservation_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'changed', false);
  END IF;
  SELECT owner_id, usage_date INTO v_res FROM public.ai_reservations WHERE id = p_reservation_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'changed', false);
  END IF;

  PERFORM 1 FROM public.ai_usage_global_daily WHERE usage_date = v_res.usage_date FOR UPDATE;
  PERFORM 1 FROM public.ai_usage_daily WHERE owner_id = v_res.owner_id AND usage_date = v_res.usage_date FOR UPDATE;
  SELECT amount_micro_usd INTO v_amount FROM public.ai_reservations
    WHERE id = p_reservation_id AND status = 'reserved' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'changed', false);
  END IF;

  UPDATE public.ai_usage_daily SET reserved_micro_usd = reserved_micro_usd - v_amount
    WHERE owner_id = v_res.owner_id AND usage_date = v_res.usage_date;
  UPDATE public.ai_usage_global_daily SET reserved_micro_usd = reserved_micro_usd - v_amount
    WHERE usage_date = v_res.usage_date;
  UPDATE public.ai_reservations SET status = 'released' WHERE id = p_reservation_id;
  RETURN jsonb_build_object('ok', true, 'changed', true);
END;
$$;

-- Function privileges: callable by service_role only ---------------------------------------------
REVOKE EXECUTE ON FUNCTION public.reserve_ai_budget(uuid, bigint, bigint, bigint, int) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.settle_ai_budget(uuid, bigint) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.release_ai_budget(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_ai_budget(uuid, bigint, bigint, bigint, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_ai_budget(uuid, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_ai_budget(uuid) TO service_role;
