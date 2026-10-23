-- After Nathan reads a rules document, a small step names it from its first pages: what it is (the base game's rulebook,
-- an expansion's, an appendix…) and its own name ("The Norwegians", "The Edge Cases"). It only fills gaps: a name
-- someone typed is kept, and the type is corrected only when it was left on the default "Rulebook".
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 037_rule_docs_autoname.sql  (safe to re-run)
BEGIN;

-- What the naming step needs: whether there's anything to fill, the game, and the first two pages Nathan read
CREATE OR REPLACE FUNCTION bgc.rule_doc_naming(doc bigint) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('doc', d.id, 'game', g.title, 'kind', d.kind,
    'need', d.status = 'ready' AND (coalesce(d.title, '') = '' OR d.kind = 'rulebook'),
    'text', (SELECT string_agg(left(p.markdown, 1200), E'\n\n---\n\n' ORDER BY p.page) FROM rule_pages p WHERE p.doc_id = d.id AND p.page <= 2))
  FROM rule_docs d JOIN games g ON g.id = d.game_id WHERE d.id = doc $$;

-- Save what it found, only into the gaps
CREATE OR REPLACE FUNCTION bgc.rule_doc_autoname(doc bigint, k text, n text) RETURNS jsonb LANGUAGE sql AS $$
  UPDATE rule_docs SET
    kind = CASE WHEN kind = 'rulebook' AND k IN ('expansion', 'reference', 'appendix', 'faq', 'solo') THEN k ELSE kind END,
    title = CASE WHEN coalesce(title, '') = '' THEN left(btrim(coalesce(n, '')), 120) ELSE title END,
    updated_at = now()
  WHERE id = doc
  RETURNING jsonb_build_object('ok', true, 'kind', kind, 'title', title) $$;

COMMIT;
