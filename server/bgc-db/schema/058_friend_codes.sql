-- Friend codes that can't be guessed (review, Nov 16). Codes were 6 characters from Postgres random() (not meant for
-- secrets), they never changed, and a matching code makes a friendship at once, which opens the other person's shelf,
-- profile, wishlist and plays. Now:
--   * new codes are 10 characters from gen_random_uuid() (a strong random source), about 8 x 10^14 possibilities;
--   * after 10 codes that match nobody in an hour, a member has to wait (friend_tries);
--   * a member can make a new code (bgc.friend_code_reset): the old one stops working, friends already made stay.
-- Codes already given out keep working, so nobody's shared code breaks; a member who wants a stronger one makes a new one.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 058_friend_codes.sql  (or bash apply.sh)
BEGIN;

CREATE OR REPLACE FUNCTION bgc.new_friend_code() RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE c text; b bytea;
BEGIN
  LOOP
    b := uuid_send(gen_random_uuid());
    SELECT string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + get_byte(b, i) % 31, 1), '' ORDER BY i) INTO c FROM generate_series(0, 9) i;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM members WHERE friend_code = c);
  END LOOP;
  RETURN c;
END $$;

CREATE TABLE IF NOT EXISTS friend_tries (
  member_id bigint NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  at        timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS friend_tries_member ON friend_tries (member_id, at);

-- 007's add_friend, with a limit on codes that match nobody
CREATE OR REPLACE FUNCTION bgc.add_friend(email text, code text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE me bigint := bgc.member_id(email); other members; clean text := upper(regexp_replace(coalesce(code, ''), '[^A-Za-z0-9]', '', 'g'));
BEGIN
  IF me IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 401, 'message', 'Sign in to do that'); END IF;
  IF (SELECT count(*) FROM friend_tries WHERE member_id = me AND at > now() - interval '1 hour') >= 10 THEN
    RETURN jsonb_build_object('ok', false, 'status', 429, 'message', 'That''s a lot of codes that didn''t match. Check the code with your friend and try again in an hour.');
  END IF;
  SELECT * INTO other FROM members WHERE friend_code = clean;
  IF NOT FOUND THEN
    INSERT INTO friend_tries (member_id) VALUES (me);
    DELETE FROM friend_tries WHERE at < now() - interval '1 day';
    RETURN jsonb_build_object('ok', false, 'status', 404, 'message', 'No one has the code ' || clean || '. Check it and try again.');
  END IF;
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

-- A new code for the signed-in member; the old one stops working, friends already made stay
CREATE OR REPLACE FUNCTION bgc.friend_code_reset(email text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE me bigint := bgc.member_id(email); c text := bgc.new_friend_code();
BEGIN
  IF me IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 401, 'message', 'Sign in to do that'); END IF;
  UPDATE members SET friend_code = c, updated_at = now() WHERE id = me;
  RETURN jsonb_build_object('ok', true, 'code', c);
END $$;

COMMIT;
