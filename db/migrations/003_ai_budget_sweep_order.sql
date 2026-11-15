-- Migration 003: fix a cross-date lock-order deadlock in reserve_ai_budget (see docs/DECISIONS.md, decision 43).
-- Only change from migration 002: the expired-reservation sweep now orders by "usage_date DESC, id"
-- (was "usage_date, id"). Everything else in the function is identical to 002. Do not edit 002: it is applied.
-- The function body matches the deployed function (002 as applied, including the global-row lock before the owner-row insert).
-- Safe to run more than once.
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
  PERFORM 1 FROM public.ai_usage_global_daily WHERE usage_date = v_today FOR UPDATE;
  INSERT INTO public.ai_usage_daily (owner_id, usage_date) VALUES (p_owner_id, v_today) ON CONFLICT DO NOTHING;


  FOR v_stale IN
    SELECT id, owner_id, usage_date FROM public.ai_reservations
    WHERE status = 'reserved' AND expires_at < now() ORDER BY usage_date DESC, id
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

REVOKE EXECUTE ON FUNCTION public.reserve_ai_budget(uuid, bigint, bigint, bigint, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_ai_budget(uuid, bigint, bigint, bigint, int) TO service_role;
