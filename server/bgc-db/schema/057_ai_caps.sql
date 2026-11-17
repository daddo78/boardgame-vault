-- Caps on AI spending (review, Nov 16). Nathan had a per-member daily limit, but nothing capped the site as a whole, and
-- reading a photo of boxes (a vision call, then a blurb and icon for each new game) had no daily limit at all.
--   * A site-wide daily budget in dollars (settings ai_daily_cap_usd, $5 to start; the busiest day so far cost $0.70):
--     once today's ai_costs reach it, Nathan, photos, new games' blurbs and the rulebook reader stop until midnight
--     (Eastern, like Nathan's allowance). Blurbs and rulebooks catch up later; nothing is lost.
--   * Photos: ai_photo_per_member a day for each member (10 to start).
-- bgc.use_ai(email, what) counts one use and says whether it may go ahead; bgc.ai_budget_ok() is the budget alone.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 057_ai_caps.sql  (or bash apply.sh)
BEGIN;

INSERT INTO settings (key, value) VALUES ('ai_daily_cap_usd', '5'), ('ai_photo_per_member', '10') ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS ai_uses (
  member_id bigint NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  day       date NOT NULL,
  kind      text NOT NULL,
  n         int NOT NULL DEFAULT 0,
  PRIMARY KEY (member_id, day, kind));

-- What the AI has cost today (Eastern), and whether there's budget left
CREATE OR REPLACE FUNCTION bgc.ai_spent_today() RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(cost), 0) FROM ai_costs WHERE at >= (bgc.ask_day()::timestamp AT TIME ZONE 'America/Detroit') $$;
CREATE OR REPLACE FUNCTION bgc.ai_budget_ok() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT bgc.ai_spent_today() < coalesce((SELECT (value #>> '{}')::numeric FROM settings WHERE key = 'ai_daily_cap_usd'), 5) $$;

-- One use of an AI feature by a member: { ok } or { ok: false, status, message }. A kind with no daily limit of its own
-- ('ask': Nathan keeps his own allowance) is checked against the budget only.
CREATE OR REPLACE FUNCTION bgc.use_ai(email text, what text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE mid bigint := bgc.member_id(email); lim int; used int;
BEGIN
  IF mid IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 401, 'message', 'Sign in to do that'); END IF;
  IF NOT bgc.ai_budget_ok() THEN
    RETURN jsonb_build_object('ok', false, 'status', 429, 'message', 'Board Game Curator has used its AI budget for today. Try again tomorrow.');
  END IF;
  lim := CASE what WHEN 'photo' THEN coalesce((SELECT (value #>> '{}')::int FROM settings WHERE key = 'ai_photo_per_member'), 10) END;
  IF lim IS NULL THEN RETURN jsonb_build_object('ok', true); END IF;
  INSERT INTO ai_uses (member_id, day, kind, n) VALUES (mid, bgc.ask_day(), what, 1)
  ON CONFLICT (member_id, day, kind) DO UPDATE SET n = ai_uses.n + 1 RETURNING n INTO used;
  IF used > lim THEN
    RETURN jsonb_build_object('ok', false, 'status', 429, 'message', 'That''s ' || lim || ' photos today, the most for one day. Try again tomorrow, or add games by name.');
  END IF;
  RETURN jsonb_build_object('ok', true, 'left', lim - used);
END $$;

COMMIT;
