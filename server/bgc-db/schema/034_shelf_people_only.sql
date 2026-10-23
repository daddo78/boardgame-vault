-- Nathan's first step (understanding the question) needs only who is on the shelf: names, aliases, who's active, who's asking.
-- shelf_view(..., people_only => true) gives just that, without the games, ratings and play histories (~10 ms instead of ~350),
-- so he can start while the full shelf loads. The 3-argument call (n8n) is unchanged.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 034_shelf_people_only.sql  (safe to re-run)
BEGIN;

-- A player or member with only the fields the roster needs (same ids and field keys as at.player_record / at.member_person)
CREATE OR REPLACE FUNCTION at.player_brief(p players) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('id', p.legacy_id, 'fields', jsonb_strip_nulls(jsonb_build_object(
    'fldWVws64FVcdtuSJ', p.name, 'fldbPxy87tXFVHtm1', nullif(array_to_string(p.aliases, ', '), ''), 'fldCTgjMOoTTokadR', p.active))) $$;
CREATE OR REPLACE FUNCTION at.member_brief(m members) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('id', at.member_key(m.id), 'fields', jsonb_strip_nulls(jsonb_build_object(
    'fldWVws64FVcdtuSJ', m.display_name, 'fldCTgjMOoTTokadR', false))) $$;

DROP FUNCTION IF EXISTS bgc.shelf_view(text, text, text);
CREATE OR REPLACE FUNCTION bgc.shelf_view(email text, shelf text, main_asker text, people_only boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
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
    'games', CASE WHEN people_only THEN '[]'::jsonb ELSE
      coalesce((SELECT jsonb_agg(CASE WHEN kind = 'friend' THEN jsonb_set(at.game_record(s), '{fields,fldskzh1rq9uchgYI}', 'false'::jsonb) ELSE at.game_record(s) END
                ORDER BY s.num NULLS LAST, s.legacy_id) FROM shelves s WHERE s.member_id = oid), '[]') END,
    'players', coalesce((SELECT jsonb_agg(CASE WHEN people_only THEN at.player_brief(p) ELSE at.player_record(p) END ORDER BY p.name) FROM players p WHERE p.owner_id = oid), '[]')
      -- You, your friends and Nathan the curator, when not already players on this shelf
      || coalesce((SELECT jsonb_agg(CASE WHEN people_only THEN at.member_brief(m) ELSE at.member_person(m) END ORDER BY m.display_name) FROM members m
           WHERE mid IS NOT NULL AND (m.id = mid OR bgc.are_friends(mid, m.id) OR m.id = bgc.curator_id())
             AND NOT EXISTS (SELECT 1 FROM players p WHERE p.owner_id = oid AND p.linked_member_id = m.id)), '[]'),
    'ratings', CASE WHEN people_only THEN '[]'::jsonb ELSE coalesce((SELECT jsonb_agg(x) FROM at.rating_records_for(oid) x), '[]') END);
END $$;

COMMIT;
