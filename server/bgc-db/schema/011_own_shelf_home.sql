-- Every member's home is their own shelf. Dan's shelf is like anyone's: friends open it from Friends.
-- So Nathan and the @ list default to the asker's own shelf (Dan's own is the main collection).
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 011_own_shelf_home.sql  (apply once via apply.sh)
BEGIN;

CREATE OR REPLACE FUNCTION bgc.shelf_view(email text, shelf text, main_asker text) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE mid bigint := bgc.member_id(email); oid bigint; fid bigint; asker text; owner_name text; kind text; asker_name text;
BEGIN
  fid := CASE WHEN shelf ~ '^friend:\d+$' THEN substr(shelf, 8)::bigint END;
  IF fid IS NOT NULL AND mid IS NOT NULL AND bgc.are_friends(mid, fid) THEN oid := fid; kind := 'friend';
  ELSIF mid IS NOT NULL AND mid IS DISTINCT FROM at.admin_id() THEN oid := mid; kind := 'mine';  -- a member: always their own
  ELSE oid := at.admin_id(); kind := 'main'; END IF;                                              -- Dan: the main collection
  IF kind = 'main' THEN asker := main_asker;
  ELSE SELECT legacy_id INTO asker FROM players WHERE owner_id = oid AND linked_member_id = mid LIMIT 1; END IF;
  SELECT split_part(display_name, ' ', 1) INTO owner_name FROM members WHERE id = oid;
  SELECT display_name INTO asker_name FROM members WHERE id = mid;
  RETURN jsonb_build_object(
    'shelf', kind, 'ownerName', owner_name, 'ownerId', oid,
    'askerKey', asker, 'askerPerson', coalesce(asker, CASE WHEN mid IS NOT NULL THEN at.member_key(mid) END), 'askerName', asker_name,
    'games', coalesce((SELECT jsonb_agg(CASE WHEN kind = 'friend' THEN jsonb_set(at.game_record(s), '{fields,fldskzh1rq9uchgYI}', 'false'::jsonb) ELSE at.game_record(s) END
                       ORDER BY s.num NULLS LAST, s.legacy_id) FROM shelves s WHERE s.member_id = oid), '[]'),
    'players', coalesce((SELECT jsonb_agg(at.player_record(p) ORDER BY p.name) FROM players p WHERE p.owner_id = oid), '[]')
      || coalesce((SELECT jsonb_agg(at.member_person(m) ORDER BY m.display_name) FROM members m
           WHERE mid IS NOT NULL AND (m.id = mid OR bgc.are_friends(mid, m.id))
             AND NOT EXISTS (SELECT 1 FROM players p WHERE p.owner_id = oid AND p.linked_member_id = m.id)), '[]'),
    'ratings', coalesce((SELECT jsonb_agg(x) FROM at.rating_records_for(oid) x), '[]'));
END $$;

COMMIT;
