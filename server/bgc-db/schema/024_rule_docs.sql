-- Rulebooks Nathan has read: several documents per game (rulebook, reference guide, appendix, FAQ, solo rules),
-- each kept only as text Nathan wrote page by page, split into sections and searched with full-text search.
-- The PDF itself is never stored here: the page service holds it only while it's read, then deletes it.
-- People open the official copy from its source link. Replaces 018's single rulebook per game (none were uploaded).
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 024_rule_docs.sql  (safe to re-run)
BEGIN;

DROP FUNCTION IF EXISTS bgc.rulebook_save(text, integer, text, text, text, text, int);
DROP FUNCTION IF EXISTS bgc.rulebook_info(text, integer);
DROP FUNCTION IF EXISTS bgc.rulebook_file(text, integer);
DROP FUNCTION IF EXISTS bgc.rulebooks_for(jsonb);
DROP TABLE IF EXISTS rulebooks;

CREATE TABLE IF NOT EXISTS rule_docs (
  id          bigserial PRIMARY KEY,
  game_id     bigint NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'rulebook' CHECK (kind IN ('rulebook', 'reference', 'appendix', 'faq', 'solo', 'other')),
  title       text NOT NULL DEFAULT '',
  source_url  text,                        -- where the official PDF lives (publisher site, BGG file page)
  pages       int,
  pages_done  int NOT NULL DEFAULT 0,
  sha256      text,                        -- the file's fingerprint: the same PDF twice is one document
  status      text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'queued', 'reading', 'ready', 'error')),
  error       text,
  uploaded_by bigint REFERENCES members(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz);
