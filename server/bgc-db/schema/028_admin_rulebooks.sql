-- The admin portal's Rulebooks list: every document on the site, with its game, status and who added it (admins only)
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 028_admin_rulebooks.sql  (apply once via apply.sh)
BEGIN;

CREATE OR REPLACE FUNCTION bgc.rule_docs_all(email text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN NOT bgc.is_admin(email) THEN '[]'::jsonb ELSE coalesce((
    SELECT jsonb_agg(bgc.rule_doc_json(d) || jsonb_build_object('game', g.title, 'bggId', g.bgg_id,
        'sections', (SELECT count(*) FROM rule_sections s WHERE s.doc_id = d.id))
      ORDER BY g.title, array_position(ARRAY['rulebook', 'reference', 'appendix', 'faq', 'solo', 'other'], d.kind), d.created_at)
    FROM rule_docs d JOIN games g ON g.id = d.game_id WHERE d.status <> 'uploading'), '[]') END $$;

COMMIT;
