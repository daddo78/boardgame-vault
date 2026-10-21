-- Rulebooks apply to a game's other editions and expansions too: "Andromeda's Edge: Deluxe Edition" uses
-- Andromeda's Edge's documents, for Nathan and for the 📖 on shelves. Whether anyone owns the game doesn't matter.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 027_rule_docs_editions.sql  (safe to re-run)
BEGIN;

-- The game whose documents this game uses: its own, else the longest title it starts with ("X: Deluxe Edition", "X – Second Edition", "X (2024)")
CREATE OR REPLACE FUNCTION bgc.rule_game(gid bigint) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT gid WHERE EXISTS (SELECT 1 FROM rule_docs d WHERE d.game_id = gid AND d.status = 'ready')),
    (SELECT b.id FROM games g, games b
      WHERE g.id = gid AND b.id <> g.id AND EXISTS (SELECT 1 FROM rule_docs d WHERE d.game_id = b.id AND d.status = 'ready')
        AND (lower(g.title) LIKE lower(b.title) || ':%' OR lower(g.title) LIKE lower(b.title) || ' –%' OR lower(g.title) LIKE lower(b.title) || ' -%' OR lower(g.title) LIKE lower(b.title) || ' (%')
      ORDER BY length(b.title) DESC LIMIT 1)) $$;

-- Every game that has documents of its own or through its base game (the 📖 on shelves)
CREATE OR REPLACE FUNCTION bgc.rule_doc_games() RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH base AS (SELECT DISTINCT g.id, g.title, g.bgg_id FROM rule_docs d JOIN games g ON g.id = d.game_id WHERE d.status = 'ready')
  SELECT coalesce(jsonb_agg(DISTINCT x.bgg_id), '[]') FROM (
    SELECT bgg_id FROM base
    UNION SELECT g.bgg_id FROM games g, base b WHERE g.bgg_id IS NOT NULL AND g.id <> b.id
      AND (lower(g.title) LIKE lower(b.title) || ':%' OR lower(g.title) LIKE lower(b.title) || ' –%' OR lower(g.title) LIKE lower(b.title) || ' -%' OR lower(g.title) LIKE lower(b.title) || ' (%')) x $$;

-- A game's details list its base game's documents when it has none of its own (labelled with that game)
CREATE OR REPLACE FUNCTION bgc.rule_docs_of(email text, bgg integer) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH me AS (SELECT bgc.member_id(email) AS id, bgc.is_admin(email) AS admin),
  this AS (SELECT id FROM games WHERE bgg_id = bgg),
  src AS (SELECT coalesce(bgc.rule_game(this.id), this.id) AS gid, this.id AS own FROM this)
  SELECT CASE WHEN me.id IS NULL THEN jsonb_build_object('ok', false, 'status', 403, 'message', 'Members only') ELSE
    jsonb_build_object('ok', true, 'limits', bgc.rule_limits(),
      'from', (SELECT jsonb_build_object('bggId', g.bgg_id, 'title', g.title) FROM src, games g WHERE g.id = src.gid AND src.gid <> src.own),
      'docs', coalesce((SELECT jsonb_agg(bgc.rule_doc_json(d) || jsonb_build_object('mine', d.uploaded_by = me.id OR me.admin)
        ORDER BY array_position(ARRAY['rulebook', 'reference', 'appendix', 'faq', 'solo', 'other'], d.kind), d.created_at)
        FROM rule_docs d, src WHERE d.game_id IN (src.gid, src.own) AND d.status <> 'uploading'), '[]')) END
  FROM me LEFT JOIN src ON true $$;

-- Nathan: search the documents of the game asked about, or of its base game
CREATE OR REPLACE FUNCTION bgc.rule_search(titles jsonb, terms text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH q AS (SELECT CASE WHEN w = '' THEN NULL ELSE to_tsquery('english', w) END AS tsq
    FROM (SELECT coalesce(string_agg(DISTINCT lex, ' | '), '') AS w FROM unnest(tsvector_to_array(to_tsvector('english', coalesce(terms, '')))) lex) x),
  asked AS (SELECT t, bgc.rule_game(bgc.match_game(t)) AS gid FROM jsonb_array_elements_text(coalesce(titles, '[]')) t),
  found AS (SELECT DISTINCT ON (a.gid) a.t, a.gid FROM asked a WHERE a.gid IS NOT NULL)
  SELECT coalesce(jsonb_agg(jsonb_build_object('asked', f.t, 'bggId', g.bgg_id, 'title', g.title,
    'docs', (SELECT jsonb_agg(bgc.rule_doc_json(d) ORDER BY d.created_at) FROM rule_docs d WHERE d.game_id = g.id AND d.status = 'ready'),
    'sections', coalesce((SELECT jsonb_agg(jsonb_build_object('doc', s.doc_id, 'kind', s.kind, 'label', bgc.rule_kind_label(s.kind) || coalesce(' (' || nullif(s.dtitle, '') || ')', ''),
        'page', s.page, 'heading', s.heading, 'body', s.body, 'source', s.source_url) ORDER BY s.rank DESC)
      FROM (SELECT x.doc_id, d.kind, d.title AS dtitle, d.source_url, x.page, x.heading, x.body, ts_rank_cd(x.tsv, q.tsq, 32) AS rank
            FROM rule_sections x JOIN rule_docs d ON d.id = x.doc_id
            WHERE d.game_id = g.id AND d.status = 'ready' AND q.tsq IS NOT NULL AND x.tsv @@ q.tsq
            ORDER BY rank DESC LIMIT 8) s), '[]'))), '[]')
  FROM found f JOIN games g ON g.id = f.gid, q $$;

COMMIT;
