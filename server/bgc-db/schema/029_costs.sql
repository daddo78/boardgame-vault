-- What the site costs: AI spending (exact, from OpenRouter) split by feature, the OpenRouter balance, and fixed costs
-- an admin types in (hosting, domains). Shown on Admin → Costs.
--   ai_usage_snapshots  every hour: what this site's OpenRouter key has spent in total, and the account's balance
--   ai_costs            each AI call's own cost, by feature (Nathan, photos, rulebooks, tests); the rest shows as "Other"
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 029_costs.sql  (safe to re-run)
BEGIN;

CREATE TABLE IF NOT EXISTS ai_usage_snapshots (
  at            timestamptz PRIMARY KEY DEFAULT now(),
  key_usage     numeric(14,6),   -- dollars this API key has spent since it was made
  key_limit     numeric(14,6),   -- the key's own spending limit, if it has one
  credits_total numeric(14,6),   -- the account's credits bought
  credits_used  numeric(14,6));  -- the account's credits used (all keys)

CREATE TABLE IF NOT EXISTS ai_costs (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  feature    text NOT NULL,      -- nathan, photo, rulebook, tests
  model      text,
  cost       numeric(12,6) NOT NULL DEFAULT 0,
  tokens_in  int,
  tokens_out int,
  member_id  bigint REFERENCES members(id) ON DELETE SET NULL);
CREATE INDEX IF NOT EXISTS ai_costs_at ON ai_costs (at);

-- Record AI calls: [{feature, model, cost, in, out}] (calls without a cost are skipped)
CREATE OR REPLACE FUNCTION bgc.log_ai(email text, calls jsonb) RETURNS void LANGUAGE sql AS $$
  INSERT INTO ai_costs (feature, model, cost, tokens_in, tokens_out, member_id)
  SELECT left(coalesce(c ->> 'feature', 'other'), 20), left(c ->> 'model', 80), (c ->> 'cost')::numeric,
    nullif(c ->> 'in', '')::int, nullif(c ->> 'out', '')::int, bgc.member_id(email)
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(calls) = 'array' THEN calls ELSE '[]' END) c
  WHERE (c ->> 'cost') ~ '^[0-9.eE-]+$' $$;

CREATE OR REPLACE FUNCTION bgc.log_usage(key_usage numeric, key_limit numeric, credits_total numeric, credits_used numeric) RETURNS void LANGUAGE sql AS $$
  INSERT INTO ai_usage_snapshots (key_usage, key_limit, credits_total, credits_used) VALUES (key_usage, key_limit, credits_total, credits_used) $$;

