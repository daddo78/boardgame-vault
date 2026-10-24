-- Name matching looks at every catalog game, including ones not yet filled in from BoardGameGeek.
-- If the best match hasn't been filled in, it returns nothing, so Nathan looks the game up on BGG
-- instead of settling for the next-closest title ("Horror on the Orient Express" found "Dead Man on the Orient Express").
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 022_match_unfilled.sql  (apply once via apply.sh)
BEGIN;

CREATE OR REPLACE FUNCTION bgc.match_game(t text) RETURNS bigint LANGUAGE sql STABLE AS $$
  WITH q AS (SELECT lower(btrim(t)) AS s, regexp_replace(lower(t), '[^a-z0-9]+', '', 'g') AS k),
  c AS (SELECT x.id, x.bgg_rank, x.enriched_at,
          CASE WHEN lower(x.title) = q.s OR regexp_replace(lower(x.title), '[^a-z0-9]+', '', 'g') = q.k THEN 3
               WHEN length(q.k) >= 5 AND regexp_replace(lower(x.title), '[^a-z0-9]+', '', 'g') LIKE '%' || q.k || '%' THEN 2
               ELSE 1 END AS tier,
          greatest(similarity(lower(x.title), q.s), word_similarity(q.s, lower(x.title))) AS sim
        FROM games x, q
        WHERE x.bgg_id IS NOT NULL
          AND (lower(x.title) = q.s OR regexp_replace(lower(x.title), '[^a-z0-9]+', '', 'g') LIKE '%' || q.k || '%' OR q.s <% lower(x.title))),
  best AS (SELECT id, enriched_at FROM c WHERE tier >= 2 OR sim >= 0.55
    ORDER BY tier DESC, sim DESC, enriched_at IS NULL, bgg_rank NULLS LAST LIMIT 1)
  SELECT id FROM best WHERE enriched_at IS NOT NULL $$;

COMMIT;
