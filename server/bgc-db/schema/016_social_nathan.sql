-- Social Nathan: "what can we play at Keith's?" and questions across all your friends' shelves ("who has a co-op for 6?").
-- Only ever your friends; their give-away lists stay private.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 016_social_nathan.sql  (safe to re-run)
BEGIN;

-- A friend by first or full name (null if no friend has that name)
CREATE OR REPLACE FUNCTION bgc.friend_by_name(email text, nm text) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT m.id FROM members m
  WHERE nullif(btrim(nm), '') IS NOT NULL AND m.id <> bgc.member_id(email) AND bgc.are_friends(bgc.member_id(email), m.id)
    AND (lower(m.display_name) = lower(btrim(nm)) OR lower(split_part(m.display_name, ' ', 1)) = lower(split_part(btrim(nm), ' ', 1)))
  ORDER BY (lower(m.display_name) = lower(btrim(nm))) DESC, m.id LIMIT 1 $$;

-- Every game on your friends' shelves (base games with BGG details), with which friends own it and whether you do too
CREATE OR REPLACE FUNCTION bgc.friends_pool(email text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH me AS (SELECT bgc.member_id(email) AS id),
  fr AS (SELECT m.id, split_part(m.display_name, ' ', 1) AS first FROM members m, me WHERE m.id <> me.id AND bgc.are_friends(me.id, m.id)),
  owned AS (SELECT s.game_id, jsonb_agg(DISTINCT fr.first) AS owners, sum(s.play_count)::int AS plays
            FROM shelves s JOIN fr ON fr.id = s.member_id GROUP BY s.game_id)
  SELECT coalesce(jsonb_agg((bgc.game_facts(g) - 'description') || jsonb_build_object('owners', o.owners, 'ownerPlays', o.plays,
    'mine', EXISTS (SELECT 1 FROM shelves s, me WHERE s.member_id = me.id AND s.game_id = g.id))), '[]')
  FROM owned o JOIN games g ON g.id = o.game_id
  WHERE g.bgg_id IS NOT NULL AND g.min_players IS NOT NULL $$;

COMMIT;
