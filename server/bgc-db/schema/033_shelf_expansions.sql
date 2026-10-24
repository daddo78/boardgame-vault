-- A member can change the expansions they own for a game on their shelf (the × next to each one in the game's details).
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 033_shelf_expansions.sql  (apply once via apply.sh)
BEGIN;

CREATE OR REPLACE FUNCTION bgc.shelf_update(email text, skey text, f jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE s shelves;
BEGIN
  UPDATE shelves SET
    favorite     = CASE WHEN f ? 'favorite' THEN coalesce((f ->> 'favorite')::boolean, false) ELSE favorite END,
    want_to_play = CASE WHEN f ? 'desireToPlay' THEN least(5, greatest(0, coalesce((f ->> 'desireToPlay')::int, 0))) ELSE want_to_play END,
    thinning     = CASE WHEN f ? 'thinningCandidate' THEN coalesce((f ->> 'thinningCandidate')::boolean, false) ELSE thinning END,
    expansions   = CASE WHEN jsonb_typeof(f -> 'expansions') = 'array'
                     THEN ARRAY(SELECT left(btrim(e), 200) FROM jsonb_array_elements_text(f -> 'expansions') e WHERE btrim(e) <> '' LIMIT 100)
                     ELSE expansions END,
    updated_at   = now()
  WHERE member_id = bgc.member_id(email) AND legacy_id = skey RETURNING * INTO s;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'status', 404, 'message', 'That game isn''t on your shelf'); END IF;
  RETURN jsonb_build_object('ok', true, 'id', skey);
END $$;

COMMIT;
