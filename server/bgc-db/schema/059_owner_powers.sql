-- Owner-only powers, and covers from BGG only (review, Nov 16).
--   * Any admin could remove any member (which deletes everything of theirs), make others admins, and change everyone's
--     daily question limit. Those are now the owner's alone (at.admin_id(), Dan); other admins keep inviting, resetting
--     someone's questions, the Players screen and the rest of Admin. Invites are limited to 20 new members a day.
--   * A game new to the shared catalog took its cover from whatever URL the page sent (logging a play, a wishlist add),
--     so a member could give every member a tracking image. bgc.catalog_game now keeps a cover only from BGG's image
--     host; Fill Catalog adds the real art (and BGG's title) within minutes.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 059_owner_powers.sql  (or bash apply.sh)
BEGIN;

-- 015's catalog_game, keeping a cover only from cf.geekdo-images.com
CREATE OR REPLACE FUNCTION bgc.catalog_game(bgg integer, title text, cover text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE gid bigint; art text := CASE WHEN cover ~ '^https://cf\.geekdo-images\.com/[^\s"''<>]+$' THEN cover END;
BEGIN
  INSERT INTO games (bgg_id, title, cover_card) VALUES (bgg, coalesce(nullif(left(btrim(title), 200), ''), 'BGG #' || bgg), art)
  ON CONFLICT (bgg_id) DO UPDATE SET cover_card = coalesce(games.cover_card, EXCLUDED.cover_card)
  RETURNING id INTO gid;
  RETURN gid;
END $$;

-- 017's admin_action: removing members, admin rights and the question limit are the owner's
CREATE OR REPLACE FUNCTION bgc.admin_action(email text, action text, target bigint, v jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE me bigint := bgc.member_id(email); is_owner boolean := bgc.member_id(email) = at.admin_id(); t members; addr text; nm text; lim int;
BEGIN
  IF NOT bgc.is_admin(email) THEN RETURN jsonb_build_object('ok', false, 'status', 403, 'message', 'Admins only'); END IF;
  IF action = 'invite' THEN
    addr := lower(btrim(coalesce(v ->> 'email', ''))); nm := btrim(coalesce(v ->> 'name', ''));
    IF addr !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN RETURN jsonb_build_object('ok', false, 'status', 400, 'message', 'That email doesn’t look right'); END IF;
    IF nm = '' THEN RETURN jsonb_build_object('ok', false, 'status', 400, 'message', 'Add their name'); END IF;
    IF EXISTS (SELECT 1 FROM members WHERE google_email = addr) THEN RETURN jsonb_build_object('ok', false, 'status', 409, 'message', addr || ' is already a member'); END IF;
    IF (SELECT count(*) FROM members WHERE created_at > now() - interval '1 day') >= 20 THEN
      RETURN jsonb_build_object('ok', false, 'status', 429, 'message', 'That''s 20 new members today. Invite more tomorrow.');
    END IF;
    INSERT INTO members (google_email, display_name) VALUES (addr, nm);
    RETURN jsonb_build_object('ok', true, 'message', nm || ' can sign in now with ' || addr);
  ELSIF action = 'askLimit' THEN
    IF NOT is_owner THEN RETURN jsonb_build_object('ok', false, 'status', 403, 'message', 'Only Dan can change the daily question limit'); END IF;
    lim := (v ->> 'value')::int;
    IF lim IS NULL OR lim < 1 OR lim > 500 THEN RETURN jsonb_build_object('ok', false, 'status', 400, 'message', 'Pick a limit from 1 to 500'); END IF;
    INSERT INTO settings (key, value, updated_at) VALUES ('ask_per_member', to_jsonb(lim), now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
    RETURN jsonb_build_object('ok', true, 'message', 'Everyone now gets ' || lim || ' questions a day');
  END IF;
  SELECT * INTO t FROM members WHERE id = target;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'status', 404, 'message', 'No such member'); END IF;
  IF action = 'remove' THEN
    IF NOT is_owner THEN RETURN jsonb_build_object('ok', false, 'status', 403, 'message', 'Only Dan can remove members'); END IF;
    IF t.id = me THEN RETURN jsonb_build_object('ok', false, 'status', 400, 'message', 'You can’t remove yourself'); END IF;
    IF t.id = at.admin_id() THEN RETURN jsonb_build_object('ok', false, 'status', 400, 'message', 'Dan’s account can’t be removed'); END IF;
    DELETE FROM ratings WHERE member_id = t.id;
    DELETE FROM ask_usage WHERE member_id = t.id;
    DELETE FROM members WHERE id = t.id; -- their shelf, plays, people, friendships, wishlist and visits go with them
    RETURN jsonb_build_object('ok', true, 'message', t.display_name || ' was removed');
  ELSIF action = 'admin' THEN
    IF NOT is_owner THEN RETURN jsonb_build_object('ok', false, 'status', 403, 'message', 'Only Dan can change who is an admin'); END IF;
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
