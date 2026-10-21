-- Fill in catalog games that were never looked up on BoardGameGeek (they came in from logged plays): box art, players,
-- time, weight, ratings. A job asks for 20 at a time: wishlist and Top 10 games first, then games on shelves, then the rest.
-- A game BGG doesn't return is tried 3 times, then left alone.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 030_fill_catalog.sql  (safe to re-run)
BEGIN;

ALTER TABLE games ADD COLUMN IF NOT EXISTS fill_tries int NOT NULL DEFAULT 0;

-- The next games to look up (counts the try), as "id,id,id" for BGG's thing API
CREATE OR REPLACE FUNCTION bgc.catalog_to_fill(how_many int) RETURNS text LANGUAGE sql AS $$
  WITH pick AS (
    SELECT g.id FROM games g
    WHERE g.enriched_at IS NULL AND g.bgg_id IS NOT NULL AND g.fill_tries < 3
    ORDER BY EXISTS (SELECT 1 FROM wishlist w WHERE w.game_id = g.id) DESC,
      EXISTS (SELECT 1 FROM members m, jsonb_array_elements(CASE WHEN jsonb_typeof(m.top_games) = 'array' THEN m.top_games ELSE '[]' END) t
              WHERE (t ->> 'bggId') ~ '^\d+$' AND (t ->> 'bggId')::int = g.bgg_id) DESC,
      EXISTS (SELECT 1 FROM shelves s WHERE s.game_id = g.id) DESC,
      EXISTS (SELECT 1 FROM rule_docs d WHERE d.game_id = g.id) DESC,
      g.fill_tries, g.id
    LIMIT least(greatest(how_many, 1), 20)),
  bump AS (UPDATE games SET fill_tries = fill_tries + 1 FROM pick WHERE games.id = pick.id RETURNING games.bgg_id)
  SELECT string_agg(bgg_id::text, ',') FROM bump $$;

COMMIT;
