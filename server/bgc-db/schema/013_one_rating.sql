-- One set of stars: each person's rating of a game. "Desire to play" stars become ratings where there's no rating yet.
-- Also: the page learns whose rating the cards show (the shelf owner's), and Nathan Schmidt (the curator) is known on every shelf
-- so "what do you like to play?" can be answered in his own voice.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 013_one_rating.sql  (apply once via apply.sh)
BEGIN;

INSERT INTO ratings (member_id, game_id, stars)
SELECT s.member_id, s.game_id, s.want_to_play FROM shelves s
WHERE s.want_to_play > 0 AND NOT EXISTS (SELECT 1 FROM ratings r WHERE r.member_id = s.member_id AND r.game_id = s.game_id);

CREATE OR REPLACE FUNCTION bgc.curator_id() RETURNS bigint LANGUAGE sql STABLE AS
$$ SELECT id FROM members WHERE google_email = 'nathan.schmidt@curator.invalid' $$;

CREATE OR REPLACE FUNCTION bgc.shelf_view(email text, shelf text, main_asker text) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
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
    'games', coalesce((SELECT jsonb_agg(CASE WHEN kind = 'friend' THEN jsonb_set(at.game_record(s), '{fields,fldskzh1rq9uchgYI}', 'false'::jsonb) ELSE at.game_record(s) END
                       ORDER BY s.num NULLS LAST, s.legacy_id) FROM shelves s WHERE s.member_id = oid), '[]'),
    'players', coalesce((SELECT jsonb_agg(at.player_record(p) ORDER BY p.name) FROM players p WHERE p.owner_id = oid), '[]')
      -- You, your friends and Nathan the curator, when not already players on this shelf
      || coalesce((SELECT jsonb_agg(at.member_person(m) ORDER BY m.display_name) FROM members m
           WHERE mid IS NOT NULL AND (m.id = mid OR bgc.are_friends(mid, m.id) OR m.id = bgc.curator_id())
             AND NOT EXISTS (SELECT 1 FROM players p WHERE p.owner_id = oid AND p.linked_member_id = m.id)), '[]'),
    'ratings', coalesce((SELECT jsonb_agg(x) FROM at.rating_records_for(oid) x), '[]'));
END $$;

COMMIT;

-- Nathan the curator talking about himself: his own shelf at a glance (whoever is asking)
BEGIN;
CREATE OR REPLACE FUNCTION bgc.curator_card() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'games', (SELECT count(*) FROM shelves WHERE member_id = m.id),
    'plays', (SELECT coalesce(sum(play_count), 0) FROM shelves WHERE member_id = m.id),
    'unplayed', (SELECT count(*) FROM shelves WHERE member_id = m.id AND play_count = 0),
    'top', (SELECT jsonb_agg(t ORDER BY n DESC) FROM (SELECT g.title || ' (' || s.play_count || ' plays)' AS t, s.play_count AS n
             FROM shelves s JOIN games g ON g.id = s.game_id WHERE s.member_id = m.id AND s.play_count > 0 ORDER BY s.play_count DESC LIMIT 8) x),
    'loved', (SELECT jsonb_agg(t) FROM (SELECT g.title || ' (' || r.stars || ' stars)' AS t FROM ratings r JOIN games g ON g.id = r.game_id
             WHERE r.member_id = m.id AND r.stars >= 4.5 ORDER BY r.stars DESC, g.bgg_rank NULLS LAST LIMIT 10) x),
    'favorites', (SELECT jsonb_agg(g.title ORDER BY g.title) FROM shelves s JOIN games g ON g.id = s.game_id WHERE s.member_id = m.id AND s.favorite))
  FROM members m WHERE m.id = bgc.curator_id() $$;
COMMIT;
