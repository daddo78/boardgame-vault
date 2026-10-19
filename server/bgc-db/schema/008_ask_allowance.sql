-- Nathan's daily allowance: days roll over at midnight Eastern (the group's time zone), and everyone can see what's left.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 008_ask_allowance.sql  (safe to re-run)
BEGIN;

CREATE OR REPLACE FUNCTION bgc.ask_day() RETURNS date LANGUAGE sql STABLE AS
$$ SELECT (now() AT TIME ZONE 'America/Detroit')::date $$;

-- Count one question; returns how many this member has asked today (including this one)
CREATE OR REPLACE FUNCTION bgc.use_ask(email text) RETURNS integer LANGUAGE sql AS $$
  INSERT INTO ask_usage (member_id, day, questions) VALUES (coalesce(bgc.member_id(email), 0), bgc.ask_day(), 1)
  ON CONFLICT (member_id, day) DO UPDATE SET questions = ask_usage.questions + 1
  RETURNING questions $$;

CREATE OR REPLACE FUNCTION bgc.asks_used(email text) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT questions FROM ask_usage WHERE member_id = bgc.member_id(email) AND day = bgc.ask_day()), 0) $$;

COMMIT;
