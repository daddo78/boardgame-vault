-- Dan's shelf becomes an ordinary shelf (2026-10-25). Until now his collection had its own write paths through the
-- Airtable adapter (at.request on the games and players tables: add, update, delete, the Players screen, play counts),
-- while members went through bgc.* functions. The API now sends everyone through bgc.shelf_add / shelf_update /
-- shelf_remove; what was left over moves here:
--   bgc.game_to_polish / bgc.polish_game   the blurb (genre, type, one-liner) and Tabler icon a new catalog game gets,
--                                          for any shelf now, filling only what's blank
--   bgc.players_admin / bgc.player_save    the owner's Players screen, with the admin check in the database
--   bgc.bgg_usernames / bgc.bgg_ratings_save  the nightly BGG ratings for everyone with a BGG username
-- The adapter's read side (at.game_record and friends: the page's wire format) stays for now.
-- Apply once: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 045_one_shelf.sql  (or bash apply.sh)
BEGIN;

-- What a game on the member's shelf still lacks (for the step after an add)
CREATE OR REPLACE FUNCTION bgc.game_to_polish(email text, skey text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN g.id IS NULL THEN jsonb_build_object('ok', false, 'status', 404, 'message', 'That game isn''t on your shelf') ELSE
    jsonb_build_object('ok', true, 'title', g.title, 'genre', g.genre, 'type', g.type, 'description', g.description, 'icon', g.icon,
      'bggId', g.bgg_id, 'hasCover', g.cover_card IS NOT NULL,
      'needsBlurb', g.genre = '' AND g.description = '', 'needsIcon', g.icon IN ('', 'meeple')) END
  FROM (SELECT 1) one
  LEFT JOIN shelves s ON s.member_id = bgc.member_id(email) AND s.legacy_id = skey
  LEFT JOIN games g ON g.id = s.game_id $$;

-- Fill the blanks: p = { genre?, type?, desc?, icon? }. Genre, type and the one-liner only where empty; the icon when given
-- (a Tabler name: letters, digits, dashes). The catalog is shared, so this never overwrites what another add wrote.
CREATE OR REPLACE FUNCTION bgc.polish_game(email text, skey text, p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE gid bigint; g games;
BEGIN
  SELECT s.game_id INTO gid FROM shelves s WHERE s.member_id = bgc.member_id(email) AND s.legacy_id = skey;
  IF gid IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 404, 'message', 'That game isn''t on your shelf'); END IF;
  UPDATE games SET
    genre       = CASE WHEN genre = '' THEN left(btrim(coalesce(p ->> 'genre', '')), 120) ELSE genre END,
    type        = CASE WHEN type = '' THEN left(btrim(coalesce(p ->> 'type', '')), 120) ELSE type END,
    description = CASE WHEN description = '' THEN left(btrim(coalesce(p ->> 'desc', '')), 700) ELSE description END,
    icon        = CASE WHEN p ->> 'icon' ~ '^[a-z0-9][a-z0-9-]{0,60}$' THEN p ->> 'icon' ELSE icon END,
    updated_at  = now()
  WHERE id = gid RETURNING * INTO g;
  RETURN jsonb_build_object('ok', true, 'genre', g.genre, 'type', g.type, 'description', g.description, 'icon', g.icon);
END $$;

-- The Players screen: the owner's people, as the page reads them (at.player_record), for admins
CREATE OR REPLACE FUNCTION bgc.players_admin(email text) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
  SELECT CASE WHEN NOT bgc.is_admin(email) THEN jsonb_build_object('ok', false, 'status', 403, 'message', 'Admins only') ELSE
    jsonb_build_object('ok', true, 'records', coalesce((SELECT jsonb_agg(at.player_record(p) ORDER BY p.active DESC, p.name) FROM players p WHERE p.owner_id = at.admin_id()), '[]')) END $$;

-- Save a card (pkey null or '' makes a new one); f carries the field ids the page sends (checked by the API first)
CREATE OR REPLACE FUNCTION bgc.player_save(email text, pkey text, f jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE p players;
BEGIN
  IF NOT bgc.is_admin(email) THEN RETURN jsonb_build_object('ok', false, 'status', 403, 'message', 'Admins only'); END IF;
  IF coalesce(pkey, '') = '' THEN p := at.create_player(f);
  ELSE
    BEGIN p := at.apply_player(pkey, f);
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM LIKE 'NOT_FOUND:%' THEN RETURN jsonb_build_object('ok', false, 'status', 404, 'message', 'That person isn''t in your list'); END IF;
      RAISE;
    END;
  END IF;
  RETURN jsonb_build_object('ok', true, 'record', at.player_record(p));
END $$;

-- Everyone whose BGG ratings the nightly sync fetches: player cards and members with a BGG username
CREATE OR REPLACE FUNCTION bgc.bgg_usernames() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(DISTINCT u ORDER BY u), '[]') FROM (
    SELECT lower(btrim(bgg_username)) AS u FROM players WHERE nullif(btrim(bgg_username), '') IS NOT NULL
    UNION SELECT lower(btrim(bgg_username)) FROM members WHERE nullif(btrim(bgg_username), '') IS NOT NULL) x $$;

-- Their ratings from BGG (out of 10), replacing what was fetched before: [{ bggId, rating10 }]
CREATE OR REPLACE FUNCTION bgc.bgg_ratings_save(username text, ratings jsonb) RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  INSERT INTO bgg_ratings (bgg_username, bgg_id, rating)
  SELECT lower(btrim(username)), (r ->> 'bggId')::int, least(10, greatest(1, (r ->> 'rating10')::numeric))
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ratings) = 'array' THEN ratings ELSE '[]' END) r
  WHERE (r ->> 'bggId') ~ '^\d+$' AND (r ->> 'rating10') ~ '^[0-9.]+$'
  ON CONFLICT (bgg_username, bgg_id) DO UPDATE SET rating = EXCLUDED.rating, fetched_at = now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

COMMIT;
