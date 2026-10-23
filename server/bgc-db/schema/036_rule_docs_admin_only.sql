-- Only admins change or remove rulebooks (Dan, Oct 23). Members still add them; the person who added one can no longer
-- edit or remove it. "mine" on a document now means "you may change it" (admins only), which is what shows the buttons.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 036_rule_docs_admin_only.sql  (safe to re-run)
BEGIN;

CREATE OR REPLACE FUNCTION bgc.rule_doc_change(email text, doc bigint, action text, patch jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE me bigint := bgc.member_id(email); d rule_docs; bgg int;
BEGIN
  SELECT * INTO d FROM rule_docs WHERE id = doc;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'status', 404, 'message', 'That document is gone.'); END IF;
  IF NOT bgc.is_admin(email) THEN
    RETURN jsonb_build_object('ok', false, 'status', 403, 'message', 'Only an admin can change or remove a rulebook.');
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
      'docs', coalesce((SELECT jsonb_agg(bgc.rule_doc_json(d) || jsonb_build_object('mine', me.admin)
        ORDER BY array_position(ARRAY['rulebook', 'expansion', 'reference', 'appendix', 'faq', 'solo', 'other'], d.kind), d.created_at)
        FROM rule_docs d, src WHERE d.game_id IN (src.gid, src.own) AND d.status <> 'uploading'), '[]')) END
  FROM me LEFT JOIN src ON true $function$
;

COMMIT;
