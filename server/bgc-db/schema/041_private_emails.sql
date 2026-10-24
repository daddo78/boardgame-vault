-- Emails stay with the owner. at.player_record (002) and at.member_person (009) put each person's Google email in their card
-- (field fldnwPL9Z33JcXoj2), and bgc.shelf_view sent those cards to whoever was looking: a friend's shelf, Nathan's view,
-- the people list. The site strips the field before showing it, but the server shouldn't send it in the first place.
-- Only the owner's Players screen needs emails, and that screen reads at.request (not shelf_view), so here shelf_view drops
-- the field from every card unless the asker is the owner (at.admin_id()). Nothing else in the cards changes.
-- bgc.friend_shelf (007) sends games only and bgc.profile_page (015) sends a profile without the email: no change needed.
-- Nathan's "which of my friends would love X" (gen.js "THEIR FRIENDS") picked friends' cards by the email being set, so each
-- card gets a plain "is a member" flag instead (field fldMbrLinked00001, true or absent): the one thing that filter needs.
-- Apply once: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 041_private_emails.sql
BEGIN;

-- The same cards as 002 / 009 plus the member flag (a player linked to a member; every member card)
CREATE OR REPLACE FUNCTION at.player_record(p players) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
  SELECT jsonb_build_object('id', p.legacy_id, 'createdTime', at.iso(p.created_at), 'fields', jsonb_strip_nulls(jsonb_build_object(
    'fldWVws64FVcdtuSJ', p.name, 'fldbPxy87tXFVHtm1', nullif(array_to_string(p.aliases, ', '), ''), 'fldCTgjMOoTTokadR', p.active,
    'fldnwPL9Z33JcXoj2', m.google_email::text, 'fldDfHIAzk1AyaJEd', coalesce(nullif(p.bgg_username, ''), m.bgg_username),
    'fldMbrLinked00001', CASE WHEN m.id IS NOT NULL THEN true END,
    'fldobSISLYhxr2nb5', m.complexity, 'fldslaw9Fv5cxiICf', m.conflict, 'fldzLybJ5l8ALWyPz', m.luck,
    'fldVkKcUgFxkxTNfi', m.table_talk, 'fldk6X4H1FHJ7Uugm', m.theme,
    'fld7R2WFALqZ2gkR7', nullif(m.likes, ''), 'fld6ynTKz3kfM6QHx', nullif(m.dislikes, ''), 'fldZvY4FJ2QQDCyyh', m.age,
    'fldcgwd6wvrgnTSdW', nullif(m.about, ''), 'fldGI1Kr6p107QdZp', at.player_history(p.id)::text,
    'fldyIFTgzcvEqKaGK', at.iso(greatest(p.updated_at, coalesce(m.updated_at, p.updated_at))))))
  FROM (SELECT 1) one LEFT JOIN members m ON m.id = p.linked_member_id $$;

CREATE OR REPLACE FUNCTION at.member_person(m members) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
  SELECT jsonb_build_object('id', at.member_key(m.id), 'createdTime', at.iso(m.created_at), 'fields', jsonb_strip_nulls(jsonb_build_object(
    'fldWVws64FVcdtuSJ', m.display_name, 'fldCTgjMOoTTokadR', false,
    'fldnwPL9Z33JcXoj2', m.google_email::text, 'fldDfHIAzk1AyaJEd', nullif(m.bgg_username, ''),
    'fldMbrLinked00001', true,
    'fldobSISLYhxr2nb5', m.complexity, 'fldslaw9Fv5cxiICf', m.conflict, 'fldzLybJ5l8ALWyPz', m.luck,
    'fldVkKcUgFxkxTNfi', m.table_talk, 'fldk6X4H1FHJ7Uugm', m.theme,
    'fld7R2WFALqZ2gkR7', nullif(m.likes, ''), 'fld6ynTKz3kfM6QHx', nullif(m.dislikes, ''), 'fldZvY4FJ2QQDCyyh', m.age,
    'fldcgwd6wvrgnTSdW', nullif(m.about, ''),
    -- Their plays and wins from their own log (keyed by BGG id, so they line up with any shelf)
    'fldGI1Kr6p107QdZp', coalesce((SELECT at.player_history(p.id) FROM players p WHERE p.owner_id = m.id AND p.linked_member_id = m.id LIMIT 1), '{}'::jsonb)::text,
    'fldyIFTgzcvEqKaGK', at.iso(m.updated_at)))) $$;

-- The same cards without the email field, in the same order
CREATE OR REPLACE FUNCTION at.strip_emails(people jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce((SELECT jsonb_agg(e.x #- '{fields,fldnwPL9Z33JcXoj2}' ORDER BY e.i)
                   FROM jsonb_array_elements(coalesce(people, '[]'::jsonb)) WITH ORDINALITY AS e(x, i)), '[]'::jsonb) $$;

-- Same signature as 039; only the people list is filtered before it goes out
CREATE OR REPLACE FUNCTION bgc.shelf_view(email text, shelf text, main_asker text, people_only boolean DEFAULT false, with_games boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE mid bigint := bgc.member_id(email); oid bigint; fid bigint; asker text; owner_name text; kind text; asker_name text; owner_key text; people jsonb;
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
  people := coalesce((SELECT jsonb_agg(CASE WHEN people_only THEN at.player_brief(p) ELSE at.player_record(p) END ORDER BY p.name) FROM players p WHERE p.owner_id = oid), '[]')
      -- You, your friends and Nathan the curator, when not already players on this shelf
      || coalesce((SELECT jsonb_agg(CASE WHEN people_only THEN at.member_brief(m) ELSE at.member_person(m) END ORDER BY m.display_name) FROM members m
           WHERE mid IS NOT NULL AND (m.id = mid OR bgc.are_friends(mid, m.id) OR m.id = bgc.curator_id())
             AND NOT EXISTS (SELECT 1 FROM players p WHERE p.owner_id = oid AND p.linked_member_id = m.id)), '[]');
  -- Emails are for the owner's Players screen only; everyone else (members, visitors) gets the cards without them
  IF mid IS DISTINCT FROM at.admin_id() THEN people := at.strip_emails(people); END IF;
  RETURN jsonb_build_object(
    'shelf', kind, 'ownerName', owner_name, 'ownerId', oid, 'ownerKey', owner_key,
    'askerKey', asker, 'askerPerson', coalesce(asker, CASE WHEN mid IS NOT NULL THEN at.member_key(mid) END), 'askerName', asker_name,
    'games', CASE WHEN people_only OR NOT with_games THEN '[]'::jsonb ELSE
      coalesce((SELECT jsonb_agg(CASE WHEN kind = 'friend' THEN jsonb_set(at.game_record(s), '{fields,fldskzh1rq9uchgYI}', 'false'::jsonb) ELSE at.game_record(s) END
                ORDER BY s.num NULLS LAST, s.legacy_id) FROM shelves s WHERE s.member_id = oid), '[]') END,
    'players', people,
    'ratings', CASE WHEN people_only THEN '[]'::jsonb ELSE coalesce((SELECT jsonb_agg(x) FROM at.rating_records_for(oid) x), '[]') END);
END $function$;

COMMIT;