-- Fixed costs: [{name, amount, per: "month" | "year"}]
CREATE OR REPLACE FUNCTION bgc.costs_fixed_save(email text, items jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  IF NOT bgc.is_admin(email) THEN RETURN jsonb_build_object('ok', false, 'status', 403, 'message', 'Admins only'); END IF;
  INSERT INTO settings (key, value, updated_at) VALUES ('fixed_costs', coalesce((
    SELECT jsonb_agg(jsonb_build_object('name', left(btrim(i ->> 'name'), 60), 'amount', round((i ->> 'amount')::numeric, 2), 'per', CASE WHEN i ->> 'per' = 'year' THEN 'year' ELSE 'month' END))
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(items) = 'array' THEN items ELSE '[]' END) i
    WHERE btrim(coalesce(i ->> 'name', '')) <> '' AND (i ->> 'amount') ~ '^[0-9]+(\.[0-9]+)?$'), '[]'), now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  RETURN bgc.costs_page(email);
END $$;

-- The Costs page
CREATE OR REPLACE FUNCTION bgc.costs_page(email text) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE tz text := 'America/Detroit'; today date := (now() AT TIME ZONE 'America/Detroit')::date;
  month_start date := date_trunc('month', (now() AT TIME ZONE 'America/Detroit'))::date;
  days_in_month int := extract(day from (date_trunc('month', (now() AT TIME ZONE 'America/Detroit')) + interval '1 month - 1 day'))::int;
  last ai_usage_snapshots; first ai_usage_snapshots; fixed jsonb; fixed_month numeric; tracked_days int;
BEGIN
  IF NOT bgc.is_admin(email) THEN RETURN jsonb_build_object('ok', false, 'status', 403, 'message', 'Admins only'); END IF;
  SELECT * INTO last FROM ai_usage_snapshots ORDER BY at DESC LIMIT 1;
  SELECT * INTO first FROM ai_usage_snapshots ORDER BY at LIMIT 1;
  -- The projection uses the days actually tracked this month (tracking may have started part way through)
  tracked_days := greatest(today - greatest(month_start, coalesce((first.at AT TIME ZONE tz)::date, today)) + 1, 1);
  fixed := coalesce((SELECT value FROM settings WHERE key = 'fixed_costs'), '[]');
  fixed_month := coalesce((SELECT sum(CASE WHEN f ->> 'per' = 'year' THEN (f ->> 'amount')::numeric / 12 ELSE (f ->> 'amount')::numeric END) FROM jsonb_array_elements(fixed) f), 0);
  RETURN (WITH
    -- Exact spending per day: how much the key's running total grew that day (Eastern)
    snaps AS (SELECT (at AT TIME ZONE tz)::date AS day, max(key_usage) AS usage FROM ai_usage_snapshots GROUP BY 1),
    exact AS (SELECT day, greatest(usage - lag(usage) OVER (ORDER BY day), 0) AS spent FROM snaps),
    tracked AS (SELECT (at AT TIME ZONE tz)::date AS day, feature, sum(cost) AS cost, count(*) AS calls FROM ai_costs GROUP BY 1, 2),
    days AS (SELECT d::date AS day FROM generate_series(today - 59, today, interval '1 day') d),
    daily AS (SELECT d.day,
        coalesce((SELECT spent FROM exact e WHERE e.day = d.day), 0) AS exact,
        coalesce((SELECT jsonb_object_agg(feature, round(cost, 4)) FROM tracked t WHERE t.day = d.day), '{}') AS features,
        coalesce((SELECT sum(cost) FROM tracked t WHERE t.day = d.day), 0) AS tracked
      FROM days d),
    month AS (SELECT coalesce(sum(greatest(exact, tracked)), 0) AS ai FROM daily WHERE day >= month_start),
    q30 AS (SELECT count(*) AS n FROM ask_log WHERE at > now() - interval '30 days'),
    nathan30 AS (SELECT coalesce(sum(cost), 0) AS c FROM ai_costs WHERE feature IN ('nathan', 'photo') AND at > now() - interval '30 days'),
    pages AS (SELECT count(*) AS n, coalesce(sum(cost), 0) AS c FROM ai_costs WHERE feature = 'rulebook'),
    active30 AS (SELECT count(DISTINCT member_id) AS n FROM member_days WHERE day > today - 30)
  SELECT jsonb_build_object('ok', true, 'generatedAt', at.iso(now()),
    'tracking', jsonb_build_object('since', at.iso(first.at), 'lastCheck', at.iso(last.at), 'callsSince', (SELECT at.iso(min(at)) FROM ai_costs)),
    'balance', CASE WHEN last.credits_total IS NOT NULL THEN round(last.credits_total - last.credits_used, 2) END,
    'keyAllTime', round(last.key_usage, 2), 'keyLimit', last.key_limit,
    'today', (SELECT round(greatest(exact, tracked), 4) FROM daily WHERE day = today),
    'last7', (SELECT round(sum(greatest(exact, tracked)), 4) FROM daily WHERE day > today - 7),
    'last30', (SELECT round(sum(greatest(exact, tracked)), 4) FROM daily WHERE day > today - 30),
    'monthToDate', round((SELECT ai FROM month), 4),
    'projectedAi', round((SELECT ai FROM month) / tracked_days * days_in_month, 2),
    'fixed', fixed, 'fixedMonthly', round(fixed_month, 2),
    'projectedMonth', round((SELECT ai FROM month) / tracked_days * days_in_month + fixed_month, 2),
    'daily', (SELECT jsonb_agg(jsonb_build_object('day', day, 'exact', round(exact, 4), 'tracked', round(tracked, 4), 'features', features) ORDER BY day) FROM daily),
    'byFeature', coalesce((SELECT jsonb_object_agg(feature, jsonb_build_object('cost30', round(c30, 4), 'costAll', round(call, 4), 'calls30', n30, 'callsAll', nall)) FROM (
        SELECT feature, sum(cost) FILTER (WHERE at > now() - interval '30 days') AS c30, sum(cost) AS call,
          count(*) FILTER (WHERE at > now() - interval '30 days') AS n30, count(*) AS nall FROM ai_costs GROUP BY feature) f), '{}'),
    'perQuestion', (SELECT CASE WHEN q30.n > 0 THEN round(nathan30.c / q30.n, 5) END FROM q30, nathan30),
    'perRulebookPage', (SELECT CASE WHEN n > 0 THEN round(c / n, 5) END FROM pages),
    'perActiveMember', (SELECT CASE WHEN n > 0 THEN round((SELECT sum(greatest(exact, tracked)) FROM daily WHERE day > today - 30) / n, 3) END FROM active30)));
END $$;

COMMIT;
