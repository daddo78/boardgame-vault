-- Sign-in by membership (not by a card on Dan's shelf), visit tracking for usage metrics, and admin tools.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 017_sign_in_admin.sql  (safe to re-run)
BEGIN;

ALTER TABLE members ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

-- One row per member per day they used the site (hits = signed-in requests that day)
CREATE TABLE IF NOT EXISTS member_days (
  member_id bigint NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  day date NOT NULL,
  hits int NOT NULL DEFAULT 1,
  PRIMARY KEY (member_id, day));

-- Site settings an admin can change
CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO settings (key, value) VALUES ('ask_per_member', '30') ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION bgc.ask_limit() RETURNS int LANGUAGE sql STABLE AS
$$ SELECT coalesce((SELECT (value #>> '{}')::int FROM settings WHERE key = 'ask_per_member'), 30) $$;

-- Every signed-in request: are they a member (on the invite list)? Their card on Dan's shelf if he plays with them
-- (linked by name the first time), whether they're an admin, and a visit for today.
CREATE OR REPLACE FUNCTION bgc.sign_in(email text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE m members; pkey text; pname text;
BEGIN
  SELECT * INTO m FROM members WHERE google_email = lower(email);
  IF NOT FOUND THEN RETURN jsonb_build_object('member', false); END IF;
  UPDATE players pl SET linked_member_id = m.id, updated_at = now()
  WHERE pl.owner_id = at.admin_id() AND pl.linked_member_id IS NULL AND lower(pl.name) = lower(m.display_name)
    AND NOT EXISTS (SELECT 1 FROM players x WHERE x.owner_id = at.admin_id() AND x.linked_member_id = m.id);
  SELECT legacy_id, name INTO pkey, pname FROM players WHERE owner_id = at.admin_id() AND linked_member_id = m.id LIMIT 1;
  INSERT INTO member_days (member_id, day) VALUES (m.id, bgc.ask_day()) ON CONFLICT (member_id, day) DO UPDATE SET hits = member_days.hits + 1;
  UPDATE members SET last_seen_at = now() WHERE id = m.id;
  RETURN jsonb_build_object('member', true, 'id', m.id, 'name', m.display_name, 'isAdmin', m.is_admin, 'playerId', pkey, 'playerName', coalesce(pname, m.display_name));
END $$;

CREATE OR REPLACE FUNCTION bgc.is_admin(email text) RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT coalesce((SELECT is_admin FROM members WHERE google_email = lower(email)), false) $$;

-- Everything the admin page shows: site-wide numbers, the last 30 days, and each member
CREATE OR REPLACE FUNCTION bgc.admin_overview(email text) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE today date := bgc.ask_day();
BEGIN
  IF NOT bgc.is_admin(email) THEN RETURN jsonb_build_object('ok', false, 'status', 403, 'message', 'Admins only'); END IF;
  RETURN jsonb_build_object('ok', true, 'askLimit', bgc.ask_limit(),
    'totals', jsonb_build_object(
      'members', (SELECT count(*) FROM members),
      'activeToday', (SELECT count(*) FROM member_days WHERE day = today),
      'active7', (SELECT count(DISTINCT member_id) FROM member_days WHERE day > today - 7),
      'active30', (SELECT count(DISTINCT member_id) FROM member_days WHERE day > today - 30),
      'questionsToday', (SELECT coalesce(sum(questions), 0) FROM ask_usage WHERE day = today),
      'questions7', (SELECT coalesce(sum(questions), 0) FROM ask_usage WHERE day > today - 7),
      'questions30', (SELECT coalesce(sum(questions), 0) FROM ask_usage WHERE day > today - 30),
      'games', (SELECT count(*) FROM shelves),
      'gamesAdded7', (SELECT count(*) FROM shelves WHERE added_at > now() - interval '7 days'),
      'ratings', (SELECT count(*) FROM ratings),
      'wishlist', (SELECT count(*) FROM wishlist),
      'friendships', (SELECT count(*) FROM friendships WHERE status = 'accepted'),
      'plays', (SELECT count(*) FROM plays)),
    'daily', (SELECT jsonb_agg(jsonb_build_object('day', d::date,
        'active', (SELECT count(*) FROM member_days md WHERE md.day = d::date),
        'questions', (SELECT coalesce(sum(questions), 0) FROM ask_usage a WHERE a.day = d::date)) ORDER BY d)
      FROM generate_series(today - 29, today, interval '1 day') d),
    'members', (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', m.id, 'name', m.display_name, 'email', m.google_email, 'isAdmin', m.is_admin, 'isOwner', m.id = at.admin_id(),
        'joined', at.iso(m.created_at), 'lastSeen', at.iso(m.last_seen_at),
        'activeDays30', (SELECT count(*) FROM member_days md WHERE md.member_id = m.id AND md.day > today - 30),
        'questionsToday', coalesce((SELECT questions FROM ask_usage a WHERE a.member_id = m.id AND a.day = today), 0),
        'questions7', (SELECT coalesce(sum(questions), 0) FROM ask_usage a WHERE a.member_id = m.id AND a.day > today - 7),
        'questionsAll', (SELECT coalesce(sum(questions), 0) FROM ask_usage a WHERE a.member_id = m.id),
        'games', (SELECT count(*) FROM shelves s WHERE s.member_id = m.id),
        'gamesAdded30', (SELECT count(*) FROM shelves s WHERE s.member_id = m.id AND s.added_at > now() - interval '30 days'),
        'plays', (SELECT count(*) FROM plays p WHERE p.owner_id = m.id),
        'ratings', (SELECT count(*) FROM ratings r WHERE r.member_id = m.id),
        'wishlist', (SELECT count(*) FROM wishlist w WHERE w.member_id = m.id),
        'friends', (SELECT count(*) FROM friendships f WHERE f.status = 'accepted' AND m.id IN (f.requester_id, f.addressee_id)),
        'bgg', m.bgg_username, 'demo', m.google_email LIKE '%.invalid')
      ORDER BY m.last_seen_at DESC NULLS LAST, m.display_name), '[]') FROM members m));
END $$;

-- Admin actions. v: invite { email, name } | remove {} | admin { on } | resetAsks {} | askLimit { value }
CREATE OR REPLACE FUNCTION bgc.admin_action(email text, action text, target bigint, v jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE me bigint := bgc.member_id(email); t members; addr text; nm text; lim int;
BEGIN
  IF NOT bgc.is_admin(email) THEN RETURN jsonb_build_object('ok', false, 'status', 403, 'message', 'Admins only'); END IF;
  IF action = 'invite' THEN
    addr := lower(btrim(coalesce(v ->> 'email', ''))); nm := btrim(coalesce(v ->> 'name', ''));
    IF addr !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN RETURN jsonb_build_object('ok', false, 'status', 400, 'message', 'That email doesn’t look right'); END IF;
    IF nm = '' THEN RETURN jsonb_build_object('ok', false, 'status', 400, 'message', 'Add their name'); END IF;
    IF EXISTS (SELECT 1 FROM members WHERE google_email = addr) THEN RETURN jsonb_build_object('ok', false, 'status', 409, 'message', addr || ' is already a member'); END IF;
    INSERT INTO members (google_email, display_name) VALUES (addr, nm);
    RETURN jsonb_build_object('ok', true, 'message', nm || ' can sign in now with ' || addr);
  ELSIF action = 'askLimit' THEN
    lim := (v ->> 'value')::int;
    IF lim IS NULL OR lim < 1 OR lim > 500 THEN RETURN jsonb_build_object('ok', false, 'status', 400, 'message', 'Pick a limit from 1 to 500'); END IF;
    INSERT INTO settings (key, value, updated_at) VALUES ('ask_per_member', to_jsonb(lim), now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
    RETURN jsonb_build_object('ok', true, 'message', 'Everyone now gets ' || lim || ' questions a day');
  END IF;
  SELECT * INTO t FROM members WHERE id = target;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'status', 404, 'message', 'No such member'); END IF;
  IF action = 'remove' THEN
    IF t.id = me THEN RETURN jsonb_build_object('ok', false, 'status', 400, 'message', 'You can’t remove yourself'); END IF;
    IF t.id = at.admin_id() THEN RETURN jsonb_build_object('ok', false, 'status', 400, 'message', 'Dan’s account can’t be removed'); END IF;
    DELETE FROM ratings WHERE member_id = t.id;
    DELETE FROM ask_usage WHERE member_id = t.id;
    DELETE FROM members WHERE id = t.id; -- their shelf, plays, people, friendships, wishlist and visits go with them
    RETURN jsonb_build_object('ok', true, 'message', t.display_name || ' was removed');
  ELSIF action = 'admin' THEN
    IF t.id = at.admin_id() THEN RETURN jsonb_build_object('ok', false, 'status', 400, 'message', 'Dan is always an admin'); END IF;
    UPDATE members SET is_admin = coalesce((v ->> 'on')::boolean, false), updated_at = now() WHERE id = t.id;
    RETURN jsonb_build_object('ok', true, 'message', t.display_name || CASE WHEN (v ->> 'on')::boolean THEN ' is now an admin' ELSE ' is no longer an admin' END);
  ELSIF action = 'resetAsks' THEN
    DELETE FROM ask_usage WHERE member_id = t.id AND day = bgc.ask_day();
    RETURN jsonb_build_object('ok', true, 'message', t.display_name || ' has a fresh set of questions today');
  END IF;
  RETURN jsonb_build_object('ok', false, 'status', 400, 'message', 'Unknown action');
END $$;

COMMIT;
