-- A BGG collection can list the same game twice (two copies, two versions), and the first ratings sync after 045 died on
-- "ON CONFLICT DO UPDATE command cannot affect row a second time". One row per game per call, then.
-- Apply once: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 046_bgg_ratings_dedupe.sql  (or bash apply.sh)
BEGIN;

CREATE OR REPLACE FUNCTION bgc.bgg_ratings_save(username text, ratings jsonb) RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  INSERT INTO bgg_ratings (bgg_username, bgg_id, rating)
  SELECT DISTINCT ON (bgg) lower(btrim(username)), bgg, least(10, greatest(1, rating10))
  FROM (SELECT (r ->> 'bggId')::int AS bgg, (r ->> 'rating10')::numeric AS rating10
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ratings) = 'array' THEN ratings ELSE '[]' END) r
        WHERE (r ->> 'bggId') ~ '^\d+$' AND (r ->> 'rating10') ~ '^[0-9.]+$') x
  ORDER BY bgg, rating10 DESC
  ON CONFLICT (bgg_username, bgg_id) DO UPDATE SET rating = EXCLUDED.rating, fetched_at = now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

COMMIT;
