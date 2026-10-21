-- A game's documents say which ones the asker may change (they added it, or they're an admin)
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 026_rule_docs_mine.sql  (safe to re-run)
BEGIN;

CREATE OR REPLACE FUNCTION bgc.rule_docs_of(email text, bgg integer) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH me AS (SELECT bgc.member_id(email) AS id, bgc.is_admin(email) AS admin)
  SELECT CASE WHEN me.id IS NULL THEN jsonb_build_object('ok', false, 'status', 403, 'message', 'Members only') ELSE
    jsonb_build_object('ok', true, 'limits', bgc.rule_limits(), 'docs', coalesce((SELECT jsonb_agg(bgc.rule_doc_json(d) || jsonb_build_object('mine', d.uploaded_by = me.id OR me.admin)
      ORDER BY array_position(ARRAY['rulebook', 'reference', 'appendix', 'faq', 'solo', 'other'], d.kind), d.created_at)
      FROM rule_docs d JOIN games g ON g.id = d.game_id WHERE g.bgg_id = bgg AND d.status <> 'uploading'), '[]')) END
  FROM me $$;

COMMIT;
