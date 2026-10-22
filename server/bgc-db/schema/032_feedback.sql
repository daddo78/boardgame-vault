-- Feedback from members (the cog → Send feedback): how it's going (1–5, optional), what kind (an idea, a problem,
-- praise, a question) and their words, plus the page and device it came from. Admins read it in Admin → Feedback.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 032_feedback.sql  (safe to re-run)
BEGIN;

CREATE TABLE IF NOT EXISTS feedback (
  id         bigserial PRIMARY KEY,
  member_id  bigint REFERENCES members(id) ON DELETE SET NULL,
  kind       text NOT NULL DEFAULT 'idea' CHECK (kind IN ('idea', 'problem', 'praise', 'question')),
  mood       smallint CHECK (mood BETWEEN 1 AND 5),
  message    text NOT NULL DEFAULT '',
  page       text NOT NULL DEFAULT '',
  device     text NOT NULL DEFAULT '',
  status     text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'seen', 'done')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feedback_at ON feedback (created_at DESC);

-- A member sends feedback (up to 10 a day); an admin marks one seen or done
CREATE OR REPLACE FUNCTION bgc.feedback(email text, b jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE me bigint := bgc.member_id(email); k text; m int; msg text; n int; f bigint;
BEGIN
  IF me IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 403, 'message', 'Members only'); END IF;
  IF b ->> 'action' = 'status' THEN
    IF NOT bgc.is_admin(email) THEN RETURN jsonb_build_object('ok', false, 'status', 403, 'message', 'Admins only'); END IF;
    UPDATE feedback SET status = CASE WHEN b ->> 'status' IN ('new', 'seen', 'done') THEN b ->> 'status' ELSE status END
    WHERE id = (b ->> 'id')::bigint;
    RETURN jsonb_build_object('ok', true);
  END IF;
  k := CASE WHEN b ->> 'kind' IN ('idea', 'problem', 'praise', 'question') THEN b ->> 'kind' ELSE 'idea' END;
  m := CASE WHEN (b ->> 'mood') ~ '^[1-5]$' THEN (b ->> 'mood')::int END;
  msg := left(btrim(coalesce(b ->> 'message', '')), 2000);
  IF msg = '' AND m IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 400, 'message', 'Tell us a little, or pick how it''s going.'); END IF;
  SELECT count(*) INTO n FROM feedback WHERE member_id = me AND created_at > now() - interval '1 day';
  IF n >= 10 THEN RETURN jsonb_build_object('ok', false, 'status', 429, 'message', 'That''s 10 notes today, thank you! Send more tomorrow.'); END IF;
  INSERT INTO feedback (member_id, kind, mood, message, page, device)
  VALUES (me, k, m, msg, left(coalesce(b ->> 'page', ''), 200), left(coalesce(b ->> 'device', ''), 300))
  RETURNING id INTO f;
  RETURN jsonb_build_object('ok', true, 'id', f, 'kind', k, 'mood', m, 'message', msg,
    'name', (SELECT display_name FROM members WHERE id = me), 'from', email);
END $$;

-- Admin → Feedback: the latest 200, newest first, with who sent each, and how it's going on average
CREATE OR REPLACE FUNCTION bgc.feedback_all(email text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN NOT bgc.is_admin(email) THEN NULL ELSE jsonb_build_object(
    'items', coalesce((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', f.id, 'kind', f.kind, 'mood', f.mood, 'message', f.message,
        'page', nullif(f.page, ''), 'device', nullif(f.device, ''), 'status', f.status, 'at', at.iso(f.created_at),
        'name', m.display_name, 'email', m.google_email)) ORDER BY f.created_at DESC)
      FROM (SELECT * FROM feedback ORDER BY created_at DESC LIMIT 200) f LEFT JOIN members m ON m.id = f.member_id), '[]'),
    'open', (SELECT count(*) FROM feedback WHERE status = 'new'),
    'mood', (SELECT round(avg(mood), 1) FROM feedback WHERE mood IS NOT NULL AND created_at > now() - interval '90 days'),
    'moods', (SELECT count(*) FROM feedback WHERE mood IS NOT NULL AND created_at > now() - interval '90 days')) END $$;

COMMIT;
