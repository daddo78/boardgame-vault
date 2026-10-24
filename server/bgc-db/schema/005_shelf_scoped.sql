-- Phase 2b: Nathan, the people list and ratings work on whichever shelf is being viewed (Dan's or a friend's own).
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 005_shelf_scoped.sql  (apply once via apply.sh)
BEGIN;

-- Ratings as records for one shelf owner's view: BGC stars from members linked to that owner's players, BGG ratings by username
CREATE OR REPLACE FUNCTION at.rating_records_for(oid bigint) RETURNS SETOF jsonb LANGUAGE sql VOLATILE AS $$
  SELECT jsonb_build_object('id', k, 'createdTime', at.iso(t), 'fields', jsonb_build_object(
      'fldSVVMwQygNrpyBm', k, 'fldB2cw5ie4ypHPGl', pkey, 'fldhrJoBfiLAg1E8q', skey, 'fldSM283jOPAOs2YP', stars,
      'fldaPLq2gL3UP6zon', src, 'fldqI4c09b3iHt3um', at.iso(t)))
  FROM (
    SELECT pl.legacy_id || '|' || s.legacy_id || '|site' AS k, pl.legacy_id AS pkey, s.legacy_id AS skey, r.stars, 'site' AS src, r.updated_at AS t
    FROM ratings r
    JOIN players pl ON pl.owner_id = oid AND pl.linked_member_id = r.member_id
    JOIN shelves s ON s.member_id = oid AND s.game_id = r.game_id
    UNION ALL
    SELECT pl.legacy_id || '|' || s.legacy_id || '|bgg', pl.legacy_id, s.legacy_id, round(b.rating) / 2, 'bgg', b.fetched_at
    FROM bgg_ratings b
    JOIN players pl ON pl.owner_id = oid
    LEFT JOIN members m ON m.id = pl.linked_member_id
    JOIN games g ON g.bgg_id = b.bgg_id
    JOIN shelves s ON s.member_id = oid AND s.game_id = g.id
    WHERE lower(coalesce(nullif(pl.bgg_username, ''), m.bgg_username)) = lower(b.bgg_username::text)
  ) x $$;
CREATE OR REPLACE FUNCTION at.rating_records() RETURNS SETOF jsonb LANGUAGE sql VOLATILE AS
$$ SELECT at.rating_records_for(at.admin_id()) $$;

-- A rating belongs to a member and a catalog game, whichever shelf it was given from: shelf keys are unique across members
CREATE OR REPLACE FUNCTION at.upsert_rating(f jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE src text := at.txt(f -> 'fldaPLq2gL3UP6zon'); pkey text := at.txt(f -> 'fldB2cw5ie4ypHPGl'); skey text := at.txt(f -> 'fldhrJoBfiLAg1E8q');
  stars numeric := at.num(f -> 'fldSM283jOPAOs2YP'); mid bigint; gid bigint; uname text; bgg integer;
BEGIN
  SELECT pl.linked_member_id, coalesce(nullif(pl.bgg_username, ''), m.bgg_username) INTO mid, uname
    FROM players pl LEFT JOIN members m ON m.id = pl.linked_member_id WHERE pl.legacy_id = pkey;
  SELECT s.game_id, g.bgg_id INTO gid, bgg FROM shelves s JOIN games g ON g.id = s.game_id WHERE s.legacy_id = skey;
  IF gid IS NULL THEN RETURN NULL; END IF;
  IF src = 'site' AND mid IS NOT NULL THEN
    INSERT INTO ratings (member_id, game_id, stars) VALUES (mid, gid, stars)
      ON CONFLICT (member_id, game_id) DO UPDATE SET stars = EXCLUDED.stars, updated_at = now();
  ELSIF src = 'bgg' AND uname IS NOT NULL AND bgg IS NOT NULL THEN
    INSERT INTO bgg_ratings (bgg_username, bgg_id, rating) VALUES (uname, bgg, least(10, greatest(1, stars * 2)))
      ON CONFLICT (bgg_username, bgg_id) DO UPDATE SET rating = EXCLUDED.rating, fetched_at = now();
  ELSE
    RETURN NULL; -- other sources (BG Stats play ratings) are not someone's own rating
  END IF;
  RETURN jsonb_build_object('id', pkey || '|' || skey || '|' || src, 'createdTime', at.iso(now()), 'fields', jsonb_build_object(
    'fldSVVMwQygNrpyBm', pkey || '|' || skey || '|' || src, 'fldB2cw5ie4ypHPGl', pkey, 'fldhrJoBfiLAg1E8q', skey,
    'fldSM283jOPAOs2YP', stars, 'fldaPLq2gL3UP6zon', src, 'fldqI4c09b3iHt3um', at.iso(now())));
END $$;

CREATE OR REPLACE FUNCTION at.delete_rating(rkey text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE parts text[] := string_to_array(rkey, '|');
BEGIN
  IF parts[3] = 'site' THEN
    DELETE FROM ratings r USING players pl, shelves s
    WHERE pl.legacy_id = parts[1] AND r.member_id = pl.linked_member_id AND s.legacy_id = parts[2] AND r.game_id = s.game_id;
  END IF;
END $$;

-- Finding one rating by its key works for any shelf (used by the Rate workflow before clearing a rating)
CREATE OR REPLACE FUNCTION at.find_rating(rkey text) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', rkey, 'fields', jsonb_build_object('fldSVVMwQygNrpyBm', rkey, 'fldSM283jOPAOs2YP', r.stars, 'fldaPLq2gL3UP6zon', 'site'))), '[]')
  FROM ratings r JOIN players pl ON pl.legacy_id = split_part(rkey, '|', 1) AND r.member_id = pl.linked_member_id
  JOIN shelves s ON s.legacy_id = split_part(rkey, '|', 2) AND r.game_id = s.game_id
  WHERE split_part(rkey, '|', 3) = 'site' $$;

-- Everything Nathan (and the people list) needs for one shelf.
-- shelf: 'main' (Dan's collection) or 'mine' (the signed-in member's own shelf). The asker's key is their player card in that shelf's list.
CREATE OR REPLACE FUNCTION bgc.shelf_view(email text, shelf text, main_asker text) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE mid bigint := bgc.member_id(email); oid bigint; asker text; owner_name text;
BEGIN
  oid := CASE WHEN shelf = 'mine' AND mid IS NOT NULL THEN mid ELSE at.admin_id() END;
  IF oid = at.admin_id() THEN asker := main_asker;
  ELSE SELECT legacy_id INTO asker FROM players WHERE owner_id = oid AND linked_member_id = oid LIMIT 1; END IF;
  SELECT split_part(display_name, ' ', 1) INTO owner_name FROM members WHERE id = oid;
  RETURN jsonb_build_object(
    'shelf', CASE WHEN oid = at.admin_id() THEN 'main' ELSE 'mine' END,
    'ownerName', owner_name,
    'askerKey', asker,
    'games', coalesce((SELECT jsonb_agg(at.game_record(s) ORDER BY s.num NULLS LAST, s.legacy_id) FROM shelves s WHERE s.member_id = oid), '[]'),
    'players', coalesce((SELECT jsonb_agg(at.player_record(p) ORDER BY p.name) FROM players p WHERE p.owner_id = oid), '[]'),
    'ratings', coalesce((SELECT jsonb_agg(x) FROM at.rating_records_for(oid) x), '[]'));
END $$;

COMMIT;
