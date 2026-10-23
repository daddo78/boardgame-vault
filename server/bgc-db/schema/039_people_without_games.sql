-- The people on a shelf without its games: /vault/people (the stars and who plays) built the whole shelf, games included,
-- then threw the games away. shelf_view gets one more optional setting, with_games (default true), so every existing
-- call is unchanged and /people asks for none: ~70 ms less on Dan's shelf, ~190 ms on an 844-game one.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 039_people_without_games.sql  (safe to re-run)
BEGIN;

-- A new optional argument is a new function in Postgres: replace the 4-argument one in the same transaction
DROP FUNCTION IF EXISTS bgc.shelf_view(text, text, text, boolean);
CREATE OR REPLACE FUNCTION bgc.shelf_view(email text, shelf text, main_asker text, people_only boolean DEFAULT false, with_games boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE mid bigint := bgc.member_id(email); oid bigint; fid bigint; asker text; owner_name text; kind text; asker_name text; owner_key text;
BEGIN
  fid := CASE WHEN shelf ~ '^friend:\d+$' THEN substr(shelf, 8)::bigint END;
  IF fid IS NOT NULL AND mid IS NOT NULL AND bgc.are_friends(mid, fid) THEN oid := fid; kind := 'friend';
  ELSIF mid IS NOT NULL AND mid IS DISTINCT FROM at.admin_id() THEN oid := mid; kind := 'mine';
  ELSE oid := at.admin_id(); kind := 'main'; END IF;
  IF kind = 'main' THEN asker := main_asker;
  ELSE SELECT legacy_id INTO asker FROM players WHERE owner_id = oid AND linked_member_id = mid LIMIT 1; END IF;
  SELECT split_part(display_name, ' ', 1) INTO owner_name FROM members WHERE id = oid;
  SELECT display_name INTO asker_name FROM members WHERE id = mid;
  -- The owner's own card on their shelf: their stars are the ones on the game cards
  SELECT legacy_id INTO owner_key FROM players WHERE owner_id = oid AND linked_member_id = oid LIMIT 1;
  RETURN jsonb_build_object(
    'shelf', kind, 'ownerName', owner_name, 'ownerId', oid, 'ownerKey', owner_key,
    'askerKey', asker, 'askerPerson', coalesce(asker, CASE WHEN mid IS NOT NULL THEN at.member_key(mid) END), 'askerName', asker_name,
    'games', CASE WHEN people_only OR NOT with_games THEN '[]'::jsonb ELSE
      coalesce((SELECT jsonb_agg(CASE WHEN kind = 'friend' THEN jsonb_set(at.game_record(s), '{fields,fldskzh1rq9uchgYI}', 'false'::jsonb) ELSE at.game_record(s) END
                ORDER BY s.num NULLS LAST, s.legacy_id) FROM shelves s WHERE s.member_id = oid), '[]') END,
    'players', coalesce((SELECT jsonb_agg(CASE WHEN people_only THEN at.player_brief(p) ELSE at.player_record(p) END ORDER BY p.name) FROM players p WHERE p.owner_id = oid), '[]')
      -- You, your friends and Nathan the curator, when not already players on this shelf
      || coalesce((SELECT jsonb_agg(CASE WHEN people_only THEN at.member_brief(m) ELSE at.member_person(m) END ORDER BY m.display_name) FROM members m
           WHERE mid IS NOT NULL AND (m.id = mid OR bgc.are_friends(mid, m.id) OR m.id = bgc.curator_id())
             AND NOT EXISTS (SELECT 1 FROM players p WHERE p.owner_id = oid AND p.linked_member_id = m.id)), '[]'),
    'ratings', CASE WHEN people_only THEN '[]'::jsonb ELSE coalesce((SELECT jsonb_agg(x) FROM at.rating_records_for(oid) x), '[]') END);
END $function$;

COMMIT;
