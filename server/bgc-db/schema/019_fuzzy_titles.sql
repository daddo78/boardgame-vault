-- Find a game when the name is partial or a little off ("Tanares Adventure" -> "Arena: The Contest – Tanares Adventures").
-- Exact title first; then a title that contains the words asked for; then the closest spelling (trigram similarity).
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 019_fuzzy_titles.sql  (apply once via apply.sh)
BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS games_title_trgm ON games USING gin (lower(title) gin_trgm_ops);

-- The best catalog match for a title someone typed (null if nothing is close)
CREATE OR REPLACE FUNCTION bgc.match_game(t text) RETURNS bigint LANGUAGE sql STABLE AS $$
  WITH q AS (SELECT lower(btrim(t)) AS s, regexp_replace(lower(t), '[^a-z0-9]+', '', 'g') AS k),
  c AS (SELECT x.id, x.bgg_rank,
          CASE WHEN lower(x.title) = q.s OR regexp_replace(lower(x.title), '[^a-z0-9]+', '', 'g') = q.k THEN 3
               WHEN length(q.k) >= 5 AND regexp_replace(lower(x.title), '[^a-z0-9]+', '', 'g') LIKE '%' || q.k || '%' THEN 2
               ELSE 1 END AS tier,
          greatest(similarity(lower(x.title), q.s), word_similarity(q.s, lower(x.title))) AS sim
        FROM games x, q
        WHERE x.bgg_id IS NOT NULL AND x.enriched_at IS NOT NULL
          AND (lower(x.title) = q.s OR regexp_replace(lower(x.title), '[^a-z0-9]+', '', 'g') LIKE '%' || q.k || '%' OR q.s <% lower(x.title)))
  SELECT id FROM c WHERE tier >= 2 OR sim >= 0.55
  ORDER BY tier DESC, sim DESC, bgg_rank NULLS LAST LIMIT 1 $$;

CREATE OR REPLACE FUNCTION bgc.lookup_games(email text, titles jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH me AS (SELECT bgc.member_id(email) AS id)
  SELECT coalesce(jsonb_agg(jsonb_build_object('asked', t,
    'game', CASE WHEN g.id IS NOT NULL THEN bgc.game_facts(g) END,
    'onShelf', EXISTS (SELECT 1 FROM shelves s WHERE s.member_id = me.id AND s.game_id = g.id),
    'onWishlist', EXISTS (SELECT 1 FROM wishlist w WHERE w.member_id = me.id AND w.game_id = g.id),
    'friends', CASE WHEN g.id IS NOT NULL THEN bgc.friends_owning(me.id, g.id) ELSE '[]'::jsonb END)), '[]')
  FROM me, jsonb_array_elements_text(coalesce(titles, '[]')) t
  LEFT JOIN games g ON g.id = bgc.match_game(t) $$;

CREATE OR REPLACE FUNCTION bgc.rulebooks_for(titles jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('asked', t, 'bggId', g.bgg_id, 'title', g.title, 'text', r.text, 'pages', r.pages)), '[]')
  FROM jsonb_array_elements_text(coalesce(titles, '[]')) t
  JOIN rulebooks r ON r.game_id = coalesce(
    (SELECT x.id FROM games x JOIN rulebooks rb ON rb.game_id = x.id
      WHERE lower(x.title) = lower(t) OR regexp_replace(lower(x.title), '[^a-z0-9]+', '', 'g') LIKE '%' || regexp_replace(lower(t), '[^a-z0-9]+', '', 'g') || '%' LIMIT 1),
    bgc.match_game(t))
  JOIN games g ON g.id = r.game_id $$;

COMMIT;
