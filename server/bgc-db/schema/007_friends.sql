-- Phase 3: friends by code. Entering someone's code connects you both right away; you see a member's shelf
-- only if you're friends (Dan's collection stays visible to every member).
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 007_friends.sql  (safe to re-run)
BEGIN;

-- Friend codes: 6 characters, no look-alikes (0/O, 1/I/L), e.g. "K7MPQ2"
CREATE OR REPLACE FUNCTION bgc.new_friend_code() RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE c text;
BEGIN
  LOOP
    SELECT string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + floor(random() * 31)::int, 1), '') INTO c FROM generate_series(1, 6);
    EXIT WHEN NOT EXISTS (SELECT 1 FROM members WHERE friend_code = c);
  END LOOP;
  RETURN c;
END $$;
ALTER TABLE members ALTER COLUMN friend_code SET DEFAULT bgc.new_friend_code();
UPDATE members SET friend_code = bgc.new_friend_code() WHERE friend_code !~ '^[A-HJ-KM-NP-Z2-9]{6}$';

CREATE OR REPLACE FUNCTION bgc.are_friends(a bigint, b bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM friendships WHERE status = 'accepted'
    AND ((requester_id = a AND addressee_id = b) OR (requester_id = b AND addressee_id = a))) $$;

-- Your code and your friends (with how many games each has)
CREATE OR REPLACE FUNCTION bgc.friends(email text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH me AS (SELECT id, friend_code FROM members WHERE google_email = email)
  SELECT jsonb_build_object('code', me.friend_code, 'friends', coalesce((
    SELECT jsonb_agg(jsonb_build_object('id', m.id, 'name', m.display_name, 'firstName', split_part(m.display_name, ' ', 1),
      'games', (SELECT count(*) FROM shelves s WHERE s.member_id = m.id), 'isAdmin', m.is_admin) ORDER BY m.display_name)
    FROM friendships f JOIN members m ON m.id = CASE WHEN f.requester_id = me.id THEN f.addressee_id ELSE f.requester_id END
    WHERE f.status = 'accepted' AND me.id IN (f.requester_id, f.addressee_id)), '[]'))
  FROM me $$;

-- Entering a code: connected both ways right away
CREATE OR REPLACE FUNCTION bgc.add_friend(email text, code text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE me bigint := bgc.member_id(email); other members; clean text := upper(regexp_replace(coalesce(code, ''), '[^A-Za-z0-9]', '', 'g'));
BEGIN
  IF me IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 401, 'message', 'Sign in to do that'); END IF;
  SELECT * INTO other FROM members WHERE friend_code = clean;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'status', 404, 'message', 'No one has the code ' || clean || '. Check it and try again.'); END IF;
  IF other.id = me THEN RETURN jsonb_build_object('ok', false, 'status', 400, 'message', 'That’s your own code. Share it with a friend instead!'); END IF;
  IF bgc.are_friends(me, other.id) THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'friend', jsonb_build_object('id', other.id, 'name', other.display_name));
  END IF;
  INSERT INTO friendships (requester_id, addressee_id, status, accepted_at) VALUES (me, other.id, 'accepted', now())
    ON CONFLICT DO NOTHING;
  UPDATE friendships SET status = 'accepted', accepted_at = coalesce(accepted_at, now())
    WHERE (requester_id = other.id AND addressee_id = me) OR (requester_id = me AND addressee_id = other.id);
  RETURN jsonb_build_object('ok', true, 'friend', jsonb_build_object('id', other.id, 'name', other.display_name));
END $$;

CREATE OR REPLACE FUNCTION bgc.remove_friend(email text, friend_id bigint) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE me bigint := bgc.member_id(email); n int;
BEGIN
  DELETE FROM friendships WHERE (requester_id = me AND addressee_id = friend_id) OR (requester_id = friend_id AND addressee_id = me);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('ok', n > 0);
END $$;

-- A friend's shelf (view only): only if you're friends; their thinning list stays private
CREATE OR REPLACE FUNCTION bgc.friend_shelf(email text, friend_id bigint) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE me bigint := bgc.member_id(email);
BEGIN
  IF me IS NULL OR NOT bgc.are_friends(me, friend_id) THEN
    RETURN jsonb_build_object('ok', false, 'status', 403, 'message', 'You can see a shelf once you’re friends');
  END IF;
  RETURN jsonb_build_object('ok', true, 'name', (SELECT display_name FROM members WHERE id = friend_id),
    'records', coalesce((SELECT jsonb_agg(jsonb_set(at.game_record(s), '{fields,fldskzh1rq9uchgYI}', 'false'::jsonb) ORDER BY s.num NULLS LAST, s.legacy_id)
                         FROM shelves s WHERE s.member_id = friend_id), '[]'));
END $$;

-- Nathan and the @ list on a friend's shelf: shelf = 'friend:<id>' (only if you're friends; otherwise Dan's shelf)
CREATE OR REPLACE FUNCTION bgc.shelf_view(email text, shelf text, main_asker text) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE mid bigint := bgc.member_id(email); oid bigint; fid bigint; asker text; owner_name text; kind text;
BEGIN
  fid := CASE WHEN shelf ~ '^friend:\d+$' THEN substr(shelf, 8)::bigint END;
  IF fid IS NOT NULL AND mid IS NOT NULL AND bgc.are_friends(mid, fid) THEN oid := fid; kind := 'friend';
  ELSIF shelf = 'mine' AND mid IS NOT NULL THEN oid := mid; kind := 'mine';
  ELSE oid := at.admin_id(); kind := 'main'; END IF;
  IF kind = 'main' THEN asker := main_asker;
  ELSE SELECT legacy_id INTO asker FROM players WHERE owner_id = oid AND linked_member_id = mid LIMIT 1; END IF;
  SELECT split_part(display_name, ' ', 1) INTO owner_name FROM members WHERE id = oid;
  RETURN jsonb_build_object(
    'shelf', kind, 'ownerName', owner_name, 'askerKey', asker,
    'games', coalesce((SELECT jsonb_agg(CASE WHEN kind = 'friend' THEN jsonb_set(at.game_record(s), '{fields,fldskzh1rq9uchgYI}', 'false'::jsonb) ELSE at.game_record(s) END
                       ORDER BY s.num NULLS LAST, s.legacy_id) FROM shelves s WHERE s.member_id = oid), '[]'),
    'players', coalesce((SELECT jsonb_agg(at.player_record(p) ORDER BY p.name) FROM players p WHERE p.owner_id = oid), '[]'),
    'ratings', coalesce((SELECT jsonb_agg(x) FROM at.rating_records_for(oid) x), '[]'));
END $$;

COMMIT;
