-- Wishlists (games you'd like, kept apart from your shelf) and profile pages (your Top 10 of all time, open to friends).
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 015_wishlist_profile.sql  (safe to re-run)
BEGIN;

ALTER TABLE members ADD COLUMN IF NOT EXISTS top_games jsonb NOT NULL DEFAULT '[]'; -- [{ bggId, title, cover }], best first, up to 10

CREATE TABLE IF NOT EXISTS wishlist (
  member_id bigint NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  game_id   bigint NOT NULL REFERENCES games(id),
  added_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, game_id));

-- A catalog row for a BGG game we may only know by name and box art so far (details fill in when it's added to a shelf)
CREATE OR REPLACE FUNCTION bgc.catalog_game(bgg integer, title text, cover text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE gid bigint;
BEGIN
  INSERT INTO games (bgg_id, title, cover_card) VALUES (bgg, coalesce(nullif(btrim(title), ''), 'BGG #' || bgg), nullif(cover, ''))
  ON CONFLICT (bgg_id) DO UPDATE SET cover_card = coalesce(games.cover_card, EXCLUDED.cover_card)
  RETURNING id INTO gid;
  RETURN gid;
END $$;

-- Who may see whose page: yourself, or a friend
CREATE OR REPLACE FUNCTION bgc.can_see(mid bigint, target bigint) RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT mid IS NOT NULL AND (mid = target OR bgc.are_friends(mid, target)) $$;

CREATE OR REPLACE FUNCTION bgc.wishlist_of(target bigint) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('bggId', g.bgg_id, 'title', g.title, 'cover', g.cover_card, 'year', g.year,
    'rating', g.bgg_rating, 'weight', g.weight, 'minPlayers', g.min_players, 'maxPlayers', g.max_players, 'addedAt', at.iso(w.added_at)))
    ORDER BY w.added_at DESC), '[]')
  FROM wishlist w JOIN games g ON g.id = w.game_id WHERE w.member_id = target $$;

-- target: null for your own, or a friend's member id
CREATE OR REPLACE FUNCTION bgc.wishlist(email text, target bigint) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE mid bigint := bgc.member_id(email); t bigint := coalesce(target, bgc.member_id(email));
BEGIN
  IF NOT bgc.can_see(mid, t) THEN RETURN jsonb_build_object('ok', false, 'status', 403, 'message', 'You can see a wishlist once you’re friends'); END IF;
  RETURN jsonb_build_object('ok', true, 'items', bgc.wishlist_of(t));
END $$;

-- action: add | remove
CREATE OR REPLACE FUNCTION bgc.wish_change(email text, action text, bgg integer, title text, cover text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE mid bigint := bgc.member_id(email); gid bigint;
BEGIN
  IF mid IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 401, 'message', 'Sign in to do that'); END IF;
  IF bgg IS NULL OR bgg <= 0 THEN RETURN jsonb_build_object('ok', false, 'status', 400, 'message', 'Pick a game from BoardGameGeek'); END IF;
  IF action = 'remove' THEN
    DELETE FROM wishlist w USING games g WHERE w.member_id = mid AND w.game_id = g.id AND g.bgg_id = bgg;
  ELSE
    gid := bgc.catalog_game(bgg, title, cover);
    INSERT INTO wishlist (member_id, game_id) VALUES (mid, gid) ON CONFLICT DO NOTHING;
  END IF;
  RETURN jsonb_build_object('ok', true, 'items', bgc.wishlist_of(mid));
END $$;

