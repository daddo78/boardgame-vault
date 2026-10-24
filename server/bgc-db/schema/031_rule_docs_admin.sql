-- Admins can add rulebooks from Admin → Rulebooks for any game, without the 5-a-day limit (the page cap still applies).
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 031_rule_docs_admin.sql  (apply once via apply.sh)
BEGIN;

CREATE OR REPLACE FUNCTION bgc.rule_doc_new(email text, bgg integer, gtitle text, kind text, title text, source text) RETURNS jsonb LANGUAGE plpgsql AS $$
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
  VALUES (g, CASE WHEN kind IN ('rulebook', 'reference', 'appendix', 'faq', 'solo', 'other') THEN kind ELSE 'rulebook' END,
    left(btrim(coalesce(title, '')), 120), CASE WHEN source ~ '^https://[^\s]{4,}$' THEN left(source, 500) END, me)
  RETURNING id INTO d;
  RETURN jsonb_build_object('ok', true, 'id', d);
END $$;

COMMIT;