CREATE UNIQUE INDEX IF NOT EXISTS rule_docs_same_file ON rule_docs (game_id, sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS rule_docs_game ON rule_docs (game_id);

-- What Nathan wrote for each page (Markdown), and the sections he searches
CREATE TABLE IF NOT EXISTS rule_pages (
  doc_id   bigint NOT NULL REFERENCES rule_docs(id) ON DELETE CASCADE,
  page     int NOT NULL,
  markdown text NOT NULL,
  from_pdf boolean NOT NULL DEFAULT false, -- the vision step failed, so this is the PDF's own text
  PRIMARY KEY (doc_id, page));
CREATE TABLE IF NOT EXISTS rule_sections (
  id      bigserial PRIMARY KEY,
  doc_id  bigint NOT NULL REFERENCES rule_docs(id) ON DELETE CASCADE,
  page    int NOT NULL,
  heading text NOT NULL DEFAULT '',
  body    text NOT NULL,
  tsv     tsvector GENERATED ALWAYS AS (setweight(to_tsvector('english', heading), 'A') || setweight(to_tsvector('english', body), 'B')) STORED);
CREATE INDEX IF NOT EXISTS rule_sections_tsv ON rule_sections USING gin (tsv);
CREATE INDEX IF NOT EXISTS rule_sections_doc ON rule_sections (doc_id, page);

-- The admin dashboard still counts "rulebooks": the documents that are ready
CREATE OR REPLACE VIEW rulebooks AS SELECT id, game_id FROM rule_docs WHERE status = 'ready';

-- Limits that keep the reading bill small (about a third of a cent a page)
CREATE OR REPLACE FUNCTION bgc.rule_limits() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$ SELECT '{"pages": 60, "perDay": 5, "mb": 60}'::jsonb $$;

CREATE OR REPLACE FUNCTION bgc.rule_kind_label(kind text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE kind WHEN 'reference' THEN 'Reference guide' WHEN 'appendix' THEN 'Appendix' WHEN 'faq' THEN 'FAQ' WHEN 'solo' THEN 'Solo rules'
    WHEN 'other' THEN 'Other' ELSE 'Rulebook' END $$;

-- A document as the page shows it
CREATE OR REPLACE FUNCTION bgc.rule_doc_json(d rule_docs) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('id', d.id, 'kind', d.kind, 'label', bgc.rule_kind_label(d.kind), 'title', nullif(d.title, ''),
    'source', d.source_url, 'pages', d.pages, 'pagesDone', d.pages_done, 'status', d.status, 'error', d.error,
    'uploadedBy', (SELECT split_part(m.display_name, ' ', 1) FROM members m WHERE m.id = d.uploaded_by), 'uploaderId', d.uploaded_by,
    'added', at.iso(d.created_at))) $$;

-- 1. Upload starts: checks the daily limit and makes the document (status "uploading")
CREATE OR REPLACE FUNCTION bgc.rule_doc_new(email text, bgg integer, gtitle text, kind text, title text, source text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE me bigint := bgc.member_id(email); g bigint; n int; lim jsonb := bgc.rule_limits(); d bigint;
BEGIN
  IF me IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 403, 'message', 'Members only'); END IF;
  SELECT count(*) INTO n FROM rule_docs WHERE uploaded_by = me AND created_at > now() - interval '1 day';
  IF n >= (lim ->> 'perDay')::int THEN
    RETURN jsonb_build_object('ok', false, 'status', 429, 'message', 'You''ve added ' || n || ' rulebooks today, the most for one day. Try again tomorrow!');
  END IF;
  SELECT id INTO g FROM games WHERE bgg_id = bgg;
  IF g IS NULL THEN
    INSERT INTO games (bgg_id, title) VALUES (bgg, coalesce(nullif(btrim(gtitle), ''), 'BGG #' || bgg)) ON CONFLICT (bgg_id) DO NOTHING;
    SELECT id INTO g FROM games WHERE bgg_id = bgg;
  END IF;
  INSERT INTO rule_docs (game_id, kind, title, source_url, uploaded_by)
  VALUES (g, CASE WHEN kind IN ('rulebook', 'reference', 'appendix', 'faq', 'solo', 'other') THEN kind ELSE 'rulebook' END,
    left(btrim(coalesce(title, '')), 120), CASE WHEN source ~ '^https://[^\s]{4,}$' THEN left(source, 500) END, me)
  RETURNING id INTO d;
  RETURN jsonb_build_object('ok', true, 'id', d);
END $$;

-- 2. The page service has the file: check its length and whether it's already here, then queue it for reading
CREATE OR REPLACE FUNCTION bgc.rule_doc_stored(doc bigint, npages int, sha text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE d rule_docs; dup rule_docs; lim jsonb := bgc.rule_limits();
BEGIN
  SELECT * INTO d FROM rule_docs WHERE id = doc;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'status', 404, 'message', 'That upload went missing. Try again.'); END IF;
  IF npages IS NULL OR npages < 1 THEN
    DELETE FROM rule_docs WHERE id = doc;
    RETURN jsonb_build_object('ok', false, 'status', 400, 'message', 'That file isn''t a PDF we can read.');
  END IF;
  IF npages > (lim ->> 'pages')::int THEN
    DELETE FROM rule_docs WHERE id = doc;
    RETURN jsonb_build_object('ok', false, 'status', 413, 'message', 'That PDF has ' || npages || ' pages. Rulebooks can have up to ' || (lim ->> 'pages') || '.');
  END IF;
  SELECT * INTO dup FROM rule_docs WHERE game_id = d.game_id AND sha256 = sha AND id <> doc;
  IF FOUND THEN
    DELETE FROM rule_docs WHERE id = doc;
    RETURN jsonb_build_object('ok', false, 'status', 409, 'duplicate', true, 'message', 'That one''s already here' ||
      coalesce(' (uploaded by ' || (SELECT split_part(display_name, ' ', 1) FROM members WHERE id = dup.uploaded_by) || ')', '') || '.');
  END IF;
  UPDATE rule_docs SET pages = npages, sha256 = sha, status = 'queued', updated_at = now() WHERE id = doc;
  RETURN jsonb_build_object('ok', true, 'id', doc, 'pages', npages);
END $$;

-- An upload that failed before it was queued leaves nothing behind
CREATE OR REPLACE FUNCTION bgc.rule_doc_drop(doc bigint) RETURNS void LANGUAGE sql AS $$ DELETE FROM rule_docs WHERE id = doc AND status = 'uploading' $$;

-- 3. The reader takes the next queued document (or one whose reading stopped half way)
CREATE OR REPLACE FUNCTION bgc.rule_doc_claim() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE d rule_docs;
BEGIN
  SELECT * INTO d FROM rule_docs WHERE status = 'queued' OR (status = 'reading' AND updated_at < now() - interval '20 minutes')
  ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE rule_docs SET status = 'reading', updated_at = now() WHERE id = d.id;
  RETURN jsonb_build_object('id', d.id, 'pages', d.pages, 'label', bgc.rule_kind_label(d.kind), 'title', d.title,
    'game', (SELECT title FROM games WHERE id = d.game_id),
    'done', (SELECT coalesce(jsonb_agg(page), '[]') FROM rule_pages WHERE doc_id = d.id));
END $$;

-- 4. One page read: its Markdown and its sections [{heading, body}]
CREATE OR REPLACE FUNCTION bgc.rule_page_save(doc bigint, pg int, md text, from_pdf boolean, sections jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO rule_pages (doc_id, page, markdown, from_pdf) VALUES (doc, pg, coalesce(md, ''), coalesce(from_pdf, false))
  ON CONFLICT (doc_id, page) DO UPDATE SET markdown = EXCLUDED.markdown, from_pdf = EXCLUDED.from_pdf;
  DELETE FROM rule_sections WHERE doc_id = doc AND page = pg;
  INSERT INTO rule_sections (doc_id, page, heading, body)
  SELECT doc, pg, left(coalesce(s ->> 'heading', ''), 200), s ->> 'body'
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(sections) = 'array' THEN sections ELSE '[]' END) s
  WHERE length(btrim(coalesce(s ->> 'body', ''))) > 0;
  UPDATE rule_docs SET pages_done = (SELECT count(*) FROM rule_pages WHERE doc_id = doc), updated_at = now() WHERE id = doc;
  RETURN jsonb_build_object('ok', true);
END $$;

-- 5. Reading finished
CREATE OR REPLACE FUNCTION bgc.rule_doc_finish(doc bigint) RETURNS jsonb LANGUAGE sql AS $$
  UPDATE rule_docs SET status = CASE WHEN pages_done > 0 THEN 'ready' ELSE 'error' END,
    error = CASE WHEN pages_done > 0 THEN NULL ELSE 'Nathan couldn''t read any pages of this one.' END,
    read_at = now(), updated_at = now()
  WHERE id = doc RETURNING jsonb_build_object('ok', true, 'status', status, 'pages', pages_done) $$;

-- A game's documents (for its details), and which games have one ready (for the 📖 on every shelf)
CREATE OR REPLACE FUNCTION bgc.rule_docs_of(email text, bgg integer) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN bgc.member_id(email) IS NULL THEN jsonb_build_object('ok', false, 'status', 403, 'message', 'Members only') ELSE
    jsonb_build_object('ok', true, 'limits', bgc.rule_limits(), 'docs', coalesce((SELECT jsonb_agg(bgc.rule_doc_json(d) ORDER BY
      array_position(ARRAY['rulebook', 'reference', 'appendix', 'faq', 'solo', 'other'], d.kind), d.created_at)
      FROM rule_docs d JOIN games g ON g.id = d.game_id WHERE g.bgg_id = bgg AND d.status <> 'uploading'), '[]')) END $$;
CREATE OR REPLACE FUNCTION bgc.rule_doc_games() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(DISTINCT g.bgg_id), '[]') FROM rule_docs d JOIN games g ON g.id = d.game_id WHERE d.status = 'ready' $$;

