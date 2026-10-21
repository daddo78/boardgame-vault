-- Reading rulebooks, more carefully: one document at a time, a page is only saved once Nathan has really seen it,
-- and a document with unread pages goes back in the queue (up to 3 tries) instead of being called ready.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 025_rule_reading_retries.sql  (safe to re-run)
BEGIN;

ALTER TABLE rule_docs ADD COLUMN IF NOT EXISTS tries int NOT NULL DEFAULT 0;

-- The next document to read, unless another one is being read right now (or one whose reading stopped half way)
CREATE OR REPLACE FUNCTION bgc.rule_doc_claim() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE d rule_docs;
BEGIN
  IF EXISTS (SELECT 1 FROM rule_docs WHERE status = 'reading' AND updated_at > now() - interval '10 minutes') THEN RETURN NULL; END IF;
  SELECT * INTO d FROM rule_docs WHERE status = 'queued' OR status = 'reading'
  ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- Three passes that couldn't even save a page: give up on it (the next claim moves on)
  IF d.tries >= 3 THEN
    PERFORM bgc.rule_doc_finish(d.id);
    RETURN NULL;
  END IF;
  UPDATE rule_docs SET status = 'reading', tries = tries + 1, updated_at = now() WHERE id = d.id;
  RETURN jsonb_build_object('id', d.id, 'pages', d.pages, 'label', bgc.rule_kind_label(d.kind), 'title', d.title,
    'game', (SELECT title FROM games WHERE id = d.game_id),
    'done', (SELECT coalesce(jsonb_agg(page), '[]') FROM rule_pages WHERE doc_id = d.id));
END $$;

-- A pass finished: every page read -> ready; pages missing -> back in the queue, or after 3 tries ready with what was read
CREATE OR REPLACE FUNCTION bgc.rule_doc_finish(doc bigint) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE d rule_docs; missing text;
BEGIN
  SELECT * INTO d FROM rule_docs WHERE id = doc;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false); END IF;
  SELECT string_agg(p::text, ', ' ORDER BY p) INTO missing FROM generate_series(1, d.pages) p
  WHERE NOT EXISTS (SELECT 1 FROM rule_pages r WHERE r.doc_id = doc AND r.page = p);
  IF missing IS NULL THEN
    UPDATE rule_docs SET status = 'ready', error = NULL, read_at = now(), updated_at = now() WHERE id = doc;
  ELSIF d.tries < 3 THEN
    UPDATE rule_docs SET status = 'queued', updated_at = now() WHERE id = doc;
  ELSE
    UPDATE rule_docs SET status = CASE WHEN d.pages_done > 0 THEN 'ready' ELSE 'error' END,
      error = 'Nathan couldn''t read page' || CASE WHEN missing LIKE '%,%' THEN 's ' ELSE ' ' END || missing || '.', read_at = now(), updated_at = now() WHERE id = doc;
  END IF;
  SELECT * INTO d FROM rule_docs WHERE id = doc;
  RETURN jsonb_build_object('ok', true, 'status', d.status, 'pages', d.pages_done, 'missing', missing);
END $$;

COMMIT;