-- A profile page: yourself or a friend. Their own words, Top 10, wishlist and a few numbers from their shelf.
CREATE OR REPLACE FUNCTION bgc.profile_page(email text, target bigint) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE mid bigint := bgc.member_id(email); t bigint := coalesce(target, bgc.member_id(email)); m members;
BEGIN
  IF NOT bgc.can_see(mid, t) THEN RETURN jsonb_build_object('ok', false, 'status', 403, 'message', 'You can see a profile once you’re friends'); END IF;
  SELECT * INTO m FROM members WHERE id = t;
  RETURN jsonb_build_object('ok', true, 'id', m.id, 'self', t = mid, 'name', m.display_name, 'about', m.about, 'likes', m.likes, 'dislikes', m.dislikes,
    'dials', jsonb_strip_nulls(jsonb_build_object('complexity', m.complexity, 'conflict', m.conflict, 'luck', m.luck, 'tableTalk', m.table_talk, 'theme', m.theme)),
    'topGames', m.top_games, 'wishlist', bgc.wishlist_of(t),
    'stats', jsonb_build_object(
      'games', (SELECT count(*) FROM shelves WHERE member_id = t),
      'plays', (SELECT coalesce(sum(play_count), 0) FROM shelves WHERE member_id = t),
      'mostPlayed', (SELECT coalesce(jsonb_agg(x ORDER BY (x ->> 'plays')::int DESC), '[]') FROM (
        SELECT jsonb_build_object('title', g.title, 'plays', s.play_count, 'cover', g.cover_card) AS x FROM shelves s JOIN games g ON g.id = s.game_id
        WHERE s.member_id = t AND s.play_count > 0 ORDER BY s.play_count DESC LIMIT 5) q),
      'friendsSince', (SELECT at.iso(f.accepted_at) FROM friendships f WHERE f.status = 'accepted'
        AND ((f.requester_id = mid AND f.addressee_id = t) OR (f.requester_id = t AND f.addressee_id = mid)))));
END $$;

-- Profiles carry the Top 10 now
CREATE OR REPLACE FUNCTION bgc.my_profile(email text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('name', m.display_name, 'bggUsername', m.bgg_username, 'age', m.age,
    'complexity', m.complexity, 'conflict', m.conflict, 'luck', m.luck, 'tableTalk', m.table_talk, 'theme', m.theme,
    'likes', m.likes, 'dislikes', m.dislikes, 'notes', m.about, 'topGames', m.top_games)
  FROM members m WHERE m.google_email = email $$;

CREATE OR REPLACE FUNCTION bgc.save_profile(email text, p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  UPDATE members SET
    bgg_username = nullif(p ->> 'bggUsername', ''), age = (p ->> 'age')::smallint,
    complexity = (p ->> 'complexity')::smallint, conflict = (p ->> 'conflict')::smallint, luck = (p ->> 'luck')::smallint,
    table_talk = (p ->> 'tableTalk')::smallint, theme = (p ->> 'theme')::smallint,
    likes = coalesce(p ->> 'likes', ''), dislikes = coalesce(p ->> 'dislikes', ''), about = coalesce(p ->> 'notes', ''),
    top_games = CASE WHEN jsonb_typeof(p -> 'topGames') = 'array' THEN p -> 'topGames' ELSE top_games END, updated_at = now()
  WHERE google_email = email;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'status', 401, 'message', 'Sign in to do that'); END IF;
  RETURN jsonb_build_object('ok', true, 'profile', bgc.my_profile(email));
END $$;

-- Buy ideas skip what's already on your wishlist (Nathan mentions those separately)
CREATE OR REPLACE FUNCTION bgc.buy_pool(email text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH me AS (SELECT bgc.member_id(email) AS id)
  SELECT coalesce(jsonb_agg((bgc.game_facts(g) - 'description') || jsonb_build_object('friends', bgc.friends_owning(me.id, g.id))), '[]')
  FROM me, games g
  WHERE g.bgg_id IS NOT NULL AND g.enriched_at IS NOT NULL AND g.min_players IS NOT NULL AND g.bgg_rank IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM shelves s WHERE s.member_id = me.id AND s.game_id = g.id)
    AND NOT EXISTS (SELECT 1 FROM wishlist w WHERE w.member_id = me.id AND w.game_id = g.id) $$;

-- What Nathan knows about the asker beyond their shelf: Top 10 and wishlist titles
CREATE OR REPLACE FUNCTION bgc.asker_extras(email text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('top', (SELECT coalesce(jsonb_agg(x ->> 'title'), '[]') FROM jsonb_array_elements(m.top_games) x),
    'wishlist', (SELECT coalesce(jsonb_agg(g.title ORDER BY w.added_at DESC), '[]') FROM wishlist w JOIN games g ON g.id = w.game_id WHERE w.member_id = m.id))
  FROM members m WHERE m.google_email = email $$;

COMMIT;