-- Change or remove a document: the person who added it, or an admin
CREATE OR REPLACE FUNCTION bgc.rule_doc_change(email text, doc bigint, action text, patch jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE me bigint := bgc.member_id(email); d rule_docs; bgg int;
BEGIN
  SELECT * INTO d FROM rule_docs WHERE id = doc;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'status', 404, 'message', 'That document is gone.'); END IF;
  IF me IS NULL OR NOT (d.uploaded_by = me OR bgc.is_admin(email)) THEN
    RETURN jsonb_build_object('ok', false, 'status', 403, 'message', 'Only the person who added it, or an admin, can change it.');
  END IF;
  SELECT bgg_id INTO bgg FROM games WHERE id = d.game_id;
  IF action = 'remove' THEN
    DELETE FROM rule_docs WHERE id = doc;
  ELSE
    UPDATE rule_docs SET
      kind = CASE WHEN patch ->> 'kind' IN ('rulebook', 'reference', 'appendix', 'faq', 'solo', 'other') THEN patch ->> 'kind' ELSE kind END,
      title = CASE WHEN patch ? 'title' THEN left(btrim(coalesce(patch ->> 'title', '')), 120) ELSE title END,
      source_url = CASE WHEN patch ? 'source' THEN CASE WHEN patch ->> 'source' ~ '^https://[^\s]{4,}$' THEN left(patch ->> 'source', 500) END ELSE source_url END,
      updated_at = now()
    WHERE id = doc;
  END IF;
  RETURN bgc.rule_docs_of(email, bgg);
END $$;

-- Nathan: the sections of these games' documents that best match the question's words
-- [{asked, bggId, title, docs: [...], sections: [{doc, kind, label, page, heading, body, source}]}]
CREATE OR REPLACE FUNCTION bgc.rule_search(titles jsonb, terms text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH q AS (SELECT CASE WHEN w = '' THEN NULL ELSE to_tsquery('english', w) END AS tsq
    FROM (SELECT coalesce(string_agg(DISTINCT lex, ' | '), '') AS w FROM unnest(tsvector_to_array(to_tsvector('english', coalesce(terms, '')))) lex) x),
  asked AS (SELECT t, bgc.match_game(t) AS gid FROM jsonb_array_elements_text(coalesce(titles, '[]')) t),
  found AS (SELECT DISTINCT ON (a.gid) a.t, a.gid FROM asked a WHERE a.gid IS NOT NULL AND EXISTS (SELECT 1 FROM rule_docs d WHERE d.game_id = a.gid AND d.status = 'ready'))
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
