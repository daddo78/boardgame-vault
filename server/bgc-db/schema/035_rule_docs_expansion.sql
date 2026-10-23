-- A new kind of rules document: an expansion's own rulebook ("Expansion rulebook"), listed right after the rulebook.
-- These are the live definitions of every function that names the kinds, with 'expansion' added; nothing else changes.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 035_rule_docs_expansion.sql  (safe to re-run)
BEGIN;

ALTER TABLE rule_docs DROP CONSTRAINT IF EXISTS rule_docs_kind_check;
ALTER TABLE rule_docs ADD CONSTRAINT rule_docs_kind_check CHECK (kind IN ('rulebook', 'expansion', 'reference', 'appendix', 'faq', 'solo', 'other'));

CREATE OR REPLACE FUNCTION bgc.rule_doc_change(email text, doc bigint, action text, patch jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
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
      kind = CASE WHEN patch ->> 'kind' IN ('rulebook', 'expansion', 'reference', 'appendix', 'faq', 'solo', 'other') THEN patch ->> 'kind' ELSE kind END,
      title = CASE WHEN patch ? 'title' THEN left(btrim(coalesce(patch ->> 'title', '')), 120) ELSE title END,
      source_url = CASE WHEN patch ? 'source' THEN CASE WHEN patch ->> 'source' ~ '^https://[^\s]{4,}$' THEN left(patch ->> 'source', 500) END ELSE source_url END,
      updated_at = now()
    WHERE id = doc;
  END IF;
  RETURN bgc.rule_docs_of(email, bgg);
END $function$
;

CREATE OR REPLACE FUNCTION bgc.rule_doc_new(email text, bgg integer, gtitle text, kind text, title text, source text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE me bigint := bgc.member_id(email); g bigint; n int; lim jsonb := bgc.rule_limits(); d bigint;
BEGIN
  IF me IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 403, 'message', 'Members only'); END IF;
  SELECT count(*) INTO n FROM rule_docs WHERE uploaded_by = me AND created_at > now() - interval '1 day';
  IF n >= (lim ->> 'perDay')::int AND NOT bgc.is_admin(email) THEN
    RETURN jsonb_build_object('ok', false, 'status', 429, 'message', 'You''ve added ' || n || ' rulebooks today, the most for one day. Try again tomorrow!');
  END IF;
  SELECT id INTO g FROM games WHERE bgg_id = bgg;
  IF g IS NULL THEN
    INSERT INTO games (bgg_id, title) VALUES (bgg, coalesce(nullif(btrim(gtitle), ''), 'BGG #' || bgg)) ON CONFLICT (bgg_id) DO NOTHING;
    SELECT id INTO g FROM games WHERE bgg_id = bgg;
  END IF;
  INSERT INTO rule_docs (game_id, kind, title, source_url, uploaded_by)
  VALUES (g, CASE WHEN kind IN ('rulebook', 'expansion', 'reference', 'appendix', 'faq', 'solo', 'other') THEN kind ELSE 'rulebook' END,
    left(btrim(coalesce(title, '')), 120), CASE WHEN source ~ '^https://[^\s]{4,}$' THEN left(source, 500) END, me)
  RETURNING id INTO d;
  RETURN jsonb_build_object('ok', true, 'id', d);
END $function$
;

CREATE OR REPLACE FUNCTION bgc.rule_docs_all(email text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  SELECT CASE WHEN NOT bgc.is_admin(email) THEN '[]'::jsonb ELSE coalesce((
    SELECT jsonb_agg(bgc.rule_doc_json(d) || jsonb_build_object('game', g.title, 'bggId', g.bgg_id,
        'sections', (SELECT count(*) FROM rule_sections s WHERE s.doc_id = d.id))
      ORDER BY g.title, array_position(ARRAY['rulebook', 'expansion', 'reference', 'appendix', 'faq', 'solo', 'other'], d.kind), d.created_at)
    FROM rule_docs d JOIN games g ON g.id = d.game_id WHERE d.status <> 'uploading'), '[]') END $function$
;

CREATE OR REPLACE FUNCTION bgc.rule_docs_of(email text, bgg integer)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  WITH me AS (SELECT bgc.member_id(email) AS id, bgc.is_admin(email) AS admin),
  this AS (SELECT id FROM games WHERE bgg_id = bgg),
  src AS (SELECT coalesce(bgc.rule_game(this.id), this.id) AS gid, this.id AS own FROM this)
  SELECT CASE WHEN me.id IS NULL THEN jsonb_build_object('ok', false, 'status', 403, 'message', 'Members only') ELSE
    jsonb_build_object('ok', true, 'limits', bgc.rule_limits(),
      'from', (SELECT jsonb_build_object('bggId', g.bgg_id, 'title', g.title) FROM src, games g WHERE g.id = src.gid AND src.gid <> src.own),
      'docs', coalesce((SELECT jsonb_agg(bgc.rule_doc_json(d) || jsonb_build_object('mine', d.uploaded_by = me.id OR me.admin)
        ORDER BY array_position(ARRAY['rulebook', 'expansion', 'reference', 'appendix', 'faq', 'solo', 'other'], d.kind), d.created_at)
        FROM rule_docs d, src WHERE d.game_id IN (src.gid, src.own) AND d.status <> 'uploading'), '[]')) END
  FROM me LEFT JOIN src ON true $function$
;

CREATE OR REPLACE FUNCTION bgc.rule_kind_label(kind text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE kind WHEN 'expansion' THEN 'Expansion rulebook' WHEN 'reference' THEN 'Reference guide' WHEN 'appendix' THEN 'Appendix' WHEN 'faq' THEN 'FAQ' WHEN 'solo' THEN 'Solo rules'
    WHEN 'other' THEN 'Other' ELSE 'Rulebook' END $function$
;

COMMIT;
