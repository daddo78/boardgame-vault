-- Nathan beyond the shelf: facts about any game (the shared catalog first; the workflow asks BGG for the rest),
-- and "what should I buy?" ideas from games you don't own. Who owns a game is only ever said for your friends.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 012_games_beyond_the_shelf.sql  (apply once via apply.sh)
BEGIN;

-- The BGG facts the catalog keeps, as plain JSON
CREATE OR REPLACE FUNCTION bgc.game_facts(g games) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('bggId', g.bgg_id, 'title', g.title, 'year', g.year,
    'minPlayers', g.min_players, 'maxPlayers', g.max_players, 'bestPlayers', to_jsonb(g.best_players),
    'minTime', g.min_time, 'maxTime', g.max_time, 'weight', g.weight, 'minAge', g.min_age, 'rating', g.bgg_rating, 'rank', g.bgg_rank,
    'designers', to_jsonb(g.designers), 'categories', to_jsonb(g.categories), 'mechanics', to_jsonb(g.mechanics),
    'description', nullif(left(g.description, 700), ''), 'cover', g.cover_card)) $$;

-- Which of your friends have this game on their shelf (first names)
CREATE OR REPLACE FUNCTION bgc.friends_owning(me bigint, gid bigint) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(split_part(m.display_name, ' ', 1) ORDER BY m.display_name), '[]')
  FROM shelves s JOIN members m ON m.id = s.member_id
  WHERE s.game_id = gid AND m.id <> me AND bgc.are_friends(me, m.id) $$;

-- titles: official titles Nathan was asked about. Each comes back with its catalog facts (or null: look it up on BGG),
-- whether it's on the asker's own shelf, and which friends own it.
CREATE OR REPLACE FUNCTION bgc.lookup_games(email text, titles jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH me AS (SELECT bgc.member_id(email) AS id)
  SELECT coalesce(jsonb_agg(jsonb_build_object('asked', t,
    'game', CASE WHEN g.id IS NOT NULL THEN bgc.game_facts(g) END,
    'onShelf', EXISTS (SELECT 1 FROM shelves s WHERE s.member_id = me.id AND s.game_id = g.id),
    'friends', CASE WHEN g.id IS NOT NULL THEN bgc.friends_owning(me.id, g.id) ELSE '[]'::jsonb END)), '[]')
  FROM me, jsonb_array_elements_text(coalesce(titles, '[]')) t
  LEFT JOIN LATERAL (SELECT * FROM games x WHERE x.bgg_id IS NOT NULL AND x.enriched_at IS NOT NULL
      AND (lower(x.title) = lower(t) OR regexp_replace(lower(x.title), '[^a-z0-9]+', '', 'g') = regexp_replace(lower(t), '[^a-z0-9]+', '', 'g'))
    ORDER BY x.bgg_rank NULLS LAST LIMIT 1) g ON true $$;

-- Ideas to buy: catalog games with full BGG details that aren't on the asker's shelf, with the friends who own each
CREATE OR REPLACE FUNCTION bgc.buy_pool(email text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH me AS (SELECT bgc.member_id(email) AS id)
  SELECT coalesce(jsonb_agg((bgc.game_facts(g) - 'description') || jsonb_build_object('friends', bgc.friends_owning(me.id, g.id))), '[]')
  FROM me, games g
  WHERE g.bgg_id IS NOT NULL AND g.enriched_at IS NOT NULL AND g.min_players IS NOT NULL AND g.bgg_rank IS NOT NULL  -- ranked base games (no expansions)
    AND NOT EXISTS (SELECT 1 FROM shelves s WHERE s.member_id = me.id AND s.game_id = g.id) $$;

COMMIT;
