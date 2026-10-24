-- Phase 2b: a member adds a game to their own shelf (by BGG id, or a title for a game not on BGG).
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 006_shelf_add.sql  (apply once via apply.sh)
BEGIN;

-- t: one parsed BGG thing (same shape the import uses: id, type, name, year, ..., baseIds, coverCard, coverLarge), or null for a title-only game.
-- An expansion of a game already on the shelf is added to that game's expansions; anything else becomes a shelf game.
CREATE OR REPLACE FUNCTION bgc.shelf_add(email text, t jsonb, title text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  mid bigint := bgc.member_id(email); bgg integer; gid bigint; nm text; base record; exp_name text; skey text; next_num int;
BEGIN
  IF mid IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 401, 'message', 'Sign in to do that'); END IF;
  IF t IS NOT NULL AND jsonb_typeof(t) = 'object' THEN
    bgg := (t ->> 'id')::int;
    nm := coalesce(nullif(t ->> 'name', ''), nullif(title, ''), 'BGG #' || bgg);
    -- An expansion of something they own: list it under that game
    IF t ->> 'type' = 'boardgameexpansion' THEN
      SELECT s.game_id, g.title INTO base FROM shelves s JOIN games g ON g.id = s.game_id
      WHERE s.member_id = mid AND g.bgg_id IN (SELECT (b)::int FROM jsonb_array_elements_text(coalesce(t -> 'baseIds', '[]')) b)
      ORDER BY s.num LIMIT 1;
      IF FOUND THEN
        exp_name := nm;
        IF lower(left(exp_name, length(base.title))) = lower(base.title) AND length(exp_name) > length(base.title) + 2 THEN
          exp_name := btrim(substr(exp_name, length(base.title) + 1), ' :–—-');
        END IF;
        IF EXISTS (SELECT 1 FROM shelves WHERE member_id = mid AND game_id = base.game_id AND lower(exp_name) = ANY (SELECT lower(e) FROM unnest(expansions) e)) THEN
          RETURN jsonb_build_object('ok', false, 'status', 409, 'message', '"' || exp_name || '" is already listed as an expansion of ' || base.title);
        END IF;
        UPDATE shelves SET expansions = expansions || exp_name, updated_at = now() WHERE member_id = mid AND game_id = base.game_id;
        RETURN jsonb_build_object('ok', true, 'expansions', jsonb_build_array(jsonb_build_object('title', exp_name, 'base', base.title)));
      END IF;
    END IF;
    INSERT INTO games (bgg_id, title) VALUES (bgg, nm) ON CONFLICT (bgg_id) DO NOTHING;
    SELECT id INTO gid FROM games WHERE bgg_id = bgg;
    IF EXISTS (SELECT 1 FROM shelves WHERE member_id = mid AND game_id = gid) THEN
      RETURN jsonb_build_object('ok', false, 'status', 409, 'message', '"' || nm || '" is already on your shelf');
    END IF;
    PERFORM bgc.enrich_games(email, jsonb_build_array(t), '[]'::jsonb); -- fills in anything the catalog doesn't have yet
  ELSE
    nm := nullif(btrim(coalesce(title, '')), '');
    IF nm IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 400, 'message', 'Send a BGG game or a title'); END IF;
    IF EXISTS (SELECT 1 FROM shelves s JOIN games g ON g.id = s.game_id WHERE s.member_id = mid AND lower(g.title) = lower(nm)) THEN
      RETURN jsonb_build_object('ok', false, 'status', 409, 'message', '"' || nm || '" is already on your shelf');
    END IF;
    INSERT INTO games (title) VALUES (nm) RETURNING id INTO gid;
  END IF;
  SELECT coalesce(max(num), 0) + 1 INTO next_num FROM shelves WHERE member_id = mid;
  skey := at.new_key();
  INSERT INTO shelves (member_id, game_id, num, legacy_id) VALUES (mid, gid, next_num, skey);
  -- Plays they already logged for this game count right away
  UPDATE shelves s SET play_count = coalesce(x.plays, 0), last_played = x.last
  FROM (SELECT sum(p.quantity)::int AS plays, max(p.played_on) AS last FROM plays p JOIN games g ON g.id = gid
        WHERE p.owner_id = mid AND p.bgg_id = g.bgg_id) x
  WHERE s.member_id = mid AND s.legacy_id = skey;
  RETURN jsonb_build_object('ok', true, 'added', jsonb_build_array(jsonb_build_object('id', skey, 'title', (SELECT g2.title FROM games g2 WHERE g2.id = gid))));
END $$;

COMMIT;
