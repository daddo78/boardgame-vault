-- Rulebooks: a member uploads a game's rulebook PDF once and every member can open it; Nathan answers rules questions from its text.
-- One rulebook per game (a newer upload replaces it). Rulebooks are for the members' own use.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 018_rulebooks.sql  (safe to re-run)
BEGIN;

CREATE TABLE IF NOT EXISTS rulebooks (
  game_id     bigint PRIMARY KEY REFERENCES games(id),
  filename    text NOT NULL,
  size_bytes  int NOT NULL,
  pages       int,
  pdf         bytea NOT NULL,
  text        text NOT NULL DEFAULT '',
  uploaded_by bigint REFERENCES members(id) ON DELETE SET NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now());

CREATE OR REPLACE FUNCTION bgc.rulebook_save(email text, bgg integer, title text, filename text, b64 text, txt text, pages int) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE mid bigint := bgc.member_id(email); gid bigint; raw bytea;
BEGIN
  IF mid IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 401, 'message', 'Sign in to do that'); END IF;
  raw := decode(b64, 'base64');
  IF substring(raw from 1 for 4) <> '\x25504446'::bytea THEN RETURN jsonb_build_object('ok', false, 'status', 400, 'message', 'That file isn’t a PDF'); END IF;
  gid := bgc.catalog_game(bgg, title, NULL);
  INSERT INTO rulebooks (game_id, filename, size_bytes, pages, pdf, text, uploaded_by)
  VALUES (gid, left(coalesce(nullif(filename, ''), 'rulebook.pdf'), 200), length(raw), pages, raw, coalesce(txt, ''), mid)
  ON CONFLICT (game_id) DO UPDATE SET filename = EXCLUDED.filename, size_bytes = EXCLUDED.size_bytes, pages = EXCLUDED.pages, pdf = EXCLUDED.pdf,
    text = EXCLUDED.text, uploaded_by = EXCLUDED.uploaded_by, uploaded_at = now();
  RETURN jsonb_build_object('ok', true, 'rulebook', bgc.rulebook_info(email, bgg));
END $$;

-- What a game's page shows: is there a rulebook, and who added it
CREATE OR REPLACE FUNCTION bgc.rulebook_info(email text, bgg integer) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN bgc.member_id(email) IS NULL THEN jsonb_build_object('ok', false, 'status', 401, 'message', 'Sign in to do that')
    ELSE coalesce((SELECT jsonb_build_object('ok', true, 'has', true, 'bggId', g.bgg_id, 'filename', r.filename, 'size', r.size_bytes, 'pages', r.pages,
      'readable', length(r.text) > 200, 'uploadedBy', split_part(m.display_name, ' ', 1), 'uploadedAt', at.iso(r.uploaded_at))
      FROM rulebooks r JOIN games g ON g.id = r.game_id LEFT JOIN members m ON m.id = r.uploaded_by WHERE g.bgg_id = bgg),
      jsonb_build_object('ok', true, 'has', false, 'bggId', bgg)) END $$;

CREATE OR REPLACE FUNCTION bgc.rulebook_file(email text, bgg integer) RETURNS TABLE (filename text, b64 text) LANGUAGE sql STABLE AS $$
  SELECT r.filename, encode(r.pdf, 'base64') FROM rulebooks r JOIN games g ON g.id = r.game_id
  WHERE g.bgg_id = bgg AND bgc.member_id(email) IS NOT NULL $$;

-- For Nathan: the rulebook text for the games he was asked about (matched like lookup_games)
CREATE OR REPLACE FUNCTION bgc.rulebooks_for(titles jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('asked', t, 'bggId', g.bgg_id, 'title', g.title, 'text', r.text, 'pages', r.pages)), '[]')
  FROM jsonb_array_elements_text(coalesce(titles, '[]')) t
  JOIN LATERAL (SELECT * FROM games x WHERE x.bgg_id IS NOT NULL
      AND (lower(x.title) = lower(t) OR regexp_replace(lower(x.title), '[^a-z0-9]+', '', 'g') = regexp_replace(lower(t), '[^a-z0-9]+', '', 'g'))
      AND EXISTS (SELECT 1 FROM rulebooks rb WHERE rb.game_id = x.id)
    ORDER BY x.bgg_rank NULLS LAST LIMIT 1) g ON true
  JOIN rulebooks r ON r.game_id = g.id $$;

COMMIT;
