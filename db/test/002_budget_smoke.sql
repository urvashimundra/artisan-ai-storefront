-- Manual smoke test for migration 002. Run the WHOLE file in the Supabase SQL editor (as the default postgres role).
-- Success: one row with "ALL CHECKS PASSED". Failure: an error starting with "FAIL:" naming the broken check.
-- Leaves no data: the checks run inside a sub-transaction that is always rolled back (a sentinel exception
-- with SQLSTATE AB001 is raised at the end and caught). Uses a throwaway owner and tiny limits. The global
-- limits are set relative to today's existing global totals, so real usage rows are never changed.

CREATE OR REPLACE FUNCTION pg_temp.check_that(p_ok boolean, p_name text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN
    RAISE EXCEPTION 'FAIL: %', p_name;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.smoke_002() RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_owner uuid;
  v_g0 bigint;
  v_big bigint := 1000000000;
  v_r jsonb;
  v_a uuid;
  v_b uuid;
  v_c uuid;
  v_reserved bigint;
  v_spent bigint;
BEGIN
  INSERT INTO public.owners (email, password_hash)
    VALUES ('smoke-002-' || gen_random_uuid() || '@example.invalid', 'x') RETURNING id INTO v_owner;
  SELECT coalesce(sum(reserved_micro_usd + spent_micro_usd), 0) INTO v_g0
    FROM public.ai_usage_global_daily WHERE usage_date = v_today;

  -- within-limit reserve (owner limit 1000)
  v_r := public.reserve_ai_budget(v_owner, 400, 1000, v_g0 + v_big, 60);
  PERFORM pg_temp.check_that((v_r->>'ok')::boolean AND v_r->>'reservation_id' IS NOT NULL, 'reserve within limit');
  v_a := (v_r->>'reservation_id')::uuid;
  SELECT reserved_micro_usd, spent_micro_usd INTO v_reserved, v_spent
    FROM public.ai_usage_daily WHERE owner_id = v_owner AND usage_date = v_today;
  PERFORM pg_temp.check_that(v_reserved = 400 AND v_spent = 0, 'owner row shows 400 reserved');

  -- owner limit refused, nothing changed
  v_r := public.reserve_ai_budget(v_owner, 700, 1000, v_g0 + v_big, 60);
  PERFORM pg_temp.check_that(NOT (v_r->>'ok')::boolean AND v_r->>'reason' = 'owner_limit', 'owner limit refused');
  SELECT reserved_micro_usd INTO v_reserved FROM public.ai_usage_daily WHERE owner_id = v_owner AND usage_date = v_today;
  PERFORM pg_temp.check_that(v_reserved = 400, 'refused reserve changed nothing');

  -- global limit refused (owner limit would still allow 400 + 600 = 1000)
  v_r := public.reserve_ai_budget(v_owner, 600, 1000, v_g0 + 500, 60);
  PERFORM pg_temp.check_that(NOT (v_r->>'ok')::boolean AND v_r->>'reason' = 'global_limit', 'global limit refused');

  -- invalid inputs
  PERFORM pg_temp.check_that(public.reserve_ai_budget(v_owner, 0, 1000, v_big, 60)->>'reason' = 'invalid', 'amount 0 invalid');
  PERFORM pg_temp.check_that(public.reserve_ai_budget(v_owner, -5, 1000, v_big, 60)->>'reason' = 'invalid', 'negative amount invalid');
  PERFORM pg_temp.check_that(public.reserve_ai_budget(v_owner, 2000, 1000, v_big, 60)->>'reason' = 'invalid', 'amount above owner limit invalid');
  PERFORM pg_temp.check_that(public.reserve_ai_budget(v_owner, 10, -1, v_big, 60)->>'reason' = 'invalid', 'negative limit invalid');
  PERFORM pg_temp.check_that(public.reserve_ai_budget(v_owner, 10, 1000, v_big, 10)->>'reason' = 'invalid', 'ttl too short invalid');
  PERFORM pg_temp.check_that(public.reserve_ai_budget(v_owner, 10, 1000, v_big, 7200)->>'reason' = 'invalid', 'ttl too long invalid');
  PERFORM pg_temp.check_that(public.reserve_ai_budget(NULL, 10, 1000, v_big, 60)->>'reason' = 'invalid', 'null owner invalid');
  PERFORM pg_temp.check_that(public.reserve_ai_budget(gen_random_uuid(), 10, 1000, v_big, 60)->>'reason' = 'invalid', 'unknown owner invalid');

  -- settle moves reserved to spent; idempotent
  v_r := public.settle_ai_budget(v_a, 300);
  PERFORM pg_temp.check_that((v_r->>'ok')::boolean AND (v_r->>'changed')::boolean, 'settle changed');
  SELECT reserved_micro_usd, spent_micro_usd INTO v_reserved, v_spent
    FROM public.ai_usage_daily WHERE owner_id = v_owner AND usage_date = v_today;
  PERFORM pg_temp.check_that(v_reserved = 0 AND v_spent = 300, 'settle moved 400 reserved to 300 spent');
  v_r := public.settle_ai_budget(v_a, 300);
  PERFORM pg_temp.check_that((v_r->>'ok')::boolean AND NOT (v_r->>'changed')::boolean, 'second settle is a no-op');
  SELECT spent_micro_usd INTO v_spent FROM public.ai_usage_daily WHERE owner_id = v_owner AND usage_date = v_today;
  PERFORM pg_temp.check_that(v_spent = 300, 'second settle did not double count');

  -- release frees capacity; idempotent; settle after release is a no-op
  v_r := public.reserve_ai_budget(v_owner, 700, 1000, v_g0 + v_big, 60);
  PERFORM pg_temp.check_that((v_r->>'ok')::boolean, 'reserve up to the exact limit');
  v_b := (v_r->>'reservation_id')::uuid;
  PERFORM pg_temp.check_that(public.reserve_ai_budget(v_owner, 100, 1000, v_g0 + v_big, 60)->>'reason' = 'owner_limit', 'full owner refused');
  v_r := public.release_ai_budget(v_b);
  PERFORM pg_temp.check_that((v_r->>'ok')::boolean AND (v_r->>'changed')::boolean, 'release changed');
  PERFORM pg_temp.check_that(NOT (public.release_ai_budget(v_b)->>'changed')::boolean, 'second release is a no-op');
  PERFORM pg_temp.check_that(NOT (public.settle_ai_budget(v_b, 50)->>'changed')::boolean, 'settle after release is a no-op');
  v_r := public.reserve_ai_budget(v_owner, 100, 1000, v_g0 + v_big, 60);
  PERFORM pg_temp.check_that((v_r->>'ok')::boolean, 'released capacity is reusable');
  v_c := (v_r->>'reservation_id')::uuid;
  SELECT reserved_micro_usd, spent_micro_usd INTO v_reserved, v_spent
    FROM public.ai_usage_daily WHERE owner_id = v_owner AND usage_date = v_today;
  PERFORM pg_temp.check_that(v_reserved = 100 AND v_spent = 300, 'totals after release and re-reserve');

  -- expired reservation is charged by the next reserve; its later settle is a no-op
  UPDATE public.ai_reservations SET expires_at = now() - interval '1 minute' WHERE id = v_c;
  v_r := public.reserve_ai_budget(v_owner, 50, 1000, v_g0 + v_big, 60);
  PERFORM pg_temp.check_that((v_r->>'ok')::boolean, 'reserve after expiry');
  PERFORM pg_temp.check_that((SELECT status FROM public.ai_reservations WHERE id = v_c) = 'expired', 'stale reservation marked expired');
  SELECT reserved_micro_usd, spent_micro_usd INTO v_reserved, v_spent
    FROM public.ai_usage_daily WHERE owner_id = v_owner AND usage_date = v_today;
  PERFORM pg_temp.check_that(v_reserved = 50 AND v_spent = 400, 'expired 100 was charged as spent');
  PERFORM pg_temp.check_that(NOT (public.settle_ai_budget(v_c, 1)->>'changed')::boolean, 'settle after expiry is a no-op');
  SELECT spent_micro_usd INTO v_spent FROM public.ai_usage_daily WHERE owner_id = v_owner AND usage_date = v_today;
  PERFORM pg_temp.check_that(v_spent = 400, 'settle after expiry changed nothing');

  RAISE EXCEPTION 'smoke complete, rolling back' USING ERRCODE = 'AB001';
EXCEPTION
  WHEN SQLSTATE 'AB001' THEN
    RETURN 'ALL CHECKS PASSED';
END;
$$;

SELECT pg_temp.smoke_002() AS result;
