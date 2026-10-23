-- Each person's play history, about 3x faster. A play counts toward a shelf game when its BGG id is the game's own or one
-- of its other editions (extra_bgg_ids). That was one join condition with an OR, so every play was compared with every
-- game on the shelf; now each game's ids are unpacked first and a play matches by plain equality.
-- Same answers: checked against the old version for all 414 people (294 with plays), no differences.
-- People on Dan's shelf: 336 -> 230 ms; on a friend's 844-game shelf with 248 people: 3.7 -> 1.4 s. Nathan reads the same view.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 038_faster_play_history.sql  (safe to re-run)
BEGIN;

CREATE OR REPLACE FUNCTION at.player_history(pid bigint) RETURNS jsonb LANGUAGE sql AS $$
  SELECT coalesce(jsonb_object_agg(own_bgg::text, jsonb_build_object('plays', plays, 'wins', wins, 'last', last)), '{}'::jsonb)
  FROM (
    SELECT o.own_bgg, sum(p.quantity)::int AS plays, coalesce(sum(p.quantity) FILTER (WHERE pp.win), 0)::int AS wins, max(p.played_on) AS last
    FROM play_players pp
    JOIN plays p ON p.id = pp.play_id
    JOIN players pl ON pl.id = pp.player_id
    JOIN LATERAL (
      SELECT DISTINCT s.game_id, g.bgg_id AS own_bgg, b AS play_bgg
      FROM shelves s JOIN games g ON g.id = s.game_id AND g.bgg_id IS NOT NULL,
        unnest(ARRAY[g.bgg_id] || s.extra_bgg_ids) b
      WHERE s.member_id = pl.owner_id
    ) o ON o.play_bgg = p.bgg_id
    WHERE pp.player_id = pid
    GROUP BY o.own_bgg) h $$;

COMMIT;
