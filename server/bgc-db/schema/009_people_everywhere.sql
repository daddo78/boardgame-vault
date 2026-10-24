-- Nathan knows who's asking on any shelf, and knows your friends wherever you are (so @Matt works on your own shelf).
-- A member who isn't a player on the shelf being viewed comes along as a "person" card built from their own profile
-- and their own play log (id recMember + 8 digits, so it passes the same checks as a player id).
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 009_people_everywhere.sql  (apply once via apply.sh)
BEGIN;

CREATE OR REPLACE FUNCTION at.member_key(mid bigint) RETURNS text LANGUAGE sql IMMUTABLE AS
$$ SELECT 'recMember' || lpad(mid::text, 8, '0') $$;

CREATE OR REPLACE FUNCTION at.member_person(m members) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
  SELECT jsonb_build_object('id', at.member_key(m.id), 'createdTime', at.iso(m.created_at), 'fields', jsonb_strip_nulls(jsonb_build_object(
    'fldWVws64FVcdtuSJ', m.display_name, 'fldCTgjMOoTTokadR', false,
    'fldnwPL9Z33JcXoj2', m.google_email::text, 'fldDfHIAzk1AyaJEd', nullif(m.bgg_username, ''),
    'fldobSISLYhxr2nb5', m.complexity, 'fldslaw9Fv5cxiICf', m.conflict, 'fldzLybJ5l8ALWyPz', m.luck,
    'fldVkKcUgFxkxTNfi', m.table_talk, 'fldk6X4H1FHJ7Uugm', m.theme,
    'fld7R2WFALqZ2gkR7', nullif(m.likes, ''), 'fld6ynTKz3kfM6QHx', nullif(m.dislikes, ''), 'fldZvY4FJ2QQDCyyh', m.age,
    'fldcgwd6wvrgnTSdW', nullif(m.about, ''),
    -- Their plays and wins from their own log (keyed by BGG id, so they line up with any shelf)
    'fldGI1Kr6p107QdZp', coalesce((SELECT at.player_history(p.id) FROM players p WHERE p.owner_id = m.id AND p.linked_member_id = m.id LIMIT 1), '{}'::jsonb)::text,
    'fldyIFTgzcvEqKaGK', at.iso(m.updated_at)))) $$;

CREATE OR REPLACE FUNCTION bgc.shelf_view(email text, shelf text, main_asker text) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE mid bigint := bgc.member_id(email); oid bigint; fid bigint; asker text; owner_name text; kind text; asker_name text;
BEGIN
  fid := CASE WHEN shelf ~ '^friend:\d+$' THEN substr(shelf, 8)::bigint END;
  IF fid IS NOT NULL AND mid IS NOT NULL AND bgc.are_friends(mid, fid) THEN oid := fid; kind := 'friend';
  ELSIF shelf = 'mine' AND mid IS NOT NULL THEN oid := mid; kind := 'mine';
  ELSE oid := at.admin_id(); kind := 'main'; END IF;
  IF kind = 'main' THEN asker := main_asker;
  ELSE SELECT legacy_id INTO asker FROM players WHERE owner_id = oid AND linked_member_id = mid LIMIT 1; END IF;
  SELECT split_part(display_name, ' ', 1) INTO owner_name FROM members WHERE id = oid;
  SELECT display_name INTO asker_name FROM members WHERE id = mid;
  RETURN jsonb_build_object(
    'shelf', kind, 'ownerName', owner_name, 'ownerId', oid,
    -- askerKey: their player card on this shelf (for ratings); askerPerson: who's typing, always (for Nathan)
    'askerKey', asker, 'askerPerson', coalesce(asker, CASE WHEN mid IS NOT NULL THEN at.member_key(mid) END), 'askerName', asker_name,
    'games', coalesce((SELECT jsonb_agg(CASE WHEN kind = 'friend' THEN jsonb_set(at.game_record(s), '{fields,fldskzh1rq9uchgYI}', 'false'::jsonb) ELSE at.game_record(s) END
                       ORDER BY s.num NULLS LAST, s.legacy_id) FROM shelves s WHERE s.member_id = oid), '[]'),
    'players', coalesce((SELECT jsonb_agg(at.player_record(p) ORDER BY p.name) FROM players p WHERE p.owner_id = oid), '[]')
      -- You and your friends, when you're not already players on this shelf
      || coalesce((SELECT jsonb_agg(at.member_person(m) ORDER BY m.display_name) FROM members m
           WHERE mid IS NOT NULL AND (m.id = mid OR bgc.are_friends(mid, m.id))
             AND NOT EXISTS (SELECT 1 FROM players p WHERE p.owner_id = oid AND p.linked_member_id = m.id)), '[]'),
    'ratings', coalesce((SELECT jsonb_agg(x) FROM at.rating_records_for(oid) x), '[]'));
END $$;

COMMIT;
